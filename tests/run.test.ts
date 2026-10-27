import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
vi.setConfig({ testTimeout: 120_000 });
import { run, splitCommand, viewFromTrial } from "../packages/cli/src/run.ts";
import { validateEvals } from "../packages/cli/src/validate.ts";
import type { JudgeAsk } from "../packages/cli/src/judge_run.ts";

const EXAMPLE = join(import.meta.dirname, "..", "examples", "support-agent", "evals");
const FAKE = join(import.meta.dirname, "fixtures", "agents", "fake_agent.mjs");
let repo: string; let evals: string;
// judge only the trace under test, not the few-shot examples rendered above it
const judge: JudgeAsk = async (_s, user) => JSON.stringify({ critique: "fine", result: /Oops|Hey there|No worries/.test(user.split("### Trace to judge").pop() ?? "") ? "Fail" : "Pass" });

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), "litmustest-run-")); evals = join(repo, "evals");
  cpSync(EXAMPLE, evals, { recursive: true });
  // forget the seeded runs so likely_broken needs real history, and point the agent at the fake
  for (const f of readdirSync(join(evals, "runs"))) execFileSync("rm", [join(evals, "runs", f)]);
  writeFileSync(join(evals, "litmustest.yaml"), readFileSync(join(evals, "litmustest.yaml"), "utf8").replace(/command: .*\n(\s+\{trial_dir\}\n)?/, `command: node ${FAKE}\n`));
  execFileSync("git", ["init", "-q"], { cwd: repo });
});

describe("helpers", () => {
  it("splits a command line respecting quotes", () => { expect(splitCommand(`node "a b/x.mjs" --task {task} ''`)).toEqual(["node", "a b/x.mjs", "--task", "{task}", ""]); });
  it("builds a view from a trial", () => { const v = viewFromTrial({ transcript: [{ role: "user", content: "hi" }, { role: "tool", tool: "x", content: "{}" }, { role: "assistant", content: "yo" }], tool_calls: [{ name: "x", result: { error: "e" } }] }, "t"); expect(v.turns.map((t) => t.role)).toEqual(["user", "tool", "agent"]); expect(v.calls[0]!.ok).toBe(false); });
});

describe("litmustest run", () => {
  it("runs the regression suite with the fake agent: grades, infra tagging, flaky, summary validates", async () => {
    const r = await run({ evalsDir: evals, suites: ["regression"], trials: 3, concurrency: 4, judgeAsk: judge, runId: "run_t1", now: new Date("2026-10-26T10:00:00Z") });
    const s = r.summary as any;
    expect(s.run_id).toBe("run_t1"); expect(s.suite_names).toEqual(["regression"]);
    expect(Object.keys(s.tasks).length).toBe(19); expect(s.suites.regression.n_tasks).toBe(19); expect(s.suites.regression.k).toBe(3);
    expect(s.suites.regression.ci.low).toBeLessThanOrEqual(s.suites.regression.pass_rate);
    expect(s.suites.regression.excluded_judges).toEqual(["missed_refund"]); // stale in the seed
    expect(s.tasks.refund_ghost_account_frustrated.strict_pass).toBe(0);
    expect(s.tasks.refund_ghost_account_frustrated.trials[0].failed_checks).toContain("end_state");
    expect(s.tasks.refund_ghost_account_frustrated.likely_broken).toBeUndefined(); // needs 3 runs
    const flaky = Object.entries(s.tasks).filter(([, t]: any) => t.flaky).map(([id]) => id);
    expect(flaky.some((id) => id.endsWith("_first_time") && (id.startsWith("duplicate_charge") || id.startsWith("pro_refund")))).toBe(true);
    expect(s.tasks.duplicate_charge_business.strict_pass).toBe(100);
    expect(s.tasks.duplicate_charge_business.trials[0].tokens).toBe(1101); expect(s.tasks.duplicate_charge_business.trials[0].transcript_ref).toBe("local:run_t1/duplicate_charge_business/1");
    expect(existsSync(join(repo, ".litmustest", "transcripts", "run_t1", "duplicate_charge_business", "1", "grades.json"))).toBe(true);
    const grades = JSON.parse(readFileSync(join(repo, ".litmustest", "transcripts", "run_t1", "refund_ghost_account_frustrated", "1", "grades.json"), "utf8"));
    expect(grades.grades.find((g: any) => g.check === "end_state").reason).toContain("refunds.status");
    expect(grades.grades.find((g: any) => g.check === "missed_refund").excluded).toContain("stale");
    expect(grades.triage_suggested).toBe("agent");
    expect(validateEvals(evals).problems.filter((p) => p.level === "error")).toEqual([]);
    expect(r.warnings.some((w) => w.includes("missed_refund"))).toBe(true);
  });
  it("tags a crash, a hang and a silent exit as infra errors and excludes them from the score", async () => {
    process.env.FAKE_CRASH = "invoice_copy_business"; process.env.FAKE_HANG = "invoice_copy_frustrated"; process.env.FAKE_SILENT = "invoice_copy_first_time";
    try {
      const r = await run({ evalsDir: evals, tasks: ["invoice_copy_business", "invoice_copy_frustrated", "invoice_copy_first_time", "duplicate_charge_business"], trials: 2, concurrency: 4, judgeAsk: judge, runId: "run_t2", timeoutMs: 1500 });
      const s = r.summary as any;
      expect(s.tasks.invoice_copy_business.trials[0]).toMatchObject({ infra_error: true, infra_error_kind: "harness" });
      expect(s.tasks.invoice_copy_frustrated.trials[0]).toMatchObject({ infra_error: true, infra_error_kind: "timeout" });
      expect(s.tasks.invoice_copy_first_time.trials[0]).toMatchObject({ infra_error: true, infra_error_kind: "harness" });
      expect(s.infra_error_rate).toBe(75);
      expect(s.suites.regression.infra_errors).toBe(6); expect(s.suites.regression.pass_rate).toBe(100); // only the healthy task is scored
      expect(r.trials.find((t) => t.task === "invoice_copy_business")!.infra_message).toContain("boom");
    } finally { delete process.env.FAKE_CRASH; delete process.env.FAKE_HANG; delete process.env.FAKE_SILENT; }
  });
  it("flags a task likely broken after three all-fail runs totalling 15 trials", async () => {
    await run({ evalsDir: evals, tasks: ["refund_ghost_account_frustrated"], trials: 5, judgeAsk: judge, runId: "run_t3" });
    const mid = await run({ evalsDir: evals, tasks: ["refund_ghost_account_frustrated"], trials: 5, judgeAsk: judge, runId: "run_t4" });
    expect((mid.summary as any).tasks.refund_ghost_account_frustrated.likely_broken).toBeUndefined(); // 3 + 5 + 5 trials: the first run had only 3
    const r = await run({ evalsDir: evals, tasks: ["refund_ghost_account_frustrated"], trials: 5, judgeAsk: judge, runId: "run_t5" });
    const s = r.summary as any;
    expect(s.tasks.refund_ghost_account_frustrated.likely_broken).toBe(true);
    const grades = JSON.parse(readFileSync(join(repo, ".litmustest", "transcripts", "run_t5", "refund_ghost_account_frustrated", "1", "grades.json"), "utf8"));
    expect(grades.triage_suggested).toBe("task");
  });
  it("dry-run grades the reference solutions without an agent", async () => {
    const r = await run({ evalsDir: evals, suites: ["quality"], dryRun: true, judgeAsk: judge, runId: "run_dry", trials: 1 });
    expect((r.summary as any).suites.quality.n_tasks).toBe(5);
    expect(r.trials.every((t) => !t.infra_error)).toBe(true);
  });
  it("refuses an unknown suite and a missing agent command", async () => {
    await expect(run({ evalsDir: evals, suites: ["nope"], judgeAsk: judge })).rejects.toThrow(/no suite/);
    await expect(run({ evalsDir: evals, suites: ["quality"], judgeAsk: judge, agentCommand: "" , dryRun: false })).rejects.toThrow();
  });
});
