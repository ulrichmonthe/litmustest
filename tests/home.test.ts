// Home (docs/stories/redesign.md, R2): the verdict follows the gates the way CI does, and Up next is ranked by fixed rules.
import { cpSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { home, type Gate, type UpNext, type Decision } from "../packages/cli/src/server/home.ts";
import { initEvals } from "../packages/cli/src/init.ts";
import { compareRuns } from "../packages/cli/src/compare.ts";

const EXAMPLE = join(import.meta.dirname, "..", "examples", "support-agent", "evals");
const copy = () => { const d = mkdtempSync(join(tmpdir(), "litmustest-home-")); cpSync(EXAMPLE, join(d, "evals"), { recursive: true }); return join(d, "evals"); };

describe("Home on the example", () => {
  const h = home(EXAMPLE) as { state: string; gates: Gate[]; up_next: UpNext[]; decide: Decision[]; counts: Record<string, number> };
  it("holds, because regression and quality are below their gates; capability is report only", () => {
    expect(h.state).toBe("hold");
    const g = Object.fromEntries(h.gates.map((x) => [x.suite, x]));
    expect(g.regression).toMatchObject({ gated: true, passed: false, below_min: true, min: 95, rate: 85.1 });
    expect(g.quality).toMatchObject({ gated: true, passed: false, below_min: true, min: 80 });
    expect(g.capability).toMatchObject({ gated: false, report_only: true, passed: true });
    for (const x of h.gates) expect(x.ci, `${x.suite} carries its interval`).not.toBeNull();
  });
  it("ranks Up next: what blocks the merge, then what keeps numbers honest, then what improves the evals", () => {
    const tiers = h.up_next.map((u) => u.tier);
    expect(tiers).toEqual([...tiers].sort((a, b) => a - b));
    expect(h.up_next.filter((u) => u.tier === 1).map((u) => u.title)).toEqual(["Regression is below its gate", "Quality is below its gate", `${h.decide.length} broken tasks fail only on a judge`]);
    expect(h.up_next.find((u) => u.title === "missed_refund judge is stale")).toMatchObject({ tier: 2, place: "Teach", href: "#/teach/judges/missed_refund" });
    expect(h.up_next.find((u) => u.title.endsWith("is likely broken"))).toMatchObject({ tier: 2, place: "Cover" });
    expect(h.up_next.find((u) => u.title.endsWith("conversations to label"))).toMatchObject({ tier: 3, place: "Teach", action: "Start labeling" });
    // a failing gate's reason prints its rate with its interval
    expect(h.up_next[0]!.reason).toMatch(/^85\.1% \(could be \d+–\d+%\); needs 95%$/);
  });
  it("offers a decision only for tasks that broke on judge checks alone, and the counts match compareRuns", () => {
    const c = compareRuns(EXAMPLE, "run_0040", "run_0041");
    const broke = c.flips.filter((f) => f.change === "Broke").map((f) => f.task);
    expect(h.counts.broke).toBe(broke.length);
    for (const d of h.decide) { expect(broke).toContain(d.task); expect(d.judge).toBe("tone_mismatch"); }
    expect(h.decide.length).toBeGreaterThan(0);
  });
  it("every flip carries one dot per trial on both sides", () => {
    const c = compareRuns(EXAMPLE, "run_0040", "run_0041");
    for (const f of c.flips) { expect(f.dots_a!.length).toBeGreaterThan(0); expect(f.dots_b!.every((d) => ["pass", "fail", "infra"].includes(d))).toBe(true); }
  });
});

describe("Home in other states", () => {
  it("is safe to merge when every gate passes, and then nothing blocks the merge", () => {
    const dir = copy();
    for (const f of ["litmustest.yaml", ...readdirSync(join(dir, "suites")).map((x) => join("suites", x))]) {
      const p = join(dir, f); writeFileSync(p, readFileSync(p, "utf8").replace(/min_pass_rate: \d+/g, "min_pass_rate: 10").replace(/max_drop_pts: \d+/g, "max_drop_pts: 100"));
    }
    const h = home(dir) as { state: string; up_next: UpNext[] };
    expect(h.state).toBe("safe");
    expect(h.up_next.filter((u) => u.tier === 1 && u.place === "Ship" && u.title.includes("gate"))).toEqual([]);
  });
  it("has no runs on a fresh init", () => {
    const d = mkdtempSync(join(tmpdir(), "litmustest-home-fresh-")); initEvals({ cwd: d });
    const h = home(join(d, "evals")) as { state: string; gates: Gate[]; decide: unknown[] };
    expect(h.state).toBe("no_runs"); expect(h.decide).toEqual([]);
  });
});
