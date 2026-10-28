// litmustest run: k trials per task in a clean trial directory, graded by the task's checks, scored with error bars,
// written as a run summary under evals/runs/ with raw transcripts in the configured store.
import { computeCoverage, coverageSnapshot } from "./coverage.ts";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { SchemaSet } from "./schemas.ts";
import { sha256 } from "./validate.ts";
import { labelsFor } from "./calibrate.ts";
import { buildMessages, defaultJudgeAsk, loadJudge, parseVerdict, type JudgeAsk, type JudgeFiles } from "./judge_run.ts";
import { passRateWithJudgeError, type Matrix } from "./stats.ts";
import { judgeStatus, loadFiles } from "./server/overview.ts";
import type { TraceView } from "./trace_view.ts";

type Obj = Record<string, unknown>;
export interface Grade { check: string; type: string; pass: boolean | null; reason: string; weight: number; failure_mode?: string; step?: number; critique?: string; verdict?: string; excluded?: string }
export interface TrialResult { task: string; n: number; pass: boolean; failed_checks: string[]; unknown_checks: string[]; excluded_checks: string[]; infra_error: boolean; infra_error_kind?: "timeout" | "oom" | "harness" | "network" | "other"; infra_message?: string; tokens?: number; latency_ms?: number; cost_usd?: number; transcript_ref: string; grades: Grade[]; weighted: number | null; dir: string }
export interface RunOptions { evalsDir: string; suites?: string[]; tasks?: string[]; trials?: number; concurrency?: number; judgeAsk?: JudgeAsk; runId?: string; now?: Date; python?: string; onProgress?: (e: { task: string; n: number; total: number; done: number; result?: TrialResult }) => void; dryRun?: boolean; agentCommand?: string; timeoutMs?: number }
export interface RunResult { run_id: string; path: string; summary: Obj; trials: TrialResult[]; transcripts_dir: string; warnings: string[]; gates?: Obj }

const nowIso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, "Z");

/** Split a command line on spaces, respecting single and double quotes. No shell. */
export function splitCommand(cmd: string): string[] {
  const out: string[] = []; let cur = ""; let q: string | null = null; let had = false;
  for (const ch of cmd) {
    if (q) { if (ch === q) q = null; else cur += ch; continue; }
    if (ch === '"' || ch === "'") { q = ch; had = true; continue; }
    if (/\s/.test(ch)) { if (cur || had) { out.push(cur); cur = ""; had = false; } continue; }
    cur += ch;
  }
  if (cur || had) out.push(cur);
  return out;
}
export function getPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const part of path.split(".")) { const m = /^([A-Za-z0-9_]+)(?:\[(\d+)\])?$/.exec(part); if (!m || cur === null || typeof cur !== "object") return undefined; cur = (cur as Obj)[m[1]!]; if (m[2] !== undefined) cur = Array.isArray(cur) ? cur[Number(m[2])] : undefined; }
  return cur;
}
/** A trial in the reference-solution shape becomes the view a judge or the transcript page reads. */
export function viewFromTrial(trial: Obj, id: string): TraceView {
  const turns = ((trial.transcript as Obj[]) ?? []).map((t) => ({ role: (t.role === "assistant" ? "agent" : t.role) as "user" | "agent" | "tool" | "system", content: String(t.content ?? ""), ...(t.tool ? { tool: String(t.tool) } : {}) }));
  const calls = ((trial.tool_calls as Obj[]) ?? []).map((c, i) => ({ name: String(c.name), args: c.args, result: c.result, ok: !(c.result && typeof c.result === "object" && "error" in (c.result as Obj)), span_id: `call_${i}` }));
  if (!turns.length) { if (trial.input) turns.push({ role: "user", content: typeof trial.input === "string" ? trial.input : JSON.stringify(trial.input) }); if (trial.output) turns.push({ role: "agent", content: String(trial.output) }); }
  return { id, turns, calls, model: undefined, input_tokens: Number((trial.usage as Obj)?.input_tokens ?? 0), output_tokens: Number((trial.usage as Obj)?.output_tokens ?? 0), metadata: {} };
}

async function execAgent(cmd: string[], env: Record<string, string>, cwd: string, timeoutMs: number): Promise<{ code: number | null; signal: string | null; stdout: string; stderr: string; timedOut: boolean; ms: number }> {
  return new Promise((resolveP) => {
    const started = Date.now(); let stdout = "", stderr = ""; let timedOut = false;
    const child = spawn(cmd[0]!, cmd.slice(1), { cwd, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timeoutMs);
    child.stdout.on("data", (d) => (stdout += d)); child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (e) => { clearTimeout(timer); resolveP({ code: null, signal: null, stdout, stderr: stderr + `\n${e.message}`, timedOut, ms: Date.now() - started }); });
    child.on("close", (code, signal) => { clearTimeout(timer); resolveP({ code, signal, stdout: stdout.slice(-20000), stderr: stderr.slice(-20000), timedOut, ms: Date.now() - started }); });
  });
}

export async function run(o: RunOptions): Promise<RunResult> {
  const evalsDir = resolve(o.evalsDir); const repo = dirname(evalsDir);
  const f = loadFiles(evalsDir); const config = f.config;
  const schemas = new SchemaSet();
  const warnings: string[] = [];
  const agent = (config.agent as Obj | undefined) ?? {};
  const command = o.agentCommand ?? (agent.command as string | undefined);
  if (!command && !o.dryRun) throw new Error("no agent command: set agent.command in litmustest.yaml (see docs/SCHEMAS.md#config)");
  const envName = String((config.runs as Obj | undefined)?.environment ?? "inprocess");
  if (envName !== "inprocess") throw new Error(`runs.environment '${envName}' is not implemented yet (decision #2); use inprocess`);
  const trialsDefault = o.trials ?? Number((config.runs as Obj | undefined)?.trials ?? 5);
  const concurrency = o.concurrency ?? Number((config.runs as Obj | undefined)?.concurrency ?? 4);
  const timeoutMs = o.timeoutMs ?? 1000 * Number(((config.runs as Obj | undefined)?.resources as Obj | undefined)?.timeout_s ?? 600);
  const threshold = Number((config.judges as Obj | undefined)?.trust_threshold ?? 90);
  const now = o.now ?? new Date();
  const runId = o.runId ?? `run_${now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "").replace("T", "_").toLowerCase()}`;
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(runId)) throw new Error(`run id '${runId}' must match ^[a-z0-9][a-z0-9_-]*$`);
  const suiteNames = o.suites?.length ? o.suites : f.suites.map((s) => String(s.name));
  for (const s of suiteNames) if (!f.suites.some((x) => x.name === s)) throw new Error(`no suite '${s}' under suites/`);
  const tasks = f.tasks.filter((t) => suiteNames.includes(String(t.suite)) && (!o.tasks?.length || o.tasks.includes(String(t.id))));
  if (!tasks.length) throw new Error(`no tasks in suite${suiteNames.length > 1 ? "s" : ""} ${suiteNames.join(", ")}`);
  const storeRel = String(((config.storage as Obj | undefined)?.transcripts as Obj | undefined)?.path ?? ".litmustest/transcripts");
  const store = resolve(repo, storeRel); const runDir = join(store, runId); mkdirSync(runDir, { recursive: true });

  // judges: load once, decide trust once
  const judgeFiles = new Map<string, { files: JudgeFiles; status: string; matrix?: Matrix; tpr?: number; tnr?: number }>();
  for (const j of f.judges) { if (!j.judge) continue; const s = judgeStatus(j, threshold); const test = (j.calibration?.test as Obj | null) ?? null; judgeFiles.set(j.name, { files: loadJudge(evalsDir, j.name), status: s.status, matrix: s.status === "trusted" && test ? (test.matrix as Matrix) : undefined, tpr: s.tpr, tnr: s.tnr }); }
  const judgeAsk = o.judgeAsk ?? defaultJudgeAsk;
  const labelsCache = new Map<string, Map<string, { label: "Pass" | "Fail"; note?: string }>>();
  const labelsOf = (mode: string) => { if (!labelsCache.has(mode)) labelsCache.set(mode, labelsFor(evalsDir, mode)); return labelsCache.get(mode)!; };

  // the work list
  const work: { task: Obj; n: number }[] = [];
  for (const t of tasks) { const k = o.trials ?? Number(t.trials ?? trialsDefault); for (let n = 1; n <= k; n++) work.push({ task: t, n }); }
  const results: TrialResult[] = []; let next = 0, done = 0;
  const taskFile = (t: Obj) => { const walk = (d: string): string | undefined => { for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); if (e.isDirectory()) { const r = walk(p); if (r) return r; } else if (e.name === `${t.id}.yaml`) return p; } return undefined; }; return walk(join(evalsDir, "tasks")) ?? ""; };

  const worker = async () => {
    while (next < work.length) {
      const w = work[next++]!; const t = w.task; const id = String(t.id);
      const dir = join(runDir, id, String(w.n)); rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true });
      const ref = `local:${runId}/${id}/${w.n}`;
      let result: TrialResult;
      const vars: Record<string, string> = { task: id, task_file: taskFile(t), trial_dir: dir, trial: String(w.n), evals: evalsDir };
      const env: Record<string, string> = { LITMUSTEST_TASK: id, LITMUSTEST_TASK_FILE: vars.task_file!, LITMUSTEST_TRIAL_DIR: dir, LITMUSTEST_TRIAL: String(w.n), LITMUSTEST_INPUT: JSON.stringify(t.input ?? {}), LITMUSTEST_EVALS: evalsDir, LITMUSTEST_RUN: runId, ...((agent.env as Record<string, string>) ?? {}) };
      const fill = (s: string) => s.replace(/\{(task|task_file|trial_dir|trial|evals)\}/g, (_, k) => vars[k]!);
      const cwd = agent.cwd ? resolve(repo, String(agent.cwd)) : repo;
      let trial: Obj | undefined; let infra: Partial<TrialResult> = {};
      if (o.dryRun) { const refPath = join(evalsDir, String(t.reference_solution)); trial = existsSync(refPath) ? JSON.parse(readFileSync(refPath, "utf8")) : undefined; }
      else {
        if (agent.reset) { const r = await execAgent(splitCommand(fill(String(agent.reset))), env, cwd, timeoutMs); if (r.code !== 0) infra = { infra_error: true, infra_error_kind: "harness", infra_message: `reset failed: ${r.stderr.trim().split("\n").pop()}` }; }
        if (!infra.infra_error) {
          const r = await execAgent(splitCommand(fill(command!)), env, cwd, timeoutMs);
          writeFileSync(join(dir, "stdout.txt"), r.stdout); writeFileSync(join(dir, "stderr.txt"), r.stderr);
          infra.latency_ms = r.ms;
          const tp = join(dir, "trial.json");
          if (r.timedOut) infra = { ...infra, infra_error: true, infra_error_kind: "timeout", infra_message: `killed after ${Math.round(timeoutMs / 1000)}s` };
          else if (r.code !== 0) infra = { ...infra, infra_error: true, infra_error_kind: /\bENOMEM\b|out of memory|\bOOM\b/i.test(r.stderr) ? "oom" : /\bECONNRESET\b|\bETIMEDOUT\b|\bENOTFOUND\b|fetch failed|rate limit|\b429\b|\b5\d\d\b/i.test(r.stderr) ? "network" : "harness", infra_message: firstError(r.stderr) ?? `exit ${r.code ?? r.signal}` };
          else if (!existsSync(tp)) infra = { ...infra, infra_error: true, infra_error_kind: "harness", infra_message: "agent exited 0 but wrote no trial.json" };
          else { try { trial = JSON.parse(readFileSync(tp, "utf8")); const errs = schemas.check("reference_solution", { ...trial, task: id }); if (errs.length) infra = { ...infra, infra_error: true, infra_error_kind: "harness", infra_message: `trial.json does not validate: ${errs[0]}` }; } catch (e) { infra = { ...infra, infra_error: true, infra_error_kind: "harness", infra_message: `trial.json unreadable: ${(e as Error).message}` }; } }
        }
      }
      if (infra.infra_error || !trial) {
        result = { task: id, n: w.n, pass: false, failed_checks: [], unknown_checks: [], excluded_checks: [], infra_error: true, infra_error_kind: infra.infra_error_kind ?? "harness", infra_message: infra.infra_message ?? "no trial", latency_ms: infra.latency_ms, transcript_ref: ref, grades: [], weighted: null, dir };
      } else {
        const grades: Grade[] = [];
        const view = viewFromTrial(trial, `trial_${runId}_${id}_${w.n}`);
        for (const c of (t.checks as Obj[]) ?? []) {
          const cid = String(c.id); const weight = Number(c.weight ?? 1); const fm = c.failure_mode as string | undefined;
          const g: Grade = { check: cid, type: String(c.type), pass: null, reason: "", weight, failure_mode: fm };
          try {
            if (c.type === "outcome") { const misses: string[] = []; for (const [path, want] of Object.entries(c.expect as Obj)) { const got = getPath(trial.state, path); if (JSON.stringify(got) !== JSON.stringify(want)) misses.push(`${path}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`); } g.pass = misses.length === 0; g.reason = misses.length ? misses.join("; ") : `end state matches ${Object.keys(c.expect as Obj).join(", ")}`; g.step = view.turns.length - 1; }
            else if (c.type === "transcript") { const names = view.calls.map((x) => x.name); const agentTurns = view.turns.filter((x) => x.role === "agent").length; const why: string[] = []; if (c.max_turns !== undefined && agentTurns > Number(c.max_turns)) why.push(`${agentTurns} agent turns, max ${c.max_turns}`); if (c.max_toolcalls !== undefined && names.length > Number(c.max_toolcalls)) why.push(`${names.length} tool calls, max ${c.max_toolcalls}`); for (const r of (c.required_tools as string[]) ?? []) if (!names.includes(r)) why.push(`required tool ${r} never called`); for (const r of (c.forbidden_tools as string[]) ?? []) if (names.includes(r)) why.push(`forbidden tool ${r} was called`); g.pass = why.length === 0; g.reason = why.length ? why.join("; ") : `${names.length} tool calls within bounds`; g.step = view.turns.length - 1; }
            else if (c.type === "code") { const fn = resolve(evalsDir, String(c.fn)); const script = ["import importlib.util, json, sys", "fn, trial, args = sys.argv[1], json.loads(sys.argv[2]), json.loads(sys.argv[3])", "spec = importlib.util.spec_from_file_location('grader', fn); m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)", "print(json.dumps({'pass': bool(m.check(trial, args))}))"].join("\n"); const res = execSafe(o.python ?? "python3", ["-I", "-c", script, fn, JSON.stringify({ input: t.input, ...trial }), JSON.stringify(c.args ?? {})], repo); if (res.error) { g.pass = false; g.reason = `grader error: ${res.error}`; } else { g.pass = Boolean(res.pass); g.reason = g.pass ? `${String(c.fn).split("/").pop()} returned True` : `${String(c.fn).split("/").pop()} returned False`; } g.step = view.turns.length - 1; }
            else if (c.type === "judge") {
              const jname = String(c.judge ?? fm); const j = judgeFiles.get(jname);
              if (!j) { g.excluded = `judge ${jname} not found`; g.reason = g.excluded; }
              else if (j.status !== "trusted") { g.excluded = `judge ${jname} is ${j.status}`; g.reason = `${g.excluded}; its verdicts do not count`; }
              else { const { system, user } = buildMessages(j.files, evalsDir, view, labelsOf(String(j.files.judge.failure_mode))); let raw = ""; try { raw = await judgeAsk(system, user, String(j.files.judge.model)); } catch (e) { raw = JSON.stringify({ critique: `model error: ${(e as Error).message}`, result: "Unknown" }); } const v = parseVerdict(raw); g.verdict = v.result; g.critique = v.critique; g.pass = v.result === "Pass" ? true : v.result === "Fail" ? false : null; g.reason = v.result === "Unknown" ? "judge answered Unknown; routed to the review queue" : `judge ${jname}: ${v.result}`; g.step = view.turns.length - 1; }
            }
          } catch (e) { g.pass = false; g.reason = `check error: ${(e as Error).message}`; }
          grades.push(g);
        }
        const counted = grades.filter((g) => !g.excluded);
        const failed = counted.filter((g) => g.pass === false).map((g) => g.check);
        const unknown = counted.filter((g) => g.pass === null).map((g) => g.check);
        const scored = counted.filter((g) => g.pass !== null);
        const weighted = scored.length ? +((100 * scored.filter((g) => g.pass).reduce((a, g) => a + g.weight, 0)) / scored.reduce((a, g) => a + g.weight, 0)).toFixed(1) : null;
        const usage = (trial.usage as Obj) ?? {};
        result = { task: id, n: w.n, pass: failed.length === 0 && unknown.length === 0, failed_checks: failed, unknown_checks: unknown, excluded_checks: grades.filter((g) => g.excluded).map((g) => g.check), infra_error: false, tokens: usage.input_tokens !== undefined ? Number(usage.input_tokens) + Number(usage.output_tokens ?? 0) : undefined, latency_ms: trial.latency_ms !== undefined ? Number(trial.latency_ms) : infra.latency_ms, cost_usd: usage.cost_usd !== undefined ? Number(usage.cost_usd) : undefined, transcript_ref: ref, grades, weighted, dir };
        if (o.dryRun) writeFileSync(join(dir, "trial.json"), JSON.stringify(trial, null, 2));
      }
      results.push(result); done++;
      o.onProgress?.({ task: id, n: w.n, total: work.length, done, result });
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, work.length)) }, worker));

  // ---- summary
  const byTask = new Map<string, TrialResult[]>(); for (const r of results) byTask.set(r.task, [...(byTask.get(r.task) ?? []), r].sort((a, b) => a.n - b.n));
  const taskSummaries: Record<string, Obj> = {};
  for (const [id, trs] of byTask) {
    const t = tasks.find((x) => x.id === id)!;
    const scored = trs.filter((r) => !r.infra_error); const passed = scored.filter((r) => r.pass).length;
    const previous = f.runs.filter((p) => (p.tasks as Record<string, Obj>)?.[id]).slice(-2); // the last two runs that ran this task
    const prevAllFail = previous.every((p) => { const pt = (p.tasks as Record<string, Obj>)?.[id]; if (!pt) return false; const tr = (pt.trials as Obj[]).filter((x) => !x.infra_error); return tr.length > 0 && tr.every((x) => !x.pass); });
    const totalTrials = scored.length + previous.reduce((a, p) => a + (((p.tasks as Record<string, Obj>)?.[id]?.trials as Obj[]) ?? []).filter((x) => !x.infra_error).length, 0);
    const likely_broken = passed === 0 && scored.length > 0 && previous.length >= 2 && prevAllFail && totalTrials >= 15;
    const weights = scored.map((r) => r.weighted).filter((w): w is number => w !== null);
    taskSummaries[id] = { suite: t.suite, strict_pass: scored.length ? +((100 * passed) / scored.length).toFixed(1) : 0, weighted: weights.length ? +(weights.reduce((a, b) => a + b, 0) / weights.length).toFixed(1) : 0, ...(passed > 0 && passed < scored.length ? { flaky: true } : {}), ...(likely_broken ? { likely_broken: true } : {}),
      trials: trs.map((r) => ({ pass: r.pass, failed_checks: r.failed_checks, ...(r.unknown_checks.length ? { unknown_checks: r.unknown_checks } : {}), ...(r.excluded_checks.length ? { excluded_checks: r.excluded_checks } : {}), infra_error: r.infra_error, ...(r.infra_error ? { infra_error_kind: r.infra_error_kind } : {}), ...(r.tokens !== undefined ? { tokens: r.tokens } : {}), ...(r.latency_ms !== undefined ? { latency_ms: Math.round(r.latency_ms) } : {}), ...(r.cost_usd !== undefined ? { cost_usd: r.cost_usd } : {}), transcript_ref: r.transcript_ref })) };
  }
  const suites: Record<string, Obj> = {}; const excludedAll = new Set<string>();
  for (const s of suiteNames) {
    const ids = tasks.filter((t) => t.suite === s).map((t) => String(t.id)); if (!ids.length) continue;
    const trs = ids.flatMap((id) => byTask.get(id) ?? []); const scored = trs.filter((r) => !r.infra_error);
    for (const r of trs) for (const c of r.excluded_checks) { const chk = ((tasks.find((t) => t.id === r.task)!.checks as Obj[])).find((x) => x.id === c); if (chk) excludedAll.add(String(chk.judge ?? chk.failure_mode)); }
    // the judge used by most checks in this suite lends its confusion matrix to the bootstrap
    const judgeUse = new Map<string, number>(); for (const id of ids) for (const c of (tasks.find((t) => t.id === id)!.checks as Obj[])) if (c.type === "judge") { const jn = String(c.judge ?? c.failure_mode); if (judgeFiles.get(jn)?.matrix) judgeUse.set(jn, (judgeUse.get(jn) ?? 0) + 1); }
    const topJudge = [...judgeUse.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    const outcomes = scored.map((r) => r.pass);
    const pr = passRateWithJudgeError(outcomes, topJudge ? { matrix: judgeFiles.get(topJudge)!.matrix! } : undefined);
    const k = Math.max(...ids.map((id) => (byTask.get(id) ?? []).length), 1);
    const allPass = ids.filter((id) => { const tr = (byTask.get(id) ?? []).filter((r) => !r.infra_error); return tr.length > 0 && tr.every((r) => r.pass); }).length;
    const judgeVerdicts = scored.flatMap((r) => r.grades.filter((g) => g.type === "judge" && !g.excluded)); const unknownRate = judgeVerdicts.length ? +((100 * judgeVerdicts.filter((g) => g.pass === null).length) / judgeVerdicts.length).toFixed(1) : 0;
    suites[s] = { pass_rate: pr.rate, ci: pr.ci, pass_at_1: scored.length ? +((100 * scored.filter((r) => r.pass).length) / scored.length).toFixed(1) : 0, pass_hat_k: +((100 * allPass) / ids.length).toFixed(1), k, n_tasks: ids.length, n_trials: trs.length, infra_errors: trs.length - scored.length, unknown_rate: unknownRate, excluded_judges: [...new Set(trs.flatMap((r) => r.excluded_checks.map((c) => { const chk = (tasks.find((t) => t.id === r.task)!.checks as Obj[]).find((x) => x.id === c); return String(chk?.judge ?? chk?.failure_mode ?? c); })))] };
  }
  for (const r of results) { const ts = taskSummaries[r.task]!; writeFileSync(join(r.dir, "grades.json"), JSON.stringify({ run_id: runId, task: r.task, trial: r.n, pass: r.pass, infra_error: r.infra_error, infra_error_kind: r.infra_error_kind, infra_message: r.infra_message, grades: r.grades, triage_suggested: suggestTriage(r, Boolean(ts.likely_broken)) }, null, 2)); }
  let commit = "0000000"; let branch: string | undefined;
  try { commit = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { /* not a repo, or no commits yet */ }
  const infraCount = results.filter((r) => r.infra_error).length;
  const summary: Obj = {
    run_id: runId, commit, ...(branch ? { branch } : {}), started_at: nowIso(now), finished_at: nowIso(new Date()), config_hash: sha256(readFileSync(join(evalsDir, "litmustest.yaml"))), trials: trialsDefault, suite_names: suiteNames, ...(command ? { agent_command: command } : {}),
    suites, tasks: taskSummaries, infra_error_rate: results.length ? +((100 * infraCount) / results.length).toFixed(1) : 0, cost_usd: +results.reduce((a, r) => a + (r.cost_usd ?? 0), 0).toFixed(4),
    judge_corrections: [...judgeFiles.entries()].filter(([, j]) => j.matrix).map(([name, j]) => ({ judge: name, tpr: j.tpr, tnr: j.tnr, prompt_hash: String(j.files.judge.prompt_hash) })),
  };
  try { const snap = coverageSnapshot(computeCoverage(evalsDir, { run: summary })); if (Object.keys(snap).length) summary.coverage = snap; }
  catch (e) { warnings.push(`coverage not recorded: ${(e as Error).message}`); }
  const errs = schemas.check("run_summary", summary);
  if (errs.length) throw new Error(`run summary would not validate: ${errs.join("; ")}`);
  const path = join(evalsDir, "runs", `${runId}.json`); mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(summary, null, 2) + "\n");
  if (excludedAll.size) warnings.push(`judge${excludedAll.size > 1 ? "s" : ""} ${[...excludedAll].join(", ")} excluded: not trusted`);
  if (infraCount) warnings.push(`${infraCount} infra error${infraCount > 1 ? "s" : ""} excluded from the agent's score`);
  return { run_id: runId, path, summary, trials: results, transcripts_dir: runDir, warnings };
}

/** The line that names the error: the first line mentioning an error, else the first non-empty line. */
function firstError(stderr: string): string | undefined {
  const lines = stderr.split("\n").map((l) => l.trim()).filter(Boolean);
  return (lines.find((l) => /error|exception|traceback|panic/i.test(l)) ?? lines[0])?.slice(0, 300);
}

function execSafe(cmd: string, args: string[], cwd: string): { pass?: boolean; error?: string } {
  try { const out = execFileSync(cmd, args, { cwd, encoding: "utf8", timeout: 30_000, stdio: ["ignore", "pipe", "pipe"] }); const last = out.trim().split("\n").pop() ?? ""; return JSON.parse(last) as { pass: boolean }; }
  catch (e) { const err = e as { stderr?: string; message: string }; return { error: (err.stderr ?? err.message).trim().split("\n").pop() ?? "failed" }; }
}

/** Why did this trial fail? infra, task (its reference also fails or it is likely broken), grader (only judge verdicts failed or were Unknown), else agent. */
export function suggestTriage(r: TrialResult, likelyBroken: boolean): "agent" | "grader" | "task" | "infra" {
  if (r.infra_error) return "infra";
  if (r.pass) return "agent";
  if (likelyBroken) return "task";
  const failed = r.grades.filter((g) => g.pass === false); const unknown = r.grades.filter((g) => g.pass === null && !g.excluded);
  if (!failed.length && unknown.length) return "grader";
  if (failed.length && failed.every((g) => g.type === "judge")) return "grader";
  return "agent";
}
