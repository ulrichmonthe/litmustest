// Transcript routes: list runs and trials, read one trial with its grades and a suggested triage, confirm or override
// the triage into the run summary, and dispute a judge's verdict, which turns the trial into a labelled trace.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { SchemaSet } from "../schemas.ts";
import { viewFromTrial } from "../run.ts";
import { readerOf, valueAt } from "../outcome.ts";
import { isRemoteRef, localRoot, openStore, type StoreOptions } from "../storage/index.ts";
import { loadFiles } from "./overview.ts";
import { HttpError, type App, type Reply } from "./app.ts";
import { explainTemplate, explainWithClaude, type ClaudeExplanation, type ExplainInput, type Grade } from "../explain.ts";
import type { Ask } from "../discover.ts";

type Obj = Record<string, unknown>;

/** The local transcript directory (the store for local, the cache for a remote backend). Kept for callers that only read what is on this machine. */
export function storeDirFor(evalsDir: string): string { return localRoot(evalsDir); }
const safe = (s: string) => s.replace(/[^A-Za-z0-9_.-]/g, "");

export function transcriptsIndex(app: App, runId?: string): Reply {
  const f = loadFiles(app.evalsDir);
  const runs = f.runs.slice().reverse();
  const run = runId ? runs.find((r) => r.run_id === runId) : runs[0];
  if (!run) return { status: 200, body: { runs: [], run: null, tasks: [] } };
  // a trial is available when its transcript is on this machine, or its ref says it went to the configured remote store
  const store = localRoot(app.evalsDir); const remote = String(storageBackend(app.evalsDir)) !== "local";
  const tasks = Object.entries(run.tasks as Record<string, Obj>).map(([id, t]) => { const trials = (t.trials as Obj[]) ?? []; return { id, suite: t.suite, strict_pass: t.strict_pass, weighted: t.weighted, flaky: Boolean(t.flaky), likely_broken: Boolean(t.likely_broken), trials: trials.map((x, i) => ({ n: i + 1, pass: x.pass, infra_error: x.infra_error, infra_error_kind: x.infra_error_kind, failed_checks: x.failed_checks ?? [], triage: x.triage ?? null, available: existsSync(join(store, safe(String(run.run_id)), safe(id), String(i + 1), "trial.json")) || (remote && isRemoteRef(x.transcript_ref)) })) }; }).sort((a, b) => Number(a.strict_pass) - Number(b.strict_pass) || a.id.localeCompare(b.id));
  return { status: 200, body: { runs: runs.map((r) => ({ run_id: r.run_id, commit: r.commit, branch: r.branch, started_at: r.started_at })), run: { run_id: run.run_id, commit: run.commit, branch: run.branch, started_at: run.started_at, trials: run.trials }, tasks } };
}

function storageBackend(evalsDir: string): string { try { return openStore(evalsDir).backend; } catch { return "local"; } }

/** Make a trial's files local before reading them: nothing to do for the local store, a read-through fetch for a remote one. */
export async function pullTrial(evalsDir: string, runId: string, taskId: string, n: number, o?: StoreOptions): Promise<{ ok: boolean; error?: string; backend: string; url?: string }> {
  const store = openStore(evalsDir, o); const r = await store.pull(runId, taskId, n);
  return { ...r, backend: store.backend, url: store.url(runId, taskId, n) };
}

/** Everything known about one trial: the run entry, the stored transcript and grades, the task file, the end state. Reads the local copy; call pullTrial first when the store may be remote. */
export function loadTrial(evalsDir: string, runId: string, taskId: string, n: number, files?: ReturnType<typeof loadFiles>) {
  const f = files ?? loadFiles(evalsDir);
  const run = f.runs.find((r) => r.run_id === runId); if (!run) throw new HttpError(404, `no run ${runId}`);
  const task = (run.tasks as Record<string, Obj>)[taskId]; if (!task) throw new HttpError(404, `no task ${taskId} in ${runId}`);
  const trials = (task.trials as Obj[]) ?? []; const t = trials[n - 1]; if (!t) throw new HttpError(404, `no trial ${n}`);
  const dir = join(storeDirFor(evalsDir), safe(runId), safe(taskId), String(n));
  const trialFile = join(dir, "trial.json"), gradesFile = join(dir, "grades.json");
  const trialData = existsSync(trialFile) ? (JSON.parse(readFileSync(trialFile, "utf8")) as Obj) : null;
  const grades = existsSync(gradesFile) ? (JSON.parse(readFileSync(gradesFile, "utf8")) as Obj) : null;
  const taskFile = f.tasks.find((x) => x.id === taskId) ?? null;
  const refPath = taskFile ? join(evalsDir, String(taskFile.reference_solution)) : "";
  const reference = refPath && existsSync(refPath) ? (JSON.parse(readFileSync(refPath, "utf8")) as Obj) : null;
  const view = trialData ? viewFromTrial(trialData, `trial_${runId}_${taskId}_${n}`) : null;
  // expected vs actual end state, for the outcome panel
  // when the runner read the state itself, the values it saw are in the grade; otherwise the trial's own snapshot is all there is
  const observedOf = (check: string) => ((grades?.grades as Obj[] | undefined) ?? []).find((g) => g.check === check && g.observed && typeof g.observed === "object") as { observed: Obj; reader?: string } | undefined;
  const outcome = taskFile ? ((taskFile.checks as Obj[]) ?? []).filter((c) => c.type === "outcome").flatMap((c) => { const seen = observedOf(String(c.id)); return Object.entries(c.expect as Obj).map(([path, want]) => ({ check: String(c.id), path, expected: want, actual: seen && path in seen.observed ? seen.observed[path] : trialData ? valueAt(trialData.state, path) : undefined, reference: reference ? valueAt(reference.state, path) : undefined, reader: seen?.reader ?? (readerOf(c) === "trial" ? "trial" : "trial_fallback") })); }) : [];
  const stderr = existsSync(join(dir, "stderr.txt")) ? readFileSync(join(dir, "stderr.txt"), "utf8").slice(-4000) : "";
  const gradeList = (grades?.grades as Grade[]) ?? [];
  const suiteKind = String(f.suites.find((x) => x.name === task.suite)?.kind ?? task.suite ?? "");
  const explainInput: ExplainInput = {
    task: { id: taskId, suite: String(task.suite ?? ""), description: taskFile?.description as string | undefined, source: taskFile?.source as string | undefined, checks: (taskFile?.checks as Obj[]) ?? [] },
    suiteKind, summary: t, grades: gradeList, view, outcome, modes: Object.fromEntries(f.modes.map((m) => [String(m.name), String(m.definition ?? "")])),
    likelyBroken: Boolean(task.likely_broken), flaky: Boolean(task.flaky), stderr,
  };
  return { f, run, task, trials, t, trialData, grades, gradeList, taskFile, reference, view, outcome, stderr, explainInput };
}

export async function trial(app: App, runId: string, taskId: string, n: number, o?: StoreOptions): Promise<Reply> {
  let stored: Awaited<ReturnType<typeof pullTrial>>;
  try { stored = await pullTrial(app.evalsDir, runId, taskId, n, o); } catch (e) { stored = { ok: false, error: (e as Error).message, backend: "unknown" }; }
  const { f, run, task, trials, t, trialData, grades, gradeList, taskFile, reference, view, outcome, stderr, explainInput } = loadTrial(app.evalsDir, runId, taskId, n);
  const judges = Object.fromEntries(f.judges.map((j) => [j.name, { failure_mode: j.judge?.failure_mode, status: j.calibration?.status ?? "untested" }]));
  const explain = { ...explainTemplate(explainInput), claude: (t.explanation as Obj | undefined) ?? null };
  return { status: 200, body: { run: { run_id: run.run_id, commit: run.commit, branch: run.branch, trials: run.trials }, task: { id: taskId, suite: task.suite, suite_kind: explainInput.suiteKind, strict_pass: task.strict_pass, weighted: task.weighted, flaky: Boolean(task.flaky), likely_broken: Boolean(task.likely_broken), description: taskFile?.description, source: taskFile?.source, input: taskFile?.input, checks: taskFile?.checks ?? [] }, n, summary: t, trials: trials.map((x, i) => ({ n: i + 1, pass: x.pass, infra_error: x.infra_error })), trial: trialData, view, grades: gradeList, triage_suggested: grades?.triage_suggested ?? (t.infra_error ? "infra" : "agent"), infra: t.infra_error ? { kind: t.infra_error_kind, message: grades?.infra_message, stderr } : null, outcome, reference_available: Boolean(reference), judges, trace_id: trialData?.trace_id ?? null, explain, store: { backend: stored.backend, ref: t.transcript_ref ?? null, ...(stored.url ? { url: stored.url } : {}), ...(stored.error ? { error: stored.error } : {}) } } };
}

/** Ask Claude to explain a trial and store it as trials[n].explanation in the run summary, through the validated save. */
export async function explainRoute(app: App, runId: string, taskId: string, n: number, ask?: Ask, o?: StoreOptions): Promise<Reply> {
  try { await pullTrial(app.evalsDir, runId, taskId, n, o); } catch { /* explain from what the summary holds */ }
  const { t, explainInput } = loadTrial(app.evalsDir, runId, taskId, n);
  if (t.pass) throw new HttpError(400, "this trial passed; there is nothing to explain");
  let e: ClaudeExplanation;
  try { e = await explainWithClaude(explainInput, { ask }); }
  catch (err) {
    const m = (err as Error).message;
    const auth = /api.?key|auth|credential|401/i.test(m);
    throw new HttpError(auth ? 503 : 502, auth ? "No model credentials: restart `litmustest serve` with ANTHROPIC_API_KEY (or ANTHROPIC_AUTH_TOKEN) set in its environment, or run `litmustest explain` from a terminal that has one." : `Claude could not explain this trial: ${m}`);
  }
  const path = `runs/${safe(runId)}.json`; const abs = join(app.evalsDir, path);
  const run = JSON.parse(readFileSync(abs, "utf8")) as Obj;
  const tr = ((run.tasks as Record<string, Obj>)[taskId]!.trials as Obj[])[n - 1]!;
  tr.explanation = Object.fromEntries(Object.entries(e).filter(([, v]) => v !== ""));
  const r = app.putFile(path, undefined, undefined, run);
  if (r.status !== 200) return r;
  return { status: 200, body: { ...(r.body as Obj), explanation: tr.explanation } };
}

/** Confirm or override the triage: writes trials[n].triage into the run summary through the validated save path. */
export function setTriage(app: App, runId: string, taskId: string, n: number, body: Obj): Reply {
  const verdict = String(body.verdict ?? ""); if (!["agent", "grader", "task", "infra"].includes(verdict)) throw new HttpError(400, "verdict must be agent, grader, task or infra");
  const path = `runs/${safe(runId)}.json`; const abs = join(app.evalsDir, path);
  if (!existsSync(abs)) throw new HttpError(404, `no run ${runId}`);
  const run = JSON.parse(readFileSync(abs, "utf8")) as Obj;
  const task = (run.tasks as Record<string, Obj>)[taskId]; const trials = (task?.trials as Obj[]) ?? [];
  if (!task || !trials[n - 1]) throw new HttpError(404, `no trial ${taskId}#${n} in ${runId}`);
  const dir = join(localRoot(app.evalsDir), safe(runId), safe(taskId), String(n)); const gradesFile = join(dir, "grades.json");
  const suggested = existsSync(gradesFile) ? String((JSON.parse(readFileSync(gradesFile, "utf8")) as Obj).triage_suggested ?? "agent") : "agent";
  trials[n - 1]!.triage = { verdict, by: String(body.by ?? "dashboard"), at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"), ...(body.note ? { note: String(body.note).slice(0, 1000) } : {}), suggested };
  return app.putFile(path, undefined, undefined, run);
}

/** Dispute a judge's verdict: the trial becomes a trace under datasets/traces/ and the human's label is appended for that judge's failure mode. */
export async function dispute(app: App, runId: string, taskId: string, n: number, body: Obj, o?: StoreOptions): Promise<Reply> {
  const check = String(body.check ?? ""); const label = String(body.label ?? "");
  if (!["Pass", "Fail"].includes(label)) throw new HttpError(400, "label must be Pass or Fail");
  const f = loadFiles(app.evalsDir);
  const taskFile = f.tasks.find((x) => x.id === taskId); if (!taskFile) throw new HttpError(404, `no task ${taskId}`);
  const c = ((taskFile.checks as Obj[]) ?? []).find((x) => x.id === check && x.type === "judge"); if (!c) throw new HttpError(400, `${check} is not a judge check on ${taskId}`);
  const mode = String(c.failure_mode);
  const store = openStore(app.evalsDir, o);
  let raw: string | null;
  try { raw = await store.get(runId, taskId, n, "trial.json"); } catch (e) { throw new HttpError(502, `could not read the trial from the ${store.backend} store: ${(e as Error).message}`); }
  if (raw === null) throw new HttpError(404, `the trial's transcript is not in the ${store.backend} store`);
  const trialData = JSON.parse(raw) as Obj;
  const traceId = `trial_${safe(runId)}_${safe(taskId)}_${n}`.toLowerCase();
  const tracePath = join(app.evalsDir, "datasets", "traces", `${traceId}.json`);
  if (!existsSync(tracePath)) {
    const trace = traceFromTrial(trialData, traceId, { run: runId, task: taskId, trial: n });
    const errs = new SchemaSet().check("trace", trace); if (errs.length) throw new HttpError(500, `trace would not validate: ${errs[0]}`);
    mkdirSync(dirname(tracePath), { recursive: true }); writeFileSync(tracePath, JSON.stringify(trace, null, 1)); app.pending.track(tracePath); app.invalidate();
    trialData.trace_id = traceId;
    try { await store.put(runId, taskId, n, "trial.json", JSON.stringify(trialData, null, 2)); } catch { /* the local copy has the trace id; the remote copy only loses the back-link */ }
  }
  const r = app.appendLabel(`disputes-${safe(runId)}`, { trace_id: traceId, failure_mode: mode, label, note: body.note ? String(body.note) : `disputed ${check} on ${taskId} trial ${n} of ${runId}`, annotator: String(body.annotator ?? "dashboard") });
  if (r.status !== 200) return r;
  return { status: 200, body: { ...(r.body as Obj), trace_id: traceId, failure_mode: mode } };
}

/** A trial in the reference-solution shape as an internal trace: one chat span per agent turn, tool spans under it. */
export function traceFromTrial(trial: Obj, id: string, meta: Obj): Obj {
  const t0 = Date.now() - 60_000; let t = t0; const iso = (ms: number) => new Date(ms).toISOString();
  const turns = (trial.transcript as Obj[]) ?? []; const calls = (trial.tool_calls as Obj[]) ?? [];
  const spans: Obj[] = []; let pendingUser: Obj[] = []; let turnIx = 0; let callIx = 0;
  const pushChat = (text: string, chatCalls: Obj[]) => { const start = t; t += 1500; const sid = `s_chat_${turnIx}`; spans.push({ span_id: sid, parent_span_id: "s_root", name: "chat", kind: "client", start_time: iso(start), end_time: iso(t), attributes: { "gen_ai.operation.name": "chat", "gen_ai.input.messages": pendingUser.length ? pendingUser : [{ role: "user", parts: [{ type: "text", content: String(trial.input ?? "") }] }], "gen_ai.output.messages": [{ role: "assistant", parts: [...chatCalls.map((c) => ({ type: "tool_call", id: `tc_${callIx++}`, name: String(c.name), arguments: c.args ?? {} })), { type: "text", content: text }], finish_reason: chatCalls.length ? "tool_call" : "stop" }] } }); let k = callIx - chatCalls.length; for (const c of chatCalls) { const s = t; t += 100; spans.push({ span_id: `s_tool_${k}`, parent_span_id: sid, name: `execute_tool ${c.name}`, kind: "internal", start_time: iso(s), end_time: iso(t), status: { code: c.result && typeof c.result === "object" && "error" in (c.result as Obj) ? "error" : "ok" }, attributes: { "gen_ai.operation.name": "execute_tool", "gen_ai.tool.name": String(c.name), "gen_ai.tool.call.id": `tc_${k}`, "gen_ai.tool.call.arguments": c.args ?? {}, "gen_ai.tool.call.result": c.result ?? null } }); k++; } pendingUser = []; turnIx++; };
  let buffered: Obj[] = []; let callCursor = 0;
  for (const turn of turns) {
    const role = String(turn.role);
    if (role === "user" || role === "system") pendingUser.push({ role, parts: [{ type: "text", content: String(turn.content ?? "") }] });
    else if (role === "tool") { const c = calls[callCursor++]; if (c) buffered.push(c); }
    else { pushChat(String(turn.content ?? ""), buffered); buffered = []; }
  }
  if (turnIx === 0) pushChat(String(trial.output ?? ""), calls);
  spans.unshift({ span_id: "s_root", name: "invoke_agent", kind: "server", start_time: iso(t0), end_time: iso(t), status: { code: "ok" }, attributes: { "gen_ai.operation.name": "invoke_agent", "gen_ai.conversation.id": id } });
  return { id, source: "run", ingested_at: iso(t), metadata: meta, spans };
}
export { readdirSync };
