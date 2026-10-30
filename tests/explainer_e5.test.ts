// Epic 5 of docs/stories/explainer.md: the CLI and the PR comment, run as a person would run them.
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { explain } from "../packages/cli/src/explain/index.ts";
import { loadGlossary } from "../packages/cli/src/glossary.ts";

const ROOT = join(import.meta.dirname, "..");
const EXAMPLE = join(ROOT, "examples", "support-agent", "evals");
const MAIN = join(ROOT, "packages", "cli", "src", "main.ts");
const cli = (args: string[], env: Record<string, string> = {}) => { const r = spawnSync(process.execPath, [MAIN, ...args], { encoding: "utf8", env: { ...process.env, NO_COLOR: "", FORCE_COLOR: "", ...env } }); return { code: r.status, out: r.stdout, err: r.stderr }; };
const copy = () => { const d = mkdtempSync(join(tmpdir(), "litmustest-e5-")); cpSync(EXAMPLE, join(d, "evals"), { recursive: true }); return join(d, "evals"); };
/** --explain only adds lines: take them out and the rest is the output without the flag. */
const withoutExplanations = (flagged: string, plain: string) => { const p = new Set(plain.split("\n")); return flagged.split("\n").filter((l) => p.has(l) || !/^\s{2,}\S/.test(l)).join("\n"); };
const normalise = (s: string) => s.replace(/\d+s\n/g, "Ns\n").replace(/\$\d+(\.\d+)?/g, "$N");

describe("E5-S1 litmustest explain", () => {
  it("prints term, short, why, good, and here with next inside a repo", () => {
    const r = cli(["explain", "tpr", "--dir", EXAMPLE]); expect(r.code).toBe(0);
    for (const part of ["True positive rate", "Why it matters:", "What good looks like:", "In this repo:", "Next:"]) expect(r.out).toContain(part);
    expect(r.out).toMatchSnapshot();
  });
  it("prints the same words as the panel for the same term and repo state", () => {
    const r = cli(["explain", "tpr", "--dir", EXAMPLE]);
    for (const judge of ["tone_mismatch", "missed_refund"]) {
      const panel = explain("tpr", { evalsDir: EXAMPLE, source: "judge", ctx: { judge } })!; // what /api/glossary/here sends the panel
      expect(r.out).toContain(panel.shortPlain); expect(r.out).toContain(panel.why!); expect(r.out).toContain(panel.good!);
      expect(r.out).toContain(`${panel.here} Next: ${panel.next!.say}`);
    }
  });
  it("an unknown term exits 2 with at most three closest matches", () => {
    const r = cli(["explain", "tprr", "--dir", EXAMPLE]);
    expect(r.code).toBe(2); expect(r.out).toBe("");
    const closest = /Closest: ([^.]+)\./.exec(r.err)![1]!.split(", ");
    expect(closest[0]).toBe("tpr"); expect(closest.length).toBeLessThanOrEqual(3);
    expect(cli(["explain", "qqqqqqqqq", "--dir", EXAMPLE]).code).toBe(2);
  });
  it("--list lists every term", () => {
    const r = cli(["explain", "--list", "--dir", EXAMPLE]); expect(r.code).toBe(0);
    const ids = r.out.trim().split("\n").map((l) => l.split(/\s+/)[0]);
    expect(ids.sort()).toEqual(loadGlossary(EXAMPLE).map((e) => e.id).sort());
  });
});

describe("E5-S2 --explain", () => {
  const cases: [string, () => string[]][] = [
    ["compare", () => ["compare", "run_0040", "run_0041", "--dir", EXAMPLE]],
    ["doctor", () => ["doctor", "--dir", EXAMPLE]],
    ["calibrate", ((d = copy()) => () => ["calibrate", "tone_mismatch", "--split", "none", "--dir", d])()],
    ["run", ((d = copy()) => () => ["run", "--dry-run", "--suite", "regression", "--id", "run_9001", "--dir", d])()],
  ];
  for (const [name, args] of cases) {
    it(`${name}: one indented sentence under rows with the flag; without it, output is unchanged`, () => {
      const p = cli(args()); const f = cli([...args(), "--explain"]);
      expect(p.code).toBe(f.code);
      const plain = normalise(p.out), flagged = normalise(f.out); // timings and costs vary between two runs
      const added = flagged.split("\n").filter((l) => !plain.split("\n").includes(l));
      expect(added.length, name).toBeGreaterThan(0);
      for (const l of added) expect(l, name).toMatch(/^\s{2,}\S/);
      expect(withoutExplanations(flagged, plain)).toBe(plain);
      if (name === "compare" || name === "doctor") expect(plain).toMatchSnapshot(); // the others print temp paths
    }, 60_000);
  }
  it("is muted on a colour terminal and plain text otherwise", () => {
    expect(cli(["doctor", "--dir", EXAMPLE, "--explain"]).out).not.toContain("\x1b[");
    expect(cli(["doctor", "--dir", EXAMPLE, "--explain"], { FORCE_COLOR: "1" }).out).toContain("\x1b[2m");
    expect(cli(["doctor", "--dir", EXAMPLE], { FORCE_COLOR: "1" }).out).not.toContain("\x1b[");
  });
  it("run --explain no longer calls Claude; that is run --explain-failures", () => {
    const help = cli(["--help"]).out;
    expect(help).toMatch(/--explain-failures asks Claude/); expect(help).toMatch(/--explain \(also on compare, calibrate, doctor\)/);
  });
});
