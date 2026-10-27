import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { run } from "../packages/cli/src/run.ts";
import { serve, type Running } from "../packages/cli/src/serve.ts";
import { traceFromTrial } from "../packages/cli/src/server/transcripts.ts";
import { SchemaSet } from "../packages/cli/src/schemas.ts";
vi.setConfig({ testTimeout: 120_000 });

const EXAMPLE = join(import.meta.dirname, "..", "examples", "support-agent", "evals");
const FAKE = join(import.meta.dirname, "fixtures", "agents", "fake_agent.mjs");
const git = (cwd: string, ...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd, encoding: "utf8" }).trim();
let repo: string; let evals: string; let srv: Running;
const api = async (path: string, init?: RequestInit) => { const r = await fetch(srv.url + path, { ...init, headers: { "content-type": "application/json" } }); return { status: r.status, body: await r.json() }; };

beforeAll(async () => {
  repo = mkdtempSync(join(tmpdir(), "litmustest-tr-")); evals = join(repo, "evals");
  cpSync(EXAMPLE, evals, { recursive: true });
  for (const f of readdirSync(join(evals, "runs"))) execFileSync("rm", [join(evals, "runs", f)]);
  writeFileSync(join(evals, "litmustest.yaml"), readFileSync(join(evals, "litmustest.yaml"), "utf8").replace(/command: .*\n(\s+\{trial_dir\}\n)?/, `command: node ${FAKE}\n`));
  writeFileSync(join(repo, ".gitignore"), ".litmustest/\n");
  git(repo, "init", "-q", "-b", "main"); git(repo, "add", "-A"); git(repo, "commit", "-q", "-m", "seed");
  await run({ evalsDir: evals, tasks: ["duplicate_charge_business", "refund_ghost_account_frustrated", "duplicate_charge_first_time"], trials: 2, judgeAsk: async () => JSON.stringify({ critique: "tone fits", result: "Pass" }), runId: "run_x" });
  git(repo, "add", "-A"); git(repo, "commit", "-q", "-m", "run");
  srv = await serve({ evalsDir: evals, port: 0, watch: false });
});
afterAll(async () => { await srv.close(); });

describe("transcripts API", () => {
  it("lists the run's tasks with per-trial dots, failing first", async () => {
    const r = await api("/api/transcripts");
    expect(r.body.run.run_id).toBe("run_x"); expect(r.body.tasks.length).toBe(3);
    expect(r.body.tasks[0].id).toBe("refund_ghost_account_frustrated"); expect(r.body.tasks[0].trials[0].available).toBe(true);
  });
  it("reads a trial with its view, grades pinned to steps, outcome diff and a triage suggestion", async () => {
    const r = await api("/api/transcripts/run_x/refund_ghost_account_frustrated/1");
    expect(r.status).toBe(200); expect(r.body.view.turns.length).toBeGreaterThan(1);
    const g = r.body.grades.find((x: any) => x.check === "end_state"); expect(g.pass).toBe(false); expect(typeof g.step).toBe("number");
    const o = r.body.outcome.find((x: any) => x.path === "refunds.status"); expect(o.expected).toBe("processed"); expect(o.actual).toBe("none"); expect(o.reference).toBe("processed");
    expect(["agent", "grader", "task", "infra"]).toContain(r.body.triage_suggested);
    expect((await api("/api/transcripts/run_x/nope/1")).status).toBe(404);
  });
  it("confirms or overrides the triage into the run summary via the validated path", async () => {
    const r = await api("/api/transcripts/run_x/refund_ghost_account_frustrated/1/triage", { method: "POST", body: JSON.stringify({ verdict: "task", by: "ulrich", note: "ghost account" }) });
    expect(r.status).toBe(200);
    const summary = JSON.parse(readFileSync(join(evals, "runs", "run_x.json"), "utf8"));
    expect(summary.tasks.refund_ghost_account_frustrated.trials[0].triage).toMatchObject({ verdict: "task", by: "ulrich", note: "ghost account" });
    expect((await api("/api/pending")).body.files.some((f: any) => f.path.endsWith("run_x.json"))).toBe(true);
    expect((await api("/api/transcripts/run_x/refund_ghost_account_frustrated/1/triage", { method: "POST", body: JSON.stringify({ verdict: "weird" }) })).status).toBe(400);
  });
  it("disputing a judge verdict writes the trial as a trace and appends a label for the judge's failure mode", async () => {
    const r = await api("/api/transcripts/run_x/duplicate_charge_business/1/dispute", { method: "POST", body: JSON.stringify({ check: "tone", label: "Fail", note: "actually breezy", annotator: "ulrich" }) });
    expect(r.status).toBe(200); expect(r.body.failure_mode).toBe("tone_mismatch"); expect(r.body.trace_id).toBe("trial_run_x_duplicate_charge_business_1");
    expect(existsSync(join(evals, "datasets", "traces", "trial_run_x_duplicate_charge_business_1.json"))).toBe(true);
    const labels = readFileSync(join(evals, "labels", "disputes-run_x.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(labels[0]).toMatchObject({ trace_id: "trial_run_x_duplicate_charge_business_1", failure_mode: "tone_mismatch", label: "Fail", annotator: "ulrich" });
    expect((await api("/api/traces/trial_run_x_duplicate_charge_business_1")).body.view.calls.length).toBeGreaterThan(0);
    expect((await api("/api/transcripts/run_x/duplicate_charge_business/1/dispute", { method: "POST", body: JSON.stringify({ check: "end_state", label: "Pass" }) })).status).toBe(400);
    expect((await api("/api/validate?refresh=1")).body.errors).toBe(0);
  });
  it("traceFromTrial produces a valid trace with tool spans under the right turn", () => {
    const t = traceFromTrial({ input: "hi", output: "done", transcript: [{ role: "user", content: "hi" }, { role: "tool", tool: "verify_identity", content: "{}" }, { role: "agent", content: "done" }], tool_calls: [{ name: "verify_identity", args: { email: "x" }, result: { verified: true } }] }, "trial_a_b_1", { run: "a" });
    expect(new SchemaSet().check("trace", t)).toEqual([]);
    expect((t.spans as any[]).filter((s) => s.name.startsWith("execute_tool")).length).toBe(1);
  });
});
