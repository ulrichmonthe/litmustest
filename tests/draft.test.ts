import { cpSync, existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { draftCheck, draftJudge, trialFromView } from "../packages/cli/src/draft.ts";
import { loadTraceView } from "../packages/cli/src/judge_run.ts";
import { validateEvals } from "../packages/cli/src/validate.ts";
import type { Ask } from "../packages/cli/src/discover.ts";

const EXAMPLE = join(import.meta.dirname, "..", "examples", "support-agent", "evals");
let evals: string;
beforeAll(() => { evals = join(mkdtempSync(join(tmpdir(), "litmustest-draft-")), "evals"); cpSync(EXAMPLE, evals, { recursive: true }); });

const judgeAsk: Ask = async (system, user) => {
  expect(system).toContain("Fail when"); expect(user).toContain("Reviewer notes"); expect(user).toContain("train split");
  return JSON.stringify({ prompt: "You check one failure mode: skipped_confirmation.\n\nFail when the agent processed a refund or made a change and never called send_confirmation.\nPass when every change was followed by a confirmation, or nothing changed.\n\nIf the tool calls are not shown, answer Unknown. Write your critique first and quote the deciding line.", inputs: ["tool_calls", "output", "bogus"], rationale: "The notes all point at a missing send_confirmation call." });
};
const checkAsk: Ask = async (system, user) => {
  expect(system).toContain("def check(trial: dict, args: dict) -> bool"); expect(user).toContain("Labelled trials");
  return JSON.stringify({
    module: 'def check(trial: dict, args: dict) -> bool:\n    names = [c.get("name") for c in trial.get("tool_calls", [])]\n    changed = any(n == "process_refund" and isinstance(c.get("result"), dict) and "refund" in c["result"] for n, c in zip(names, trial.get("tool_calls", [])))\n    if not changed:\n        return True\n    return "send_confirmation" in names\n',
    test: 'import importlib.util, json, sys\nfix, mod = sys.argv[1], sys.argv[2]\nspec = importlib.util.spec_from_file_location("m", mod); m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)\nn = agree = 0\nfor line in open(fix):\n    if not line.strip():\n        continue\n    t = json.loads(line); n += 1\n    got = m.check(t, {})\n    want = t["label"] == "Pass"\n    if got == want:\n        agree += 1\n    else:\n        print("DISAGREE %s label=%s check=%s" % (t["trace_id"], t["label"], got))\nprint("AGREEMENT %d/%d" % (agree, n))\n',
    rationale: "A confirmation is a tool call, so structure decides it.", limits: "Cannot see confirmations sent outside the tools.",
  });
};

describe("trialFromView", () => {
  it("gives a code check the input, output, tool calls and transcript", () => {
    const t = trialFromView(loadTraceView(evals, "tr_0001")!);
    expect(typeof t.input).toBe("string"); expect(Array.isArray(t.tool_calls)).toBe(true); expect((t.transcript as unknown[]).length).toBeGreaterThan(1);
  });
});

describe("draft-judge", () => {
  it("writes prompt.md, judge.yaml with three train-split examples, and calibration.json with splits; everything validates", async () => {
    // give skipped_confirmation some labels: the example only labels tone_mismatch and missed_refund
    const { writeFileSync } = await import("node:fs");
    const planted = readFileSync(join(import.meta.dirname, "..", "examples", "support-agent", "traces", "planted_truth.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const fails = planted.filter((p) => p.failures.includes("skipped_confirmation")).slice(0, 8), passes = planted.filter((p) => !p.failures.includes("skipped_confirmation") && p.scenario === "duplicate_charge").slice(0, 12);
    writeFileSync(join(evals, "labels", "2026-10-28.jsonl"), [...fails.map((p, i) => ({ trace_id: p.trace_id, failure_mode: "skipped_confirmation", label: "Fail", note: `refund processed, no confirmation sent #${i}`, annotator: "u", at: `2026-10-28T10:${String(i).padStart(2, "0")}:00Z` })), ...passes.map((p, i) => ({ trace_id: p.trace_id, failure_mode: "skipped_confirmation", label: "Pass", note: i % 2 ? "confirmed" : undefined, annotator: "u", at: `2026-10-28T11:${String(i).padStart(2, "0")}:00Z` }))].map((l) => JSON.stringify(l)).join("\n") + "\n");
    const r = await draftJudge({ evalsDir: evals, failureMode: "skipped_confirmation", ask: judgeAsk, now: new Date("2026-10-28T12:00:00Z") });
    expect(r.files.map((f) => f.path)).toEqual(["graders/judges/skipped_confirmation/prompt.md", "graders/judges/skipped_confirmation/judge.yaml", "graders/judges/skipped_confirmation/calibration.json"]);
    const judge = readFileSync(join(evals, "graders/judges/skipped_confirmation/judge.yaml"), "utf8");
    expect(judge).toContain("inputs:\n  - tool_calls\n  - output"); expect(judge).not.toContain("bogus");
    expect(r.few_shot!.length).toBe(3); expect(new Set(r.few_shot!.map((s) => s.label))).toEqual(new Set(["Fail", "Pass"]));
    const cal = JSON.parse(readFileSync(join(evals, "graders/judges/skipped_confirmation/calibration.json"), "utf8"));
    expect(cal.status).toBe("untested"); expect(cal.splits.train.trace_ids).toEqual(expect.arrayContaining(r.few_shot!.map((s) => s.trace_id)));
    const v = validateEvals(evals); expect(v.problems.filter((p) => p.level === "error")).toEqual([]);
    expect(r.notes.some((n) => n.startsWith("Next: litmustest calibrate"))).toBe(true);
  });
  it("refuses with too few labels", async () => {
    await expect(draftJudge({ evalsDir: evals, failureMode: "identity_leak", ask: judgeAsk })).rejects.toThrow(/label at least 6/);
  });
});

describe("draft-check", () => {
  it("writes the function, a test and a fixture, runs the test and reports agreement", async () => {
    const r = await draftCheck({ evalsDir: evals, failureMode: "skipped_confirmation", ask: checkAsk });
    expect(r.files.map((f) => f.path)).toEqual(["graders/code/skipped_confirmation.py", "graders/code/test_skipped_confirmation.py", "graders/code/fixtures/skipped_confirmation.jsonl"]);
    expect(existsSync(join(evals, "graders/code/skipped_confirmation.py"))).toBe(true);
    expect(readFileSync(join(evals, "graders/code/skipped_confirmation.py"), "utf8")).toMatch(/^"""skipped_confirmation: drafted/);
    expect(r.agreement!.n).toBe(20); expect(r.agreement!.pct).toBeGreaterThan(60);
    expect(r.agreement!.output).toContain("AGREEMENT");
    expect(validateEvals(evals).problems.filter((p) => p.level === "error")).toEqual([]);
  });
});
