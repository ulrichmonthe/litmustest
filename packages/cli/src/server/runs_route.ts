// Runs started from the dashboard (docs/stories/redesign.md, N1; design/mockups/v2/RunningP, RunStoppedP).
// The same runner as `litmustest run`, started in the server's process: one run at a time, progress pushed to the
// dashboard as "run" events, a cancel that stops running trials and saves nothing, and the budget stop the runner
// already has. Only the local server starts runs: hosted mode refuses, because a run executes the repository's agent.
import type { JudgeAsk } from "../judge_run.ts";
import { run, RunCancelled, type TrialResult } from "../run.ts";
import { HttpError, type App } from "./app.ts";
import { loadFiles } from "./overview.ts";

type Obj = Record<string, unknown>;
interface Reply { status: number; body: unknown }
type Dot = "pass" | "fail" | "infra" | null;
export interface RunJob {
  run_id: string; state: "running" | "done" | "budget" | "cancelled" | "failed"; cancelling: boolean;
  scope: { suites: string[]; tasks: string[]; trials: number | null };
  started_at: string; finished_at: string | null; total: number; done: number; infra: number;
  spent_usd: number; budget_usd: number | null; tasks: { id: string; suite: string; dots: Dot[] }[];
  error: string | null; warnings: string[];
}

const jobs = new WeakMap<App, { job: RunJob; abort: AbortController }>();
const strings = (v: unknown) => (Array.isArray(v) ? v.map(String).filter(Boolean) : []);

/** The current or last run started from this server, or null. */
export function activeRun(app: App): Reply { return { status: 200, body: { job: jobs.get(app)?.job ?? null } }; }

export function startRun(app: App, body: Obj, hooks: { judgeAsk?: JudgeAsk; hosted?: unknown }): Reply {
  if (hooks.hosted) throw new HttpError(403, "runs start only from the local dashboard (litmustest serve on your machine), never from hosted mode");
  const cur = jobs.get(app);
  if (cur?.job.state === "running") throw new HttpError(409, `${cur.job.run_id} is still running; cancel it or wait for it to finish`);
  const f = loadFiles(app.evalsDir); const runs = (f.config.runs as Obj | undefined) ?? {};
  if (!(f.config.agent as Obj | undefined)?.command) throw new HttpError(400, "no agent command: set agent.command in litmustest.yaml, then start the run again");
  const suites = strings(body.suites); const only = strings(body.tasks);
  const trials = body.trials === undefined || body.trials === null ? null : Number(body.trials);
  if (trials !== null && (!Number.isInteger(trials) || trials < 1 || trials > 50)) throw new HttpError(400, "trials must be a whole number from 1 to 50");
  for (const s of suites) if (!f.suites.some((x) => x.name === s)) throw new HttpError(400, `no suite ${s}`);
  for (const t of only) if (!f.tasks.some((x) => x.id === t)) throw new HttpError(400, `no task ${t}`);
  const names = suites.length ? suites : f.suites.map((s) => String(s.name));
  const tasks = f.tasks.filter((t) => names.includes(String(t.suite)) && (!only.length || only.includes(String(t.id))));
  if (!tasks.length) throw new HttpError(400, "nothing to run: no task matches");
  const perTask = (t: Obj) => trials ?? Number(t.trials ?? runs.trials ?? 5);
  const now = new Date();
  const runId = `run_${now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "").replace("T", "_").toLowerCase()}`;
  const job: RunJob = {
    run_id: runId, state: "running", cancelling: false, scope: { suites, tasks: only, trials },
    started_at: now.toISOString(), finished_at: null, total: tasks.reduce((a, t) => a + perTask(t), 0), done: 0, infra: 0,
    spent_usd: 0, budget_usd: Number(runs.budget_usd ?? 0) || null,
    tasks: tasks.map((t) => ({ id: String(t.id), suite: String(t.suite), dots: Array.from({ length: perTask(t) }, () => null) })),
    error: null, warnings: [],
  };
  const abort = new AbortController(); jobs.set(app, { job, abort });
  const tell = () => app.emit({ type: "run", job });
  const onProgress = (e: { task: string; n: number; total: number; done: number; result?: TrialResult }) => {
    job.done = e.done; job.total = e.total;
    const row = job.tasks.find((x) => x.id === e.task);
    if (row && e.result) { row.dots[e.n - 1] = e.result.infra_error ? "infra" : e.result.pass ? "pass" : "fail"; if (e.result.infra_error) job.infra++; job.spent_usd = +(job.spent_usd + (e.result.cost_usd ?? 0)).toFixed(4); }
    tell();
  };
  run({ evalsDir: app.evalsDir, suites: suites.length ? suites : undefined, tasks: only.length ? only : undefined, trials: trials ?? undefined, judgeAsk: hooks.judgeAsk, runId, now, onProgress, signal: abort.signal })
    .then((r) => { job.state = (r.summary.budget as Obj | undefined) ? "budget" : "done"; job.warnings = r.warnings; })
    .catch((e: unknown) => { if (e instanceof RunCancelled) job.state = "cancelled"; else { job.state = "failed"; job.error = (e as Error).message; } })
    .finally(() => { job.cancelling = false; job.finished_at = new Date().toISOString(); app.invalidate(); tell(); app.emit({ type: "changed", path: `runs/${runId}.json` }); });
  tell();
  return { status: 202, body: { job } };
}

export function cancelRun(app: App): Reply {
  const cur = jobs.get(app);
  if (!cur || cur.job.state !== "running") throw new HttpError(409, "no run is running");
  cur.job.cancelling = true; cur.abort.abort(); app.emit({ type: "run", job: cur.job });
  return { status: 202, body: { job: cur.job } };
}
