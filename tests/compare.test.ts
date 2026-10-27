import { cpSync, existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { compareRuns, comparisonMarkdown, evaluateGates } from "../packages/cli/src/compare.ts";
import { ci, pickBase, writeWorkflow } from "../packages/cli/src/ci.ts";

const EXAMPLE = join(import.meta.dirname, "..", "examples", "support-agent", "evals");
let evals: string;
beforeAll(() => { evals = join(mkdtempSync(join(tmpdir(), "litmustest-cmp-")), "evals"); cpSync(EXAMPLE, evals, { recursive: true }); });

describe("compare", () => {
  it("pairs the two seeded runs: suite deltas with intervals, flips, mode and cost deltas, a verdict", () => {
    const c = compareRuns(evals, "run_0040", "run_0041");
    expect(c.common_tasks).toBe(40);
    expect(c.suites.map((s) => s.name).sort()).toEqual(["capability", "quality", "regression"]);
    for (const s of c.suites) { expect(s.ci.low).toBeLessThanOrEqual(s.delta); expect(s.ci.high).toBeGreaterThanOrEqual(s.delta); expect(["significant", "within noise"]).toContain(s.note); }
    expect(c.flips.every((f) => ["Broke", "Fixed", "Flaky"].includes(f.change))).toBe(true);
    expect(c.modes.length).toBeGreaterThan(0); expect(c.modes[0]!.b).toBeGreaterThanOrEqual(c.modes[c.modes.length - 1]!.b);
    expect(typeof c.cost.delta).toBe("number"); expect(c.verdict.text.length).toBeGreaterThan(10);
    expect(compareRuns(evals, "run_0040", "run_0040").suites.every((s) => s.delta === 0 && !s.significant)).toBe(true);
    expect(() => compareRuns(evals, "run_0040", "nope")).toThrow(/no run/);
  });
  it("evaluates gates: report_only never fails, a low pass rate does", () => {
    const c = compareRuns(evals, "run_0040", "run_0041");
    const g = evaluateGates(c);
    const reg = g.suites.find((s) => s.name === "regression")!; const cap = g.suites.find((s) => s.name === "capability")!;
    expect(cap.gate_result!.passed).toBe(true);
    expect(reg.gate_result!.passed).toBe(reg.b >= 95);
    if (!reg.gate_result!.passed) expect(reg.gate_result!.reasons[0]).toMatch(/below the 95% gate/);
  });
  it("renders markdown for a PR comment", () => {
    const c = compareRuns(evals, "run_0040", "run_0041"); evaluateGates(c);
    const md = comparisonMarkdown(c, { title: "litmustest" });
    expect(md).toContain("### litmustest: run_0041 vs run_0040"); expect(md).toContain("| Suite | A | B |"); expect(md).toContain("95% CI"); expect(md).toContain("Cost $");
  });
});

describe("ci", () => {
  it("picks the base run by branch, then latest", () => {
    expect(pickBase(evals, { baseBranch: "main", exclude: "run_0041" })).toBe("run_0040");
    expect(pickBase(evals, { baseBranch: "nope" })).toBe("run_0041");
    expect(pickBase(evals, { base: "x" })).toBe("x");
  });
  it("compares only, without running, and reports the gate verdict", async () => {
    const r = await ci({ evalsDir: evals, onlyCompare: ["run_0040", "run_0041"] });
    expect(r.base).toBe("run_0040"); expect(r.run_id).toBe("run_0041"); expect(r.markdown).toContain("run_0041 vs run_0040");
    expect(typeof r.passed).toBe("boolean"); expect(r.posted).toBe(false);
  });
  it("writes the workflow once", () => {
    const root = mkdtempSync(join(tmpdir(), "litmustest-wf-"));
    const p = writeWorkflow(root);
    expect(existsSync(p)).toBe(true); expect(readFileSync(p, "utf8")).toContain("npx litmustest ci --comment");
    expect(() => writeWorkflow(root)).toThrow(/already exists/);
  });
});
