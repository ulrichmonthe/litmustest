import { cpSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { explainTemplate, explainWithClaude, firstProblem, type ExplainInput } from "../packages/cli/src/explain.ts";
import { explainRun } from "../packages/cli/src/explain_run.ts";
import { SchemaSet } from "../packages/cli/src/schemas.ts";
import { serve, type Running } from "../packages/cli/src/serve.ts";

const view = {
  id: "t", model: undefined, input_tokens: 0, output_tokens: 0, metadata: {},
  turns: [
    { role: "user" as const, content: '{"scenario":"compose"}' },
    { role: "tool" as const, content: "200", tool: "post_classes" },
    { role: "tool" as const, content: "422", tool: "post_sessions" },
    { role: "agent" as const, content: "done" },
  ],
  calls: [
    { name: "post_classes", args: { path: "/api/classes" }, result: { status: 200, body: { id: 5 } }, ok: true, span_id: "call_0" },
    { name: "post_sessions", args: { path: "/api/sessions" }, result: { status: 422, body: { detail: "No approved cases match these filters." } }, ok: true, span_id: "call_1" },
  ],
};
const base = (over: Partial<ExplainInput> = {}): ExplainInput => ({
  task: { id: "band_composes", suite: "capability", description: "A 9-11 class can compose a session.", source: "spec:06", checks: [{ id: "end_state", type: "outcome", expect: { "compose.status": 200 }, failure_mode: "band_gap" }] },
  suiteKind: "capability",
  summary: { pass: false, failed_checks: ["end_state"], infra_error: false },
  grades: [{ check: "end_state", type: "outcome", pass: false, reason: "compose.status: expected 200, got 422", failure_mode: "band_gap", step: 3 }],
  view, outcome: [{ check: "end_state", path: "compose.status", expected: 200, actual: 422, reference: 200 }],
  modes: { band_gap: "A supported band cannot get a session." },
  ...over,
});

describe("explainTemplate", () => {
  it("finds the first failing step from an HTTP status, not only from an error field", () => {
    expect(firstProblem(view)).toEqual({ step: 2, label: "POST /api/sessions", detail: "returned 422: “No approved cases match these filters”" });
  });
  it("calls a failing capability task not built yet, says where and what would make it pass", () => {
    const x = explainTemplate(base());
    expect(x.kind).toBe("not_built");
    expect(x.headline).toContain("POST /api/sessions returned 422");
    expect(x.happened).toContain("compose.status should be 200 but was 422");
    expect(x.happened).toContain("step 3");
    expect(x.meaning).toMatch(/does not block merging/);
    expect(x.to_pass).toEqual(["Make compose.status equal 200 (the reference solution gets this)."]);
    expect(x.failed[0]!.mode_definition).toBe("A supported band cannot get a session.");
  });
  it("calls a failing regression task a break that blocks the gate", () => {
    const x = explainTemplate(base({ suiteKind: "regression", task: { ...base().task, suite: "regression" } }));
    expect(x.kind).toBe("broke"); expect(x.meaning).toMatch(/blocks the merge gate/);
  });
  it("names the failed check from the run summary when the grades are not stored", () => {
    const x = explainTemplate(base({ grades: [], view: null, outcome: [], suiteKind: "regression" }));
    expect(x.headline).toBe("The outcome check end_state failed (failure mode band_gap).");
    expect(x.failed[0]!.mode_definition).toBe("A supported band cannot get a session.");
  });
  it("separates infra, passing, judge-only, broken and flaky results", () => {
    expect(explainTemplate(base({ summary: { pass: false, failed_checks: [], infra_error: true, infra_error_kind: "timeout" } })).kind).toBe("infra");
    expect(explainTemplate(base({ summary: { pass: true, failed_checks: [], infra_error: false }, grades: [{ check: "end_state", type: "outcome", pass: true }] })).kind).toBe("pass");
    expect(explainTemplate(base({ grades: [{ check: "tone", type: "judge", pass: false, critique: "too curt", failure_mode: "tone" }] })).kind).toBe("grader_doubt");
    expect(explainTemplate(base({ likelyBroken: true })).kind).toBe("broken_task");
    expect(explainTemplate(base({ flaky: true })).kind).toBe("flaky");
  });
});

describe("explainWithClaude", () => {
  it("sends the facts and the numbered transcript, and keeps only the fields it expects", async () => {
    let seen = "";
    const e = await explainWithClaude(base(), { ask: async (_s, u) => { seen = u; return '```json\n{"summary":"It tried to compose and was refused.","cause":"Step 3 returned 422.","fix":"Add cases.","confidence":"high","extra":1}\n```'; }, now: new Date("2026-10-28T10:00:00Z") });
    expect(seen).toContain("First step that went wrong: step 3");
    expect(seen).toContain("[3] TOOL post_sessions");
    expect(e).toEqual({ summary: "It tried to compose and was refused.", cause: "Step 3 returned 422.", fix: "Add cases.", confidence: "high", model: "claude-opus-5-5", at: "2026-10-28T10:00:00Z" });
  });
  it("refuses an empty answer", async () => {
    await expect(explainWithClaude(base(), { ask: async () => "{}" })).rejects.toThrow(/no summary/);
  });
});

describe("explain on a real run", () => {
  let cwd: string; let srv: Running;
  const fake = async () => JSON.stringify({ summary: "The agent skipped verification.", cause: "No verify call.", fix: "Verify first.", confidence: "medium" });
  beforeAll(async () => {
    cwd = mkdtempSync(join(tmpdir(), "litmustest-explain-"));
    cpSync(join(import.meta.dirname, "..", "examples", "support-agent", "evals"), join(cwd, "evals"), { recursive: true });
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd }); execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "seed"], { cwd });
    execFileSync("git", ["add", "-A"], { cwd }); execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "evals"], { cwd });
    srv = await serve({ evalsDir: join(cwd, "evals"), port: 0, watch: false, explainAsk: fake });
  });
  afterAll(async () => { await srv.close(); });

  it("prints templates and writes nothing with --no-model", async () => {
    const r = await explainRun({ evalsDir: join(cwd, "evals"), runId: "run_0041", model: false });
    expect(r.items.length).toBeGreaterThan(0); expect(r.written).toBe(0);
    expect(r.items.every((i) => i.template.kind !== "pass" && !i.explanation)).toBe(true);
  });
  it("writes one valid explanation per failed task, and skips them next time", async () => {
    const r = await explainRun({ evalsDir: join(cwd, "evals"), runId: "run_0041", tasks: ["invoice_copy_frustrated"], ask: fake });
    expect(r.written).toBe(1);
    const run = JSON.parse(readFileSync(join(cwd, "evals", "runs", "run_0041.json"), "utf8"));
    expect(new SchemaSet().check("run_summary", run)).toEqual([]);
    expect(run.tasks.invoice_copy_frustrated.trials[0].explanation.summary).toBe("The agent skipped verification.");
    const again = await explainRun({ evalsDir: join(cwd, "evals"), runId: "run_0041", tasks: ["invoice_copy_frustrated"], ask: fake });
    expect(again.written).toBe(0); expect(again.items[0]!.skipped).toBe("already explained");
  });
  it("the trial route carries the template and the saved explanation; the explain route saves through the tray", async () => {
    const get = async (p: string, init?: RequestInit) => { const r = await fetch(srv.url + p, { ...init, headers: { "content-type": "application/json" } }); return { status: r.status, body: await r.json() }; };
    const t = await get("/api/transcripts/run_0041/refund_outside_window_frustrated/3");
    expect(t.body.explain.kind).toBeTruthy(); expect(t.body.explain.claude).toBeNull();
    const e = await get("/api/transcripts/run_0041/refund_outside_window_frustrated/3/explain", { method: "POST", body: "{}" });
    expect(e.status).toBe(200); expect(e.body.explanation.cause).toBe("No verify call.");
    expect((await get("/api/transcripts/run_0041/refund_outside_window_frustrated/3")).body.explain.claude.summary).toBe("The agent skipped verification.");
    expect((await get("/api/pending")).body.files.map((f: { path: string }) => f.path)).toContain("evals/runs/run_0041.json");
  });
});
