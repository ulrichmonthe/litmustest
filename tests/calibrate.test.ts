import { cpSync, mkdtempSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { calibrate, labelsFor, makeSplits } from "../packages/cli/src/calibrate.ts";
import { buildMessages, loadJudge, loadTraceView, parseVerdict, renderInputs, type JudgeAsk } from "../packages/cli/src/judge_run.ts";
import { validateEvals } from "../packages/cli/src/validate.ts";

const EXAMPLE = join(import.meta.dirname, "..", "examples", "support-agent", "evals");
const PLANTED = join(import.meta.dirname, "..", "examples", "support-agent", "traces", "planted_truth.jsonl");
let evals: string; let planted: Map<string, string[]>;

/** A fake judge that reads the planted truth: right 95% of the time, deterministic per trace. */
const oracle = (mode: string, flip = 0): JudgeAsk => async (_system, user) => {
  const id = /Trace to judge · (tr_\d+)/.exec(user)?.[1] ?? "";
  const truth = planted.get(id)?.includes(mode) ? "Fail" : "Pass";
  const wrong = parseInt(id.slice(3), 10) % 10 === flip;
  const result = wrong ? (truth === "Fail" ? "Pass" : "Fail") : truth;
  return JSON.stringify({ critique: `oracle says ${result} for ${id}`, result });
};

beforeAll(() => {
  evals = join(mkdtempSync(join(tmpdir(), "litmustest-cal-")), "evals");
  cpSync(EXAMPLE, evals, { recursive: true });
  planted = new Map(readFileSync(PLANTED, "utf8").split("\n").filter(Boolean).map((l) => { const o = JSON.parse(l); return [o.trace_id, o.failures]; }));
});

describe("labels and splits", () => {
  it("takes the latest label per trace and ignores Skip", () => {
    const l = labelsFor(evals, "tone_mismatch");
    expect(l.size).toBe(50);
    expect([...l.values()].every((x) => x.label === "Pass" || x.label === "Fail")).toBe(true);
  });
  it("splits 15/45/40, stratified, deterministic, and locks the test set", () => {
    const l = labelsFor(evals, "tone_mismatch");
    const s = makeSplits("tone_mismatch", l);
    expect(s.train.length + s.dev.length + s.test.length).toBe(50);
    expect(s.test.length).toBeGreaterThanOrEqual(18); expect(s.train.length).toBeGreaterThanOrEqual(6);
    expect(makeSplits("tone_mismatch", l)).toEqual(s);
    const fails = (ids: string[]) => ids.filter((id) => l.get(id)!.label === "Fail").length;
    expect(Math.abs(fails(s.test) / s.test.length - 0.5)).toBeLessThan(0.15);
    // a new label joins train or dev, never test
    const more = new Map(l); more.set("tr_9999", { label: "Fail", note: "", at: "2026-10-28T00:00:00Z" });
    const s2 = makeSplits("tone_mismatch", more, s);
    expect(s2.test).toEqual(s.test); expect([...s2.train, ...s2.dev]).toContain("tr_9999");
  });
});

describe("judge prompt assembly", () => {
  it("renders only the inputs the judge asks for, with few-shot from the judge file", () => {
    const j = loadJudge(evals, "tone_mismatch");
    const v = loadTraceView(evals, "tr_0012")!;
    const m = buildMessages(j, evals, v, labelsFor(evals, "tone_mismatch"));
    expect(m.system).toContain("tone_mismatch"); expect(m.system).toContain('"result"');
    expect(m.user).toContain("Trace to judge · tr_0012"); expect(m.user).toContain("### Example");
    expect(renderInputs(v, ["output"])).toContain("Agent's final reply"); expect(renderInputs(v, ["output"])).not.toContain("Tool calls");
    expect(parseVerdict('{"critique":"x","result":"fail"}').result).toBe("Fail");
    expect(parseVerdict("garbage").result).toBe("Unknown");
  });
});

describe("calibrate", () => {
  it("runs dev, writes a valid calibration.json with intervals and disagreements; a dev run does not revoke trust", async () => {
    const r = await calibrate({ evalsDir: evals, judge: "tone_mismatch", split: "dev", ask: oracle("tone_mismatch"), now: new Date("2026-10-28T10:00:00Z") });
    expect(r.ran!.tpr).toBeGreaterThan(70); expect(r.ran!.tnr).toBeGreaterThan(70);
    expect(r.ran!.tpr_ci.low).toBeLessThanOrEqual(r.ran!.tpr);
    expect(r.status).toBe("trusted"); // the seeded test run is for this prompt and model
    const cal = JSON.parse(readFileSync(r.path, "utf8"));
    expect(cal.dev.runs.length).toBe(2); // the seeded run plus this one
    expect(cal.dev.runs[1].tpr_ci).toBeTruthy();
    expect(Array.isArray(cal.disagreements)).toBe(true);
    expect(r.warnings.some((w) => w.includes("under 60"))).toBe(true);
    const v = validateEvals(evals);
    expect(v.problems.filter((p) => p.level === "error")).toEqual([]);
  });
  it("a stale judge: dev below threshold blocks the test; a good dev unlocks it; the test runs once", async () => {
    // missed_refund ships stale: its test was for an older prompt
    const bad = await calibrate({ evalsDir: evals, judge: "missed_refund", split: "dev", ask: async () => JSON.stringify({ critique: "", result: "Pass" }) });
    expect(bad.status).toBe("dev"); // dev ran on the current prompt, so no longer stale
    expect(bad.ran!.tpr).toBe(0); expect(bad.ran!.disagreements.length).toBe(bad.ran!.matrix.fn); // every human Fail is a disagreement
    await expect(calibrate({ evalsDir: evals, judge: "missed_refund", split: "test", ask: oracle("missed_refund") })).rejects.toThrow(/runs once, after dev reaches/);
    const dev = await calibrate({ evalsDir: evals, judge: "missed_refund", split: "dev", ask: oracle("missed_refund") });
    const t = await calibrate({ evalsDir: evals, judge: "missed_refund", split: "test", ask: oracle("missed_refund"), now: new Date("2026-10-28T11:00:00Z"), force: !(dev.ran!.tpr >= 90 && dev.ran!.tnr >= 90) });
    expect(["trusted", "dev"]).toContain(t.status);
    const cal = JSON.parse(readFileSync(t.path, "utf8"));
    expect(cal.test.ran_at).toBe("2026-10-28T11:00:00Z"); expect(cal.stale_reason).toBeUndefined();
    await expect(calibrate({ evalsDir: evals, judge: "missed_refund", split: "test", ask: oracle("missed_refund") })).rejects.toThrow(/already ran/);
    expect(validateEvals(evals).problems.filter((p) => p.level === "error")).toEqual([]);
  });
  it("a prompt edit makes the judge stale on the next dev run, and leakage is a hard stop", async () => {
    const pf = join(evals, "graders", "judges", "tone_mismatch", "prompt.md");
    writeFileSync(pf, readFileSync(pf, "utf8") + "\nBe strict.\n");
    const r = await calibrate({ evalsDir: evals, judge: "tone_mismatch", split: "none", ask: oracle("tone_mismatch") });
    expect(r.status).toBe("stale"); expect(r.calibration.stale_reason).toBe("prompt_changed");
    expect(r.warnings.some((w) => w.includes("prompt_hash does not match"))).toBe(true);
    const d = await calibrate({ evalsDir: evals, judge: "tone_mismatch", split: "dev", ask: oracle("tone_mismatch") });
    expect(d.status).toBe("dev"); // progress on the new prompt; the old test no longer counts
    const jf = join(evals, "graders", "judges", "missed_refund", "judge.yaml");
    const cal = JSON.parse(readFileSync(join(evals, "graders", "judges", "missed_refund", "calibration.json"), "utf8"));
    writeFileSync(jf, readFileSync(jf, "utf8").replace(/few_shot:[\s\S]*?prompt:/, `few_shot:\n  - { trace_id: ${cal.splits.test.trace_ids[0]}, label: Fail }\nprompt:`));
    await expect(calibrate({ evalsDir: evals, judge: "missed_refund", split: "none" })).rejects.toThrow(/dev or test split/);
    expect(existsSync(join(evals, "graders", "judges", "missed_refund", "calibration.json"))).toBe(true);
  });
});
