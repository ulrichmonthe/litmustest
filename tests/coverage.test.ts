import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { callTarget, computeCoverage, coverageSnapshot, depthOf, matchRoute, scanRoutes, specItems, surfaceArea } from "../packages/cli/src/coverage.ts";
import { coverageText, gaps, underThresholds } from "../packages/cli/src/coverage_cli.ts";
import { compareRuns, comparisonMarkdown } from "../packages/cli/src/compare.ts";
import { SchemaSet } from "../packages/cli/src/schemas.ts";

const w = (root: string, rel: string, s: string) => { mkdirSync(join(root, rel, ".."), { recursive: true }); writeFileSync(join(root, rel), s); };

describe("reading the maps", () => {
  let root: string;
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "litmustest-cov-"));
    w(root, "docs/qa.md", [
      "Intro mentions SYS-LOOP-02 before it is defined (a cross-reference).",
      "| ID | Given | When | Then | Priority |",
      "| SYS-LOOP-01 | A student on a mission | they try to skip Verify | they're blocked | **P0** |",
      "| SYS-LOOP-02 | A gut call was made | it's saved | it's logged with `mission_id` | P1 |",
      "- SYS-PRIV-01: no free text reaches the server",
    ].join("\n"));
    w(root, "backend/api/play.py", 'router = APIRouter(prefix="/api/play", tags=["student"])\n@router.post("/join")\ndef j(): ...\n@router.get("/case/{index}")\ndef c(): ...\n@router.get("/files/{path:path}")\ndef f(): ...\n');
    w(root, "backend/app.py", '@app.get("/api/health")\ndef h(): ...\n');
    w(root, "web/server.js", "router.post('/api/site/pilot', h);\napp.get(`/api/site/info`, h);\n");
  });
  it("takes each spec id's title and priority from the line that defines it", () => {
    const { items } = specItems(root, { files: ["docs/*.md"], id_pattern: "SYS-[A-Z]+-\\d+" });
    expect(items.map((i) => i.id)).toEqual(["SYS-LOOP-02", "SYS-LOOP-01", "SYS-PRIV-01"]);
    const two = items.find((i) => i.id === "SYS-LOOP-02")!;
    expect(two).toEqual({ id: "SYS-LOOP-02", area: "SYS-LOOP", title: "A gut call was made · it's saved · it's logged with mission_id", priority: "P1" });
    expect(items.find((i) => i.id === "SYS-LOOP-01")!.priority).toBe("P0");
    expect(items.find((i) => i.id === "SYS-PRIV-01")!.title).toBe("no free text reaches the server");
  });
  it("scans route decorators with router prefixes, and Express-style calls", () => {
    expect(scanRoutes(root, ["backend/**/*.py", "web/*.js"])).toEqual(["GET /api/health", "GET /api/play/case/{index}", "GET /api/play/files/{path:path}", "GET /api/site/info", "POST /api/play/join", "POST /api/site/pilot"]);
  });
  it("matches a recorded call to its route, preferring the most specific one", () => {
    const routes = ["GET /api/play/case/{index}", "GET /api/play/case/latest", "GET /api/play/files/{path:path}", "POST /api/play/join", "verify_identity"];
    expect(callTarget({ name: "post_api_play_join", args: { path: "/api/play/join", json: {} } })).toEqual({ name: "post_api_play_join", method: "POST", path: "/api/play/join" });
    expect(matchRoute(routes, { name: "post_api_play_join", args: { path: "/api/play/join" } })).toBe("POST /api/play/join");
    expect(matchRoute(routes, { name: "get_case", args: { path: "/api/play/case/3?x=1" } })).toBe("GET /api/play/case/{index}");
    expect(matchRoute(routes, { name: "get_case", args: { path: "/api/play/case/latest" } })).toBe("GET /api/play/case/latest");
    expect(matchRoute(routes, { name: "get_f", args: { path: "/api/play/files/a/b.txt" } })).toBe("GET /api/play/files/{path:path}");
    expect(matchRoute(routes, { name: "x", args: { path: "/api/play/join", method: "GET" } })).toBeUndefined();
    expect(matchRoute(routes, { name: "verify_identity", args: { account: 1 } })).toBe("verify_identity");
    expect(surfaceArea("POST /api/play/case/{index}/gut")).toBe("/api/play"); expect(surfaceArea("verify_identity")).toBe("tools");
  });
  it("ranks depth: guarded needs a passing regression task; an untrusted judge never counts", () => {
    expect(depthOf([])).toEqual({ depth: "none", failing: false });
    expect(depthOf([{ id: "a", suite: "capability", status: "fail", via: "source" }]).depth).toBe("planned");
    expect(depthOf([{ id: "a", suite: "capability", status: "pass", via: "source" }]).depth).toBe("checked");
    expect(depthOf([{ id: "a", suite: "regression", status: "fail", via: "source" }])).toEqual({ depth: "planned", failing: true });
    expect(depthOf([{ id: "a", suite: "regression", status: "pass", via: "called" }]).depth).toBe("guarded");
    expect(depthOf([{ id: "a", suite: "regression", status: "pass", via: "check", note: "judge not trusted yet" }]).depth).toBe("planned");
  });
});

describe("computeCoverage on a project", () => {
  let root: string; let evals: string;
  const run = (id: string, at: string, tasks: Record<string, boolean>) => ({ run_id: id, commit: "abc1234", started_at: at, finished_at: at, config_hash: "0".repeat(64), trials: 1, suites: {}, infra_error_rate: 0, cost_usd: 0,
    tasks: Object.fromEntries(Object.entries(tasks).map(([t, pass]) => [t, { suite: t.startsWith("cap") ? "capability" : "regression", strict_pass: pass ? 100 : 0, weighted: pass ? 100 : 0, trials: [{ pass, failed_checks: pass ? [] : ["end_state"], infra_error: false }] }])) });
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "litmustest-cov-proj-")); evals = join(root, "evals");
    w(root, "docs/qa.md", "| SYS-LOOP-01 | blocked | P0 |\n| SYS-LOOP-02 | logged | P1 |\n| SYS-PRIV-01 | no free text | P0 |\n| SYS-PRIV-02 | export | P2 |\n");
    w(root, "backend/play.py", 'router = APIRouter(prefix="/api/play")\n@router.post("/join")\n@router.get("/state")\n@router.get("/record")\n@app.get("/api/health")\n');
    w(evals, "litmustest.yaml", 'version: 1\nproject: p\ncoverage:\n  spec: { files: [docs/qa.md], id_pattern: "SYS-[A-Z]+-\\\\d+" }\n  surface: { scan: ["backend/*.py"], ignore: ["GET /api/health"] }\n');
    w(evals, "failure_modes/gate_bypass.yaml", "name: gate_bypass\ndefinition: Verify can be skipped. Fail when it can.\nseverity: high\ncreated: 2026-10-27\n");
    w(evals, "failure_modes/tone.yaml", "name: tone\ndefinition: Wrong tone.\nseverity: low\ncreated: 2026-10-27\n");
    w(evals, "tasks/regression/reg_gate.yaml", "id: reg_gate\nsuite: regression\nsource: spec:sys-loop-01\nchecks:\n  - { id: end_state, type: outcome, expect: { a: 1 }, failure_mode: gate_bypass }\n  - { id: tone, type: judge, failure_mode: tone }\n");
    w(evals, "tasks/capability/cap_priv.yaml", "id: cap_priv\nsuite: capability\nsource: spec:sys-priv-01\ncovers: [SYS-PRIV-02, \"GET /api/play/record\", SYS-NOPE-09]\nchecks:\n  - { id: end_state, type: outcome, expect: { a: 1 } }\n");
    w(evals, "runs/r1.json", JSON.stringify(run("r1", "2026-10-26T10:00:00Z", { reg_gate: true, cap_priv: false })));
    w(evals, "runs/r2.json", JSON.stringify(run("r2", "2026-10-27T10:00:00Z", { reg_gate: true, cap_priv: true })));
    w(root, ".litmustest/transcripts/r2/reg_gate/1/trial.json", JSON.stringify({ tool_calls: [{ name: "post_join", args: { path: "/api/play/join" } }, { name: "get_state", args: { path: "/api/play/state", method: "GET" } }, { name: "x", args: { path: "/elsewhere" } }] }));
  });
  it("measures spec, surface and risk with depth, areas and warnings", () => {
    const c = computeCoverage(evals);
    expect(c.run_id).toBe("r2");
    const spec = c.maps.spec;
    expect(spec.totals).toEqual({ total: 4, none: 1, planned: 0, checked: 2, guarded: 1 });
    expect(spec.items.find((i) => i.id === "SYS-LOOP-01")!.tasks[0]).toEqual({ id: "reg_gate", suite: "regression", status: "pass", via: "source" });
    expect(spec.areas).toEqual([{ name: "SYS-LOOP", total: 2, planned: 1, checked: 1, guarded: 1 }, { name: "SYS-PRIV", total: 2, planned: 2, checked: 2, guarded: 0 }]);
    const surface = c.maps.surface;
    expect(surface.items.map((i) => `${i.id}=${i.depth}`)).toEqual(["GET /api/play/record=checked", "GET /api/play/state=guarded", "POST /api/play/join=guarded"]);
    expect(c.maps.risk.items.map((i) => `${i.id}=${i.depth}`)).toEqual(["gate_bypass=guarded", "tone=planned"]);
    expect(c.maps.risk.items[1]!.tasks[0]!.note).toMatch(/not trusted/);
    expect(c.warnings.join(" ")).toContain("SYS-NOPE-09");
    expect(c.scope.not_measured.join(" ")).toMatch(/Production traffic/);
  });
  it("orders gaps by priority and severity, prints scope, and enforces thresholds", () => {
    const c = computeCoverage(evals);
    expect(gaps(c).map((g) => `${g.map}:${g.id}`)).toEqual(["spec:SYS-LOOP-02", "risk:tone"]);
    const text = coverageText(c);
    expect(text).toContain("v1 measures three maps: spec, surface and risk. It does not measure production traffic");
    expect(text).toContain("Spec     75% checked or guarded · 3 of 4 have a task · guarded 1 · checked 2 · planned 0 · none 1");
    expect(underThresholds(c, ["spec=80", "surface=50"])).toEqual(["spec coverage 75% is under 80%"]);
    expect(underThresholds(c, ["nope"])[0]).toMatch(/bad threshold/);
  });
  it("says what is missing when nothing is configured", () => {
    const bare = join(mkdtempSync(join(tmpdir(), "litmustest-cov-bare-")), "evals");
    w(bare, "litmustest.yaml", "version: 1\nproject: p\n");
    const c = computeCoverage(bare);
    expect(c.maps.spec.configured).toBe(false); expect(c.maps.spec.reason).toMatch(/Add coverage.spec/);
    expect(c.maps.surface.configured).toBe(false); expect(c.maps.risk.configured).toBe(true);
  });
  it("snapshots into the run summary and compares runs, listing items that lost their eval", () => {
    const snap = coverageSnapshot(computeCoverage(evals));
    const schemas = new SchemaSet();
    const r1 = { ...run("r1", "2026-10-26T10:00:00Z", { reg_gate: true, cap_priv: false }), coverage: { spec: { total: 4, none: 0, planned: 0, checked: 3, guarded: 1, uncovered: [] } } };
    const r2 = { ...run("r2", "2026-10-27T10:00:00Z", { reg_gate: true, cap_priv: true }), coverage: snap };
    expect(schemas.check("run_summary", r2)).toEqual([]);
    w(evals, "runs/r1.json", JSON.stringify(r1)); w(evals, "runs/r2.json", JSON.stringify(r2));
    const cmp = compareRuns(evals, "r1", "r2");
    expect(cmp.coverage).toEqual([{ map: "spec", a: 100, b: 75, delta: -25, total_a: 4, total_b: 4, newly_uncovered: ["SYS-LOOP-02"] }]);
    expect(comparisonMarkdown(cmp)).toContain("**1 item with no eval since r1** (new, or lost their task): spec: `SYS-LOOP-02`");
  });
});
