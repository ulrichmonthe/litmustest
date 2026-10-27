import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { braintrustLine, langfuseLine, pullBraintrust, pullLangfuse, type Fetch } from "../packages/cli/src/adapters/platforms.ts";
import { jsonlLineToTrace } from "../packages/cli/src/adapters/jsonl.ts";
import { SchemaSet } from "../packages/cli/src/schemas.ts";
import { isDue, lastBatch, sample } from "../packages/cli/src/sample.ts";
import { applyGraduations, doctor, graduationProposals } from "../packages/cli/src/graduate.ts";
import { run } from "../packages/cli/src/run.ts";
import { App } from "../packages/cli/src/server/app.ts";
import { serve, type Running } from "../packages/cli/src/serve.ts";
vi.setConfig({ testTimeout: 120_000 });

const EXAMPLE = join(import.meta.dirname, "..", "examples", "support-agent", "evals");
const JSONL = join(import.meta.dirname, "..", "examples", "support-agent", "traces", "support.jsonl");
const FAKE = join(import.meta.dirname, "fixtures", "agents", "fake_agent.mjs");
const schemas = new SchemaSet();
const git = (cwd: string, ...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd, encoding: "utf8" }).trim();

const fakeFetch = (routes: Record<string, unknown>): Fetch => async (url, init) => { const key = Object.keys(routes).find((k) => url.includes(k)); const body = key ? routes[key] : { error: "nope" }; void init; return { ok: Boolean(key), status: key ? 200 : 404, json: async () => body, text: async () => JSON.stringify(body) }; };

describe("platform adapters", () => {
  const lfTrace = { id: "lf_1", timestamp: "2026-10-27T10:00:00.000Z", name: "support", input: "I was charged twice", output: "Refunded.", sessionId: "s1", metadata: { persona: "frustrated" } };
  const lfObs = [
    { id: "g1", type: "GENERATION", model: "claude-opus-5-5", startTime: "2026-10-27T10:00:00.000Z", input: [{ role: "system", content: "You are support." }, { role: "user", content: "I was charged twice" }], output: { role: "assistant", content: "", tool_calls: [{ id: "c1", function: { name: "verify_identity", arguments: "{\"email\":\"a@b.c\"}" } }] } },
    { id: "t1", type: "SPAN", name: "verify_identity", startTime: "2026-10-27T10:00:01.000Z", output: { verified: true } },
    { id: "g2", type: "GENERATION", model: "claude-opus-5-5", startTime: "2026-10-27T10:00:02.000Z", input: [{ role: "user", content: "I was charged twice" }], output: { role: "assistant", content: "Refunded." } },
  ];
  it("Langfuse: pages traces, fetches observations, and the result validates through the JSONL adapter", async () => {
    const f = fakeFetch({ "/api/public/traces?": { data: [lfTrace], meta: { totalPages: 1 } }, "/api/public/traces/lf_1": { ...lfTrace, observations: lfObs } });
    const r = await pullLangfuse({ fetch: f, env: { LANGFUSE_PUBLIC_KEY: "pk", LANGFUSE_SECRET_KEY: "sk", LANGFUSE_HOST: "https://lf.example" }, since: "2026-10-20T00:00:00Z" });
    expect(r.lines.length).toBe(1); const l = r.lines[0]!;
    expect(l.id).toBe("lf_1"); expect(l.model).toBe("claude-opus-5-5"); expect((l.tool_calls as any[])[0]).toMatchObject({ name: "verify_identity", arguments: { email: "a@b.c" }, result: { verified: true }, turn: 0 });
    expect((l.messages as any[]).map((m) => m.role)).toEqual(["system", "user", "assistant", "assistant"]);
    const t = jsonlLineToTrace(l); expect(t.warnings).toEqual([]); expect(schemas.check("trace", t.trace)).toEqual([]);
    await expect(pullLangfuse({ fetch: f, env: {} })).rejects.toThrow(/LANGFUSE_PUBLIC_KEY/);
  });
  it("Braintrust: groups events by root span and maps llm and tool spans", async () => {
    const events = [
      { id: "r1", span_id: "r1", root_span_id: "r1", created: "2026-10-27T10:00:00Z", input: "Invoice please", output: "Sent.", metadata: { persona: "business" } },
      { id: "l1", span_id: "l1", root_span_id: "r1", created: "2026-10-27T10:00:01Z", span_attributes: { type: "llm", name: "chat" }, input: [{ role: "user", content: "Invoice please" }], output: { role: "assistant", content: "", tool_calls: [{ id: "x", function: { name: "fetch_invoices", arguments: "{\"account_id\":\"acc_1\"}" } }] }, metadata: { model: "claude-sonnet-5-5" }, metrics: { tokens: 300 } },
      { id: "t1", span_id: "t1", root_span_id: "r1", created: "2026-10-27T10:00:02Z", span_attributes: { type: "tool", name: "fetch_invoices" }, input: { account_id: "acc_1" }, output: [{ id: "inv_1" }] },
      { id: "l2", span_id: "l2", root_span_id: "r1", created: "2026-10-27T10:00:03Z", span_attributes: { type: "llm", name: "chat" }, input: [{ role: "user", content: "Invoice please" }], output: { role: "assistant", content: "Sent." }, metadata: { model: "claude-sonnet-5-5" } },
    ];
    const f = fakeFetch({ "/v1/project_logs/proj_1/fetch": { events, cursor: null } });
    const r = await pullBraintrust({ fetch: f, env: { BRAINTRUST_API_KEY: "k", BRAINTRUST_PROJECT_ID: "proj_1" } });
    expect(r.lines.length).toBe(1); const l = r.lines[0]!;
    expect(l.id).toBe("r1"); expect(l.output).toBe("Sent."); expect((l.tool_calls as any[])[0]).toMatchObject({ name: "fetch_invoices", result: [{ id: "inv_1" }] });
    const t = jsonlLineToTrace(l); expect(schemas.check("trace", t.trace)).toEqual([]);
    expect(braintrustLine("r1", events).model).toBe("claude-sonnet-5-5"); expect(langfuseLine(lfTrace, []).output).toBe("Refunded.");
  });
});

describe("sampler", () => {
  let repo: string; let evals: string;
  beforeAll(() => { repo = mkdtempSync(join(tmpdir(), "litmustest-smp-")); evals = join(repo, "evals"); cpSync(EXAMPLE, evals, { recursive: true }); cpSync(JSONL, join(repo, "support.jsonl")); writeFileSync(join(evals, "litmustest.yaml"), readFileSync(join(evals, "litmustest.yaml"), "utf8").replace(/path: .*support\.jsonl/, "path: support.jsonl").replace("every: manual", "every: weekly")); });
  it("isDue and lastBatch", () => {
    expect(isDue("manual", undefined, new Date())).toBe(false);
    expect(isDue("weekly", undefined, new Date())).toBe(true);
    expect(isDue("weekly", "2026-10-27T13:00:00Z", new Date("2026-10-30T00:00:00Z"))).toBe(false);
    expect(isDue("weekly", "2026-10-27T13:00:00Z", new Date("2026-11-04T00:00:00Z"))).toBe(true);
    expect(isDue("daily", "2026-10-27T13:00:00Z", new Date("2026-10-28T13:30:00Z"))).toBe(true);
    expect(lastBatch(evals)!.name).toBe("2026-10-27");
  });
  it("skips when nothing is new, samples when new lines arrive, honours --if-due", async () => {
    const none = await sample({ evalsDir: evals, cwd: repo, now: new Date("2026-11-05T00:00:00Z") });
    expect(none.skipped).toMatch(/no new traces/);
    const fresh = Array.from({ length: 30 }, (_, i) => JSON.stringify({ id: `tr_new_${i}`, input: `New complaint ${i} about a duplicate charge`, output: `Refunded ${i}.`, timestamp: "2026-11-01T00:00:00Z" })).join("\n") + "\n";
    writeFileSync(join(repo, "support.jsonl"), readFileSync(join(repo, "support.jsonl"), "utf8") + fresh);
    const early = await sample({ evalsDir: evals, cwd: repo, ifDue: true, now: new Date("2026-10-28T00:00:00Z") });
    expect(early.skipped).toMatch(/not due/);
    const r = await sample({ evalsDir: evals, cwd: repo, ifDue: true, size: 10, clusters: 3, now: new Date("2026-11-05T00:00:00Z") });
    expect(r.batch).toBe("2026-11-05"); expect(r.fresh).toBe(30); expect(r.pulled).toBe(330);
    expect(existsSync(join(evals, "batches", "2026-11-05.yaml"))).toBe(true);
    expect(readFileSync(join(evals, "batches", "2026-11-05.yaml"), "utf8")).toContain("source: ");
    expect(readdirSync(join(evals, "datasets", "traces")).filter((f) => f.startsWith("tr_new_")).length).toBe(30);
    expect(lastBatch(evals)!.name).toBe("2026-11-05");
  });
});

describe("graduation and doctor", () => {
  let repo: string; let evals: string; let app: App; let srv: Running;
  beforeAll(async () => {
    repo = mkdtempSync(join(tmpdir(), "litmustest-grad-")); evals = join(repo, "evals"); cpSync(EXAMPLE, evals, { recursive: true });
    for (const f of readdirSync(join(evals, "runs"))) execFileSync("rm", [join(evals, "runs", f)]);
    writeFileSync(join(evals, "litmustest.yaml"), readFileSync(join(evals, "litmustest.yaml"), "utf8").replace(/command: .*\n(\s+\{trial_dir\}\n)?/, `command: node ${FAKE}\n`));
    writeFileSync(join(repo, ".gitignore"), ".litmustest/\n"); git(repo, "init", "-q", "-b", "main");
    const judge = async () => JSON.stringify({ critique: "", result: "Pass" });
    for (const id of ["g1", "g2", "g3"]) await run({ evalsDir: evals, tasks: ["vat_invoice_business", "vat_invoice_frustrated", "cancel_monthly_first_time"], trials: 2, judgeAsk: judge, runId: `run_${id}` });
    git(repo, "add", "-A"); git(repo, "commit", "-q", "-m", "runs");
    app = new App(evals); srv = await serve({ evalsDir: evals, port: 0, watch: false });
  });
  it("proposes capability tasks that passed every trial for three runs", () => {
    const g = graduationProposals(evals);
    expect(g.runs_considered).toEqual(["run_g1", "run_g2", "run_g3"]);
    const ids = g.proposals.map((p) => p.task);
    expect(ids).toContain("vat_invoice_business"); expect(ids).toContain("vat_invoice_frustrated");
    expect(g.proposals[0]!.trials).toBe(6);
    expect(graduationProposals(evals, { runs: 4 }).proposals).toEqual([]);
  });
  it("applies a graduation as pending edits to the task and both suite lists", () => {
    const r = applyGraduations(app, ["vat_invoice_business", "nope"]);
    expect(r.moved).toEqual(["vat_invoice_business"]); expect(r.refused[0]!.task).toBe("nope");
    const task = readFileSync(join(evals, "tasks", "capability", "vat_invoice_business.yaml"), "utf8");
    expect(task).toContain("suite: regression"); expect(task).toContain("graduated_from: capability");
    expect(readFileSync(join(evals, "suites", "regression.yaml"), "utf8")).toContain("vat_invoice_business");
    expect(readFileSync(join(evals, "suites", "capability.yaml"), "utf8")).not.toContain("- vat_invoice_business");
    expect(app.validate(true).errors).toBe(0);
    expect(app.pending.state().files.length).toBe(3);
  });
  it("doctor and the tasks route surface the health", async () => {
    const d = doctor(evals);
    expect(d.alerts.some((a) => a.kind === "Graduation")).toBe(true); expect(d.next.length).toBeGreaterThan(10);
    const api = async (p: string) => (await fetch(srv.url + p)).json();
    const t = await api("/api/tasks");
    expect(t.suites.map((s: any) => s.name).sort()).toEqual(["capability", "quality", "regression"]);
    const vb = t.tasks.find((x: any) => x.id === "vat_invoice_business"); expect(vb.suite).toBe("regression"); expect(vb.graduated_from).toBe("capability"); expect(vb.history.filter(Boolean).length).toBe(3);
    expect((await api("/api/doctor")).alerts.length).toBeGreaterThan(0);
    expect((await api("/api/graduate")).proposals.some((p: any) => p.task === "vat_invoice_frustrated")).toBe(true);
    await srv.close();
  });
});
