// Read models for the Failure modes view and the Overview. Everything derives from the files; nothing is stored.
import { loadTrial } from "./transcripts.ts";
import { explainTemplate } from "../explain.ts";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { sha256 } from "../validate.ts";

type Obj = Record<string, unknown>;
const readYaml = (p: string) => parseYaml(readFileSync(p, "utf8")) as Obj;
const readJson = (p: string) => JSON.parse(readFileSync(p, "utf8")) as Obj;
const list = (dir: string, ext: string) => (existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(ext)).sort() : []);

export interface Files { modes: Obj[]; tasks: Obj[]; suites: Obj[]; runs: Obj[]; judges: { name: string; judge?: Obj; calibration?: Obj }[]; labels: Obj[]; batches: Obj[]; config: Obj }

export function loadFiles(evalsDir: string): Files {
  const tasks: Obj[] = [];
  const walk = (d: string) => { if (!existsSync(d)) return; for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); if (e.isDirectory()) walk(p); else if (e.name.endsWith(".yaml")) { try { tasks.push(readYaml(p)); } catch { /* reported by validate */ } } } };
  walk(join(evalsDir, "tasks"));
  const safe = <T,>(f: () => T, fallback: T): T => { try { return f(); } catch { return fallback; } };
  const judgesDir = join(evalsDir, "graders", "judges");
  const judges = existsSync(judgesDir) ? readdirSync(judgesDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => ({ name: e.name, judge: safe(() => existsSync(join(judgesDir, e.name, "judge.yaml")) ? readYaml(join(judgesDir, e.name, "judge.yaml")) : undefined, undefined), calibration: safe(() => existsSync(join(judgesDir, e.name, "calibration.json")) ? readJson(join(judgesDir, e.name, "calibration.json")) : undefined, undefined) })) : [];
  const labels: Obj[] = [];
  for (const f of list(join(evalsDir, "labels"), ".jsonl")) for (const l of readFileSync(join(evalsDir, "labels", f), "utf8").split("\n")) { if (l.trim()) safe(() => labels.push(JSON.parse(l)), undefined); }
  return {
    modes: list(join(evalsDir, "failure_modes"), ".yaml").map((f) => safe(() => readYaml(join(evalsDir, "failure_modes", f)), undefined)).filter(Boolean) as Obj[],
    tasks, suites: list(join(evalsDir, "suites"), ".yaml").map((f) => safe(() => readYaml(join(evalsDir, "suites", f)), undefined)).filter(Boolean) as Obj[],
    runs: list(join(evalsDir, "runs"), ".json").map((f) => safe(() => readJson(join(evalsDir, "runs", f)), undefined)).filter(Boolean).sort((a, b) => String((a as Obj).started_at).localeCompare(String((b as Obj).started_at))) as Obj[],
    judges, labels,
    batches: list(join(evalsDir, "batches"), ".yaml").map((f) => safe(() => readYaml(join(evalsDir, "batches", f)), undefined)).filter(Boolean) as Obj[],
    config: safe(() => readYaml(join(evalsDir, "litmustest.yaml")), {}),
  };
}

/** check id -> failure mode, per task, so run summaries' failed_checks can be counted by mode. */
function checkModes(tasks: Obj[]): Map<string, Map<string, string>> {
  const m = new Map<string, Map<string, string>>();
  for (const t of tasks) { const inner = new Map<string, string>(); for (const c of (t.checks as Obj[]) ?? []) if (c.failure_mode) inner.set(String(c.id), String(c.failure_mode)); m.set(String(t.id), inner); }
  return m;
}
function failsByMode(run: Obj | undefined, cm: Map<string, Map<string, string>>): Map<string, number> {
  const out = new Map<string, number>();
  if (!run) return out;
  for (const [tid, t] of Object.entries((run.tasks as Record<string, Obj>) ?? {})) for (const tr of (t.trials as Obj[]) ?? []) for (const c of (tr.failed_checks as string[]) ?? []) { const mode = cm.get(tid)?.get(c); if (mode) out.set(mode, (out.get(mode) ?? 0) + 1); }
  return out;
}
export function judgeStatus(j: { judge?: Obj; calibration?: Obj }, threshold: number): { status: string; label: string; tpr?: number; tnr?: number } {
  const c = j.calibration; const test = c?.test as Obj | null | undefined;
  if (!j.judge) return { status: "none", label: "No judge" };
  if (!c) return { status: "untested", label: "Judge, untested" };
  const status = String(c.status);
  if (status === "trusted") return { status, label: "Judge · trusted", tpr: Number(test?.tpr), tnr: Number(test?.tnr) };
  if (status === "stale") return { status, label: "Judge · stale", tpr: test ? Number(test.tpr) : undefined, tnr: test ? Number(test.tnr) : undefined };
  const dev = c.dev as Obj | undefined;
  if (dev && dev.tpr !== undefined && (Number(dev.tpr) < threshold || Number(dev.tnr) < threshold)) return { status: "dev", label: "Judge · below target", tpr: Number(dev.tpr), tnr: Number(dev.tnr) };
  return { status, label: status === "dev" ? "Judge · dev" : "Judge · untested" };
}

/** One line on why a failed trial failed: Claude's summary if one was saved, else the template's headline. */
export function failureLine(evalsDir: string, f: ReturnType<typeof loadFiles>, runId: string, taskId: string, n: number): { headline: string; kind: string; claude?: string } | undefined {
  try {
    const { explainInput, t } = loadTrial(evalsDir, runId, taskId, n, f);
    const x = explainTemplate(explainInput);
    return { headline: x.headline, kind: x.kind, ...((t.explanation as Obj | undefined)?.summary ? { claude: String((t.explanation as Obj).summary) } : {}) };
  } catch { return undefined; }
}

export function modesView(evalsDir: string, f = loadFiles(evalsDir)): Obj[] {
  const cm = checkModes(f.tasks);
  const threshold = Number((f.config.judges as Obj | undefined)?.trust_threshold ?? 90);
  const last6 = f.runs.slice(-6);
  const perRun = last6.map((r) => failsByMode(r, cm));
  const latest = perRun[perRun.length - 1] ?? new Map<string, number>();
  const prev = perRun[perRun.length - 2];
  return f.modes.map((m) => {
    const name = String(m.name);
    const p = join(evalsDir, "failure_modes", `${name}.yaml`);
    const raw = readFileSync(p, "utf8");
    const ls = f.labels.filter((l) => l.failure_mode === name);
    const fails = ls.filter((l) => l.label === "Fail");
    const lastRun = f.runs[f.runs.length - 1];
    const tasks = f.tasks.flatMap((t) => ((t.checks as Obj[]) ?? []).filter((c) => c.failure_mode === name).map((c) => {
      const trials = (((lastRun?.tasks as Record<string, Obj> | undefined)?.[String(t.id)]?.trials as Obj[] | undefined) ?? []).filter((x) => !x.infra_error);
      const failed = trials.map((x, i) => ({ x, n: i + 1 })).filter(({ x }) => ((x.failed_checks as string[]) ?? []).includes(String(c.id)));
      return {
        id: t.id, suite: t.suite, check: c.id, type: c.type, description: t.description, source: t.source,
        expect: c.type === "outcome" ? c.expect : undefined, fn: c.fn,
        latest: lastRun && trials.length ? { run_id: lastRun.run_id, trials: trials.length, failed: failed.length, transcript: failed[0] ? `#/transcripts/${encodeURIComponent(String(lastRun.run_id))}/${encodeURIComponent(String(t.id))}/${failed[0].n}` : undefined, why: failed[0] ? failureLine(evalsDir, f, String(lastRun.run_id), String(t.id), failed[0].n) : undefined } : undefined,
      };
    }));
    const j = f.judges.find((x) => x.name === name);
    const codeCheck = tasks.find((t) => t.type === "code");
    const outcome = tasks.find((t) => t.type === "outcome" || t.type === "transcript");
    let grader: { kind: string; label: string; status: string; href?: string; tpr?: number; tnr?: number; labels_needed?: number };
    if (j?.judge) { const s = judgeStatus(j, threshold); grader = { kind: "judge", label: s.label, status: s.status, href: `#/judges/${name}`, tpr: s.tpr, tnr: s.tnr }; }
    else if (codeCheck) grader = { kind: "code", label: "Code check", status: "trusted", href: `#/tasks/${codeCheck.suite}/${codeCheck.id}` };
    else if (outcome) grader = { kind: outcome.type === "outcome" ? "outcome" : "transcript", label: outcome.type === "outcome" ? "Outcome check" : "Transcript check", status: "trusted", href: `#/tasks/${outcome.suite}/${outcome.id}` };
    else { const need = Math.max(0, 60 - ls.length); grader = { kind: "none", label: need > 0 ? `Needs ${need} labels` : "No grader", status: "none", labels_needed: need }; }
    const note = fails.find((l) => l.note)?.note;
    return {
      name, path: `failure_modes/${name}.yaml`, hash: sha256(raw), content: raw,
      definition: m.definition, severity: m.severity, owner: m.owner, created: m.created, retired: m.retired, merged_into: m.merged_into, examples: m.examples ?? [],
      labels: ls.length, fail_labels: fails.length, label_traces: [...new Set(fails.map((l) => String(l.trace_id)))].slice(0, 20),
      run_fails: latest.get(name) ?? 0, run_fails_prev: prev?.get(name), trend: perRun.map((r) => r.get(name) ?? 0), has_runs: f.runs.length > 0,
      tasks, grader, example_note: note,
    };
  });
}

export function overview(evalsDir: string): Obj {
  const f = loadFiles(evalsDir);
  const cm = checkModes(f.tasks);
  const threshold = Number((f.config.judges as Obj | undefined)?.trust_threshold ?? 90);
  const latest = f.runs[f.runs.length - 1]; const prev = f.runs[f.runs.length - 2];
  const suites = f.suites.map((s) => {
    const name = String(s.name);
    const hist = f.runs.map((r) => ((r.suites as Record<string, Obj>)?.[name])).filter(Boolean) as Obj[];
    const cur = (latest?.suites as Record<string, Obj> | undefined)?.[name]; const before = (prev?.suites as Record<string, Obj> | undefined)?.[name];
    let delta: Obj | undefined;
    if (cur && before) {
      const d = Number(cur.pass_rate) - Number(before.pass_rate);
      const half = ((Number((cur.ci as Obj).high) - Number((cur.ci as Obj).low)) / 2 + (Number((before.ci as Obj).high) - Number((before.ci as Obj).low)) / 2) / Math.SQRT2;
      delta = { pts: +d.toFixed(1), significant: Math.abs(d) > half, note: Math.abs(d) > half ? "significant" : "within noise" };
    }
    return { name, kind: s.kind, description: s.description, n_tasks: ((s.tasks as unknown[]) ?? []).length, current: cur ?? null, delta: delta ?? null, history: hist.map((h) => Number(h.pass_rate)), gate: s.gate ?? (f.config.gates as Record<string, Obj> | undefined)?.[name] ?? null };
  });
  // alerts
  const alerts: Obj[] = [];
  for (const j of f.judges) {
    const s = judgeStatus(j, threshold);
    if (s.status === "stale") alerts.push({ kind: "Judge stale", level: "warn", title: `${j.name} was edited after its test pass.`, body: "Its verdicts are excluded from scores and gates until it is re-calibrated.", action: "Open judge", href: `#/judges/${j.name}` });
    else if (s.status === "dev") alerts.push({ kind: "Below target", level: "warn", title: `${j.name} is at TPR ${s.tpr} / TNR ${s.tnr} on dev.`, body: `Both need ${threshold} before the test set can run.`, action: "Open judge", href: `#/judges/${j.name}` });
    else if (s.status === "untested" && f.tasks.some((t) => ((t.checks as Obj[]) ?? []).some((c) => c.type === "judge" && (c.judge ?? c.failure_mode) === j.name))) alerts.push({ kind: "Untested judge", level: "neutral", title: `${j.name} is used by tasks but has never been calibrated.`, body: "Its verdicts do not count until it is trusted.", action: "Open judge", href: `#/judges/${j.name}` });
  }
  if (latest) for (const [tid, t] of Object.entries((latest.tasks as Record<string, Obj>) ?? {})) {
    if (t.likely_broken) alerts.push({ kind: "Broken task", level: "bad", title: `${tid} failed every trial${prev ? " in the last runs" : ""}.`, body: "Its reference solution passes, so the task's premise or environment is wrong, not the agent.", action: "Open task", href: `#/tasks/${encodeURIComponent(String(t.suite ?? f.tasks.find((x) => x.id === tid)?.suite ?? ""))}/${encodeURIComponent(tid)}` });
    else if (t.flaky) alerts.push({ kind: "Flaky task", level: "warn", title: `${tid} passes some trials and fails others with nothing changed.`, body: "Read its trials before trusting its pass rate.", action: "Open task", href: `#/tasks/${encodeURIComponent(String(t.suite ?? f.tasks.find((x) => x.id === tid)?.suite ?? ""))}/${encodeURIComponent(tid)}` });
  }
  for (const s of suites) if (s.kind === "capability" && s.current && Number((s.current as Obj).pass_rate) > 90) alerts.push({ kind: "Saturating", level: "neutral", title: `${s.name} is at ${(s.current as Obj).pass_rate}%.`, body: "Capability tasks that pass every trial are ready to graduate to regression.", action: "Open suite", href: `#/tasks` });
  // graduation: capability tasks that passed every trial in the last three runs
  const capIds = f.tasks.filter((t) => f.suites.find((s) => s.name === t.suite)?.kind === "capability").map((t) => String(t.id));
  const ready = capIds.filter((id) => { const runs = f.runs.filter((r) => (r.tasks as Record<string, Obj>)?.[id]).slice(-3); return runs.length === 3 && runs.every((r) => { const tr = (((r.tasks as Record<string, Obj>)[id]!.trials as Obj[]) ?? []).filter((x) => !x.infra_error); return tr.length > 0 && tr.every((x) => x.pass); }); });
  if (ready.length) alerts.push({ kind: "Graduation", level: "neutral", title: `${ready.length} capability task${ready.length > 1 ? "s" : ""} passed every trial for 3 runs.`, body: "Graduate them to regression so they stay guarded while capability keeps climbing.", action: `Graduate ${ready.length}`, href: "#/tasks" });
  const unlabelled = f.batches.reduce((a, b) => a + ((b.items as { trace_id: string }[]) ?? []).filter((i) => !f.labels.some((l) => l.trace_id === i.trace_id)).length, 0);
  if (unlabelled > 0) alerts.push({ kind: "Review queue", level: "neutral", title: `${unlabelled} traces in the review queue have no label yet.`, body: "Labels feed failure modes and judge calibration.", action: "Open queue", href: "#/review" });
  // pareto
  const fails = failsByMode(latest, cm); const failsPrev = failsByMode(prev, cm);
  const labelFails = new Map<string, number>(); for (const l of f.labels) if (l.label === "Fail" && l.failure_mode !== "overall") labelFails.set(String(l.failure_mode), (labelFails.get(String(l.failure_mode)) ?? 0) + 1);
  const source = latest ? "run" : "labels";
  const modes = f.modes.filter((m) => !m.retired).map((m) => { const name = String(m.name); const count = source === "run" ? (fails.get(name) ?? 0) : (labelFails.get(name) ?? 0); return { name, severity: m.severity, count, prev: source === "run" && prev ? (failsPrev.get(name) ?? 0) : null }; }).sort((a, b) => b.count - a.count);
  const total = modes.reduce((a, m) => a + m.count, 0); const top3 = modes.slice(0, 3).reduce((a, m) => a + m.count, 0);
  // judges
  const judges = f.judges.map((j) => { const s = judgeStatus(j, threshold); return { name: j.name, status: s.status, label: s.label.replace(/^Judge · /, ""), tpr: s.tpr ?? null, tnr: s.tnr ?? null, labels: f.labels.filter((l) => l.failure_mode === j.name).length }; });
  // flips
  const flips: Obj[] = [];
  if (latest && prev) for (const [tid, t] of Object.entries((latest.tasks as Record<string, Obj>) ?? {})) {
    const b = (prev.tasks as Record<string, Obj>)?.[tid]; if (!b) continue;
    const now = Number(t.strict_pass), was = Number(b.strict_pass);
    const trials = (t.trials as Obj[]) ?? []; const passed = trials.filter((x) => x.pass).length;
    const check = trials.flatMap((x) => (x.failed_checks as string[]) ?? [])[0] ?? null;
    const firstFail = trials.findIndex((x) => !x.pass && !x.infra_error);
    const why = firstFail >= 0 ? failureLine(evalsDir, f, String(latest.run_id), tid, firstFail + 1) : undefined;
    if (t.flaky) flips.push({ task: tid, suite: t.suite, change: "Flaky", trials: `${passed} / ${trials.length}`, check, why });
    else if (was >= 100 && now < 100) flips.push({ task: tid, suite: t.suite, change: "Broke", trials: `${passed} / ${trials.length}`, check, why, transcript: `#/transcripts/${encodeURIComponent(String(latest.run_id))}/${encodeURIComponent(tid)}/${firstFail + 1}` });
    else if (was < 100 && now >= 100) flips.push({ task: tid, suite: t.suite, change: "Fixed", trials: `${passed} / ${trials.length}`, check: null });
  }
  // coverage
  const coverage = f.batches.map((b) => { const items = (b.items as { trace_id: string }[]) ?? []; return { name: b.name, items: items.length, labelled: items.filter((i) => f.labels.some((l) => l.trace_id === i.trace_id)).length, clusters: ((b.coverage as Obj)?.clusters as unknown[] ?? []).length }; });
  // verdict
  let verdict: Obj;
  const reg = suites.find((s) => s.kind === "regression");
  if (!latest) verdict = { tone: "neutral", lead: "No runs yet.", rest: f.labels.length ? `${f.labels.length} labels on ${new Set(f.labels.map((l) => l.trace_id)).size} traces so far; keep reviewing, then draft graders.` : "Ingest traces and start the review queue." };
  else {
    const regOk = reg?.current ? Number((reg.current as Obj).pass_rate) >= Number((reg.gate as Obj)?.min_pass_rate ?? 95) : true;
    const drop = reg?.delta && Number((reg.delta as Obj).pts) < 0 && (reg.delta as Obj).significant;
    const cap = suites.find((s) => s.kind === "capability");
    const capNote = cap?.delta ? `capability ${Number((cap.delta as Obj).pts) >= 0 ? "up" : "down"} ${Math.abs(Number((cap.delta as Obj).pts))} pts, ${(cap.delta as Obj).note}` : "";
    verdict = regOk && !drop ? { tone: "good", lead: "Safe to merge.", rest: `Regression holding at ${(reg?.current as Obj)?.pass_rate ?? "–"}%${capNote ? "; " + capNote : ""}.` } : { tone: "bad", lead: "Hold.", rest: `Regression at ${(reg?.current as Obj)?.pass_rate}% ${drop ? `dropped ${Math.abs(Number((reg!.delta as Obj).pts))} pts, significant` : `is below the ${(reg?.gate as Obj)?.min_pass_rate ?? 95}% gate`}.` };
  }
  const staleCount = judges.filter((j) => j.status === "stale").length;
  return { run: latest ? { run_id: latest.run_id, commit: latest.commit, branch: latest.branch, started_at: latest.started_at, trials: latest.trials, cost_usd: latest.cost_usd, infra_error_rate: latest.infra_error_rate } : null, previous: prev ? { run_id: prev.run_id, commit: prev.commit } : null,
    verdict: { ...verdict, aside: staleCount ? `${staleCount} judge${staleCount > 1 ? "s" : ""} need${staleCount > 1 ? "" : "s"} attention before Quality scores count` : null },
    suites, alerts, modes: { source, total, top3_share: total ? Math.round((100 * top3) / total) : 0, items: modes }, judges, flips, coverage, labels: { total: f.labels.length, traces: new Set(f.labels.map((l) => l.trace_id)).size } };
}
