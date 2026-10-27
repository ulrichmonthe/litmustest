import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { modesView, overview, judgeStatus } from "../packages/cli/src/server/overview.ts";

const EXAMPLE = join(import.meta.dirname, "..", "examples", "support-agent", "evals");
const GOOD = join(import.meta.dirname, "fixtures", "good", "evals");

describe("modes view on the example", () => {
  const modes = modesView(EXAMPLE);
  it("lists every failure mode with counts, grader status and a hash for the editor", () => {
    expect(modes.length).toBe(7);
    const tm = modes.find((m) => m.name === "tone_mismatch")!;
    expect(tm.grader).toMatchObject({ kind: "judge", status: "trusted" });
    expect(tm.labels).toBe(50); expect(tm.fail_labels).toBeGreaterThan(0);
    expect((tm.tasks as unknown[]).length).toBe(40);
    expect(String(tm.hash)).toMatch(/^[a-f0-9]{64}$/);
    expect(tm.has_runs).toBe(true); expect((tm.trend as number[]).length).toBe(2);
    const mr = modes.find((m) => m.name === "missed_refund")!;
    expect(mr.grader).toMatchObject({ kind: "judge", status: "stale" });
    const il = modes.find((m) => m.name === "identity_leak")!;
    expect(il.grader).toMatchObject({ kind: "code", label: "Code check" });
    const op = modes.find((m) => m.name === "over_searching")!;
    expect(op.grader.kind).toBe("transcript");
    expect(typeof tm.example_note).toBe("string");
  });
  it("counts failed checks by mode from the latest run", () => {
    const total = modes.reduce((a, m) => a + Number(m.run_fails), 0);
    expect(total).toBeGreaterThan(0);
  });
});

describe("overview on the example", () => {
  const o = overview(EXAMPLE) as Record<string, any>;
  it("has a verdict, three suite cards with CI and deltas, and a history", () => {
    expect(o.run.run_id).toBe("run_0041"); expect(o.previous.run_id).toBe("run_0040");
    expect(["good", "bad"]).toContain(o.verdict.tone); expect(o.verdict.lead.length).toBeGreaterThan(0);
    expect(o.suites.map((s: any) => s.name).sort()).toEqual(["capability", "quality", "regression"]);
    const reg = o.suites.find((s: any) => s.name === "regression");
    expect(reg.current.ci.low).toBeLessThan(reg.current.pass_rate); expect(reg.delta).toHaveProperty("note"); expect(reg.history.length).toBe(2);
  });
  it("raises the alerts the seeded data warrants", () => {
    const kinds = o.alerts.map((a: any) => a.kind);
    expect(kinds).toContain("Judge stale"); expect(kinds).toContain("Broken task"); expect(kinds).toContain("Flaky task"); expect(kinds).toContain("Review queue");
    expect(o.verdict.aside).toMatch(/1 judge needs attention/);
  });
  it("builds the pareto from the run, the judge table and coverage", () => {
    expect(o.modes.source).toBe("run"); expect(o.modes.items[0].count).toBeGreaterThanOrEqual(o.modes.items[1].count);
    expect(o.judges.find((j: any) => j.name === "tone_mismatch").status).toBe("trusted");
    expect(o.coverage[0]).toMatchObject({ name: "2026-10-27", items: 60 });
    expect(Array.isArray(o.flips)).toBe(true);
  });
});

describe("overview on a minimal directory", () => {
  it("falls back to labels when there is no run", () => {
    const o = overview(GOOD) as Record<string, any>;
    expect(o.run.run_id).toBe("run_0041");
    const modes = modesView(GOOD);
    expect(modes.find((m) => m.name === "old_mode")!.retired).toBeTruthy();
  });
  it("judgeStatus covers every calibration state", () => {
    expect(judgeStatus({}, 90).status).toBe("none");
    expect(judgeStatus({ judge: {} }, 90).status).toBe("untested");
    expect(judgeStatus({ judge: {}, calibration: { status: "dev", dev: { tpr: 80, tnr: 95 } } }, 90)).toMatchObject({ status: "dev", label: "Judge · below target" });
    expect(judgeStatus({ judge: {}, calibration: { status: "trusted", test: { tpr: 95, tnr: 92 } } }, 90)).toMatchObject({ status: "trusted", tpr: 95 });
  });
});
