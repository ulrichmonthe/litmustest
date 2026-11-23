// N1 (docs/stories/redesign.md): runs started from the dashboard. The same runner as `litmustest run`, one at a time,
// progress as "run" events, a cancel that stops running trials and saves nothing, and the budget stop. Also the local
// server's request guard, which keeps other websites from starting runs or writing files through it.
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { serve, type Running } from "../packages/cli/src/serve.ts";
import { startRun, type RunJob } from "../packages/cli/src/server/runs_route.ts";

const EXAMPLE = join(import.meta.dirname, "..", "examples", "support-agent", "evals");
const FAKE = join(import.meta.dirname, "fixtures", "agents", "fake_agent.mjs");
const git = (cwd: string, ...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd, encoding: "utf8" });
const TASKS = ["duplicate_charge_business", "refund_ghost_account_frustrated", "duplicate_charge_first_time"];

function repoWith(runs: { concurrency?: number; budget?: number }): string {
  const repo = mkdtempSync(join(tmpdir(), "litmustest-runs-")); const evals = join(repo, "evals");
  cpSync(EXAMPLE, evals, { recursive: true });
  for (const f of readdirSync(join(evals, "runs"))) rmSync(join(evals, "runs", f));
  const cfg = join(evals, "litmustest.yaml");
  writeFileSync(cfg, readFileSync(cfg, "utf8").replace(/command: .*\n(\s+\{trial_dir\}\n)?/, `command: node ${FAKE}\n`)
    .replace(/^ {2}concurrency: \d+$/m, `  concurrency: ${runs.concurrency ?? 4}`).replace(/^ {2}budget_usd: [\d.]+$/m, `  budget_usd: ${runs.budget ?? 10}`));
  writeFileSync(join(repo, ".gitignore"), ".litmustest/\n");
  git(repo, "init", "-q", "-b", "main"); git(repo, "add", "-A"); git(repo, "commit", "-q", "-m", "seed");
  return repo;
}
const servers: Running[] = [];
afterAll(async () => { for (const s of servers) { const c = s.close(); s.server.closeAllConnections(); await c; } });
afterEach(() => { delete process.env.FAKE_HANG; });
async function start(runs: { concurrency?: number; budget?: number } = {}) {
  const repo = repoWith(runs);
  const s = await serve({ evalsDir: join(repo, "evals"), port: 0, watch: false, judgeAsk: async () => JSON.stringify({ critique: "tone fits", result: "Pass" }) }); servers.push(s);
  const post = async (path: string, body: unknown) => { const r = await fetch(s.url + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); return { status: r.status, body: (await r.json()) as { job: RunJob; message?: string } }; };
  const active = async () => ((await (await fetch(s.url + "/api/runs/active")).json()) as { job: RunJob | null }).job;
  const until = async (state: string, ms = 30_000) => { const t0 = Date.now(); for (;;) { const j = await active(); if (j && j.state === state) return j; if (Date.now() - t0 > ms) throw new Error(`run still ${j?.state}`); await new Promise((r) => setTimeout(r, 100)); } };
  return { repo, s, post, active, until };
}

describe("a run started from the dashboard", () => {
  it("runs, reports each trial as it finishes, refuses a second start meanwhile, and writes its summary", async () => {
    const { repo, s, post, until } = await start({ concurrency: 1 });
    const events: RunJob[] = []; s.app.subscribe((e) => { if (e.type === "run") events.push(JSON.parse(JSON.stringify(e.job))); });
    const r = await post("/api/runs/start", { tasks: TASKS, trials: 2 });
    expect(r.status, JSON.stringify(r.body)).toBe(202);
    expect(r.body.job).toMatchObject({ state: "running", total: 6, done: 0 });
    expect(r.body.job.tasks.map((t) => t.dots.length)).toEqual([2, 2, 2]);
    expect((await post("/api/runs/start", { tasks: TASKS })).status).toBe(409);
    const j = await until("done");
    expect(j.done).toBe(6);
    expect(j.tasks.flatMap((t) => t.dots).every((d) => d !== null)).toBe(true);
    expect(j.tasks.find((t) => t.id === "refund_ghost_account_frustrated")!.dots).toEqual(["fail", "fail"]);
    expect(events.filter((e) => e.state === "running").map((e) => e.done)).toEqual(expect.arrayContaining([1, 2, 3, 4, 5, 6]));
    expect(existsSync(join(repo, "evals", "runs", `${j.run_id}.json`))).toBe(true);
  }, 60_000);

  it("cancel stops a trial that would hang, at once, and saves nothing", async () => {
    const { repo, post, until } = await start({ concurrency: 1 });
    process.env.FAKE_HANG = "duplicate_charge_business";
    const r = await post("/api/runs/start", { tasks: ["duplicate_charge_business"], trials: 1 });
    expect(r.status).toBe(202);
    await new Promise((res) => setTimeout(res, 500));
    const t0 = Date.now();
    expect((await post("/api/runs/active/cancel", {})).status).toBe(202);
    const j = await until("cancelled", 15_000);
    expect(Date.now() - t0).toBeLessThan(10_000); // killed, not left to the 10-minute timeout
    expect(existsSync(join(repo, "evals", "runs", `${j.run_id}.json`))).toBe(false);
    expect(existsSync(join(repo, ".litmustest", "transcripts", j.run_id))).toBe(false);
    expect((await post("/api/runs/active/cancel", {})).status).toBe(409);
  }, 60_000);

  it("stops at the budget and says so", async () => {
    const { post, until } = await start({ concurrency: 1, budget: 0.01 });
    expect((await post("/api/runs/start", { tasks: TASKS, trials: 2 })).status).toBe(202);
    const j = await until("budget");
    expect(j.done).toBeLessThan(6); expect(j.budget_usd).toBe(0.01); expect(j.spent_usd).toBeGreaterThanOrEqual(0.01);
  }, 60_000);

  it("refuses what it cannot run, and never starts from hosted mode", async () => {
    const { post, s } = await start();
    expect((await post("/api/runs/start", { tasks: ["no_such_task"] })).status).toBe(400);
    expect((await post("/api/runs/start", { suites: ["nope"] })).status).toBe(400);
    expect((await post("/api/runs/start", { trials: 0 })).status).toBe(400);
    expect(() => startRun(s.app, {}, { hosted: {} })).toThrow(/local dashboard/);
  }, 30_000);
});

describe("the local server answers only its own dashboard", () => {
  const raw = (url: string, o: { method: string; host?: string; origin?: string; type?: string }) => new Promise<number>((res, rej) => {
    const u = new URL(url);
    const req = request({ host: u.hostname, port: u.port, path: u.pathname, method: o.method, headers: { host: o.host ?? u.host, ...(o.origin ? { origin: o.origin } : {}), ...(o.type ? { "content-type": o.type } : {}) } }, (r) => { r.resume(); res(r.statusCode!); });
    req.on("error", rej); req.end(o.method === "GET" ? undefined : "{}");
  });
  it("refuses writes from another site or not sent as JSON, and any request addressed to another host", async () => {
    const { s } = await start();
    const start_ = `${s.url}/api/runs/start`;
    expect(await raw(start_, { method: "POST", type: "text/plain" })).toBe(403); // a cross-site form can send this without asking
    expect(await raw(start_, { method: "POST", type: "application/json", origin: "https://evil.example" })).toBe(403);
    expect(await raw(start_, { method: "POST", type: "application/json", origin: "null" })).toBe(403);
    expect(await raw(`${s.url}/api/health`, { method: "GET", host: "evil.example:4242" })).toBe(403); // DNS rebinding
    expect(await raw(`${s.url}/api/health`, { method: "GET" })).toBe(200);
    expect(await raw(`${s.url}/api/runs/active/cancel`, { method: "POST", type: "application/json", origin: s.url })).toBe(409); // its own origin passes the guard
  }, 30_000);
});
