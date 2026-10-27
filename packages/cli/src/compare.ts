// litmustest compare A B: paired deltas with intervals per suite, the flip list, failure-mode and cost deltas.
// Also the markdown that litmustest ci posts on a pull request.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pairedDelta } from "./stats.ts";
import { loadFiles } from "./server/overview.ts";

type Obj = Record<string, unknown>;
export interface SuiteDelta { name: string; kind: string; n_tasks: number; a: number; b: number; delta: number; ci: { low: number; high: number }; significant: boolean; note: string; flips: number; a_ci: Obj; b_ci: Obj; gate: Obj | null; gate_result?: { passed: boolean; reasons: string[] } }
export interface Flip { task: string; suite: string; change: "Broke" | "Fixed" | "Flaky"; a: string; b: string; check: string | null; transcript_ref?: string }
export interface Comparison { a: Obj; b: Obj; suites: SuiteDelta[]; flips: Flip[]; modes: { name: string; severity?: string; a: number; b: number; delta: number }[]; cost: { a: number; b: number; delta: number; tokens_a: number; tokens_b: number; latency_a: number; latency_b: number; infra_a: number; infra_b: number }; verdict: { tone: "good" | "bad" | "neutral"; text: string }; common_tasks: number }

export function loadRun(evalsDir: string, id: string): Obj {
  const p = join(evalsDir, "runs", `${id}.json`);
  if (!existsSync(p)) throw new Error(`no run ${id} under runs/`);
  return JSON.parse(readFileSync(p, "utf8")) as Obj;
}
const trialsOf = (run: Obj, task: string): Obj[] => (((run.tasks as Record<string, Obj>)?.[task]?.trials as Obj[]) ?? []).filter((t) => !t.infra_error);
const majority = (trials: Obj[]) => trials.length ? (trials.filter((t) => t.pass).length * 2 >= trials.length ? "pass" : "fail") : "none";
const rate = (trials: Obj[]) => (trials.length ? (100 * trials.filter((t) => t.pass).length) / trials.length : 0);

export function compareRuns(evalsDir: string, aId: string, bId: string, opts: { seed?: number } = {}): Comparison {
  const f = loadFiles(evalsDir);
  const a = loadRun(evalsDir, aId), b = loadRun(evalsDir, bId);
  const aTasks = a.tasks as Record<string, Obj>, bTasks = b.tasks as Record<string, Obj>;
  const common = Object.keys(bTasks).filter((t) => t in aTasks);
  const suiteNames = [...new Set([...Object.keys(a.suites as Obj), ...Object.keys(b.suites as Obj)])];
  const flips: Flip[] = [];
  for (const t of common) {
    const ta = trialsOf(a, t), tb = trialsOf(b, t); if (!ta.length || !tb.length) continue;
    const ma = majority(ta), mb = majority(tb); const bt = bTasks[t]!;
    const check = (tb.flatMap((x) => (x.failed_checks as string[]) ?? [])[0] as string | undefined) ?? null;
    const ref = (tb.find((x) => !x.pass) ?? tb[0])?.transcript_ref as string | undefined;
    if (bt.flaky && !aTasks[t]!.flaky) flips.push({ task: t, suite: String(bt.suite), change: "Flaky", a: `${ta.filter((x) => x.pass).length} / ${ta.length}`, b: `${tb.filter((x) => x.pass).length} / ${tb.length}`, check, transcript_ref: ref });
    else if (ma === "pass" && mb === "fail") flips.push({ task: t, suite: String(bt.suite), change: "Broke", a: `${ta.filter((x) => x.pass).length} / ${ta.length}`, b: `${tb.filter((x) => x.pass).length} / ${tb.length}`, check, transcript_ref: ref });
    else if (ma === "fail" && mb === "pass") flips.push({ task: t, suite: String(bt.suite), change: "Fixed", a: `${ta.filter((x) => x.pass).length} / ${ta.length}`, b: `${tb.filter((x) => x.pass).length} / ${tb.length}`, check: null, transcript_ref: ref });
  }
  const suites: SuiteDelta[] = suiteNames.map((name) => {
    const ids = common.filter((t) => bTasks[t]!.suite === name && aTasks[t]!.suite === name);
    const pa = ids.map((t) => trialsOf(a, t).map((x) => Boolean(x.pass))), pb = ids.map((t) => trialsOf(b, t).map((x) => Boolean(x.pass)));
    const d = ids.length ? pairedDelta(pa, pb, 1000, opts.seed ?? 1) : { delta: 0, ci: { low: 0, high: 0, method: "bootstrap" as const }, significant: false };
    const sa = (a.suites as Record<string, Obj>)[name], sb = (b.suites as Record<string, Obj>)[name];
    const suiteFile = f.suites.find((s) => s.name === name);
    const gate = (suiteFile?.gate as Obj | undefined) ?? ((f.config.gates as Record<string, Obj> | undefined)?.[name]) ?? null;
    return { name, kind: String(suiteFile?.kind ?? name), n_tasks: ids.length, a: sa ? Number(sa.pass_rate) : +rate(ids.flatMap((t) => trialsOf(a, t))).toFixed(1), b: sb ? Number(sb.pass_rate) : +rate(ids.flatMap((t) => trialsOf(b, t))).toFixed(1), delta: d.delta, ci: { low: d.ci.low, high: d.ci.high }, significant: d.significant, note: ids.length ? (d.significant ? "significant" : "within noise") : "no common tasks", flips: flips.filter((x) => x.suite === name).length, a_ci: (sa?.ci as Obj) ?? {}, b_ci: (sb?.ci as Obj) ?? {}, gate };
  }).filter((s) => s.n_tasks > 0 || (a.suites as Obj)[s.name] || (b.suites as Obj)[s.name]);
  // failure-mode deltas from failed checks mapped through the tasks' checks
  const modeOf = new Map<string, Map<string, string>>();
  for (const t of f.tasks) modeOf.set(String(t.id), new Map(((t.checks as Obj[]) ?? []).filter((c) => c.failure_mode).map((c) => [String(c.id), String(c.failure_mode)])));
  const count = (run: Obj) => { const m = new Map<string, number>(); for (const [t, x] of Object.entries(run.tasks as Record<string, Obj>)) for (const tr of (x.trials as Obj[]) ?? []) for (const c of (tr.failed_checks as string[]) ?? []) { const mode = modeOf.get(t)?.get(c); if (mode) m.set(mode, (m.get(mode) ?? 0) + 1); } return m; };
  const ca = count(a), cb = count(b);
  const modes = [...new Set([...ca.keys(), ...cb.keys()])].map((name) => ({ name, severity: f.modes.find((m) => m.name === name)?.severity as string | undefined, a: ca.get(name) ?? 0, b: cb.get(name) ?? 0, delta: (cb.get(name) ?? 0) - (ca.get(name) ?? 0) })).sort((x, y) => y.b - x.b);
  const sum = (run: Obj, k: string) => Object.values(run.tasks as Record<string, Obj>).flatMap((x) => (x.trials as Obj[]) ?? []).reduce((acc, t) => acc + Number(t[k] ?? 0), 0);
  const avg = (run: Obj, k: string) => { const ts = Object.values(run.tasks as Record<string, Obj>).flatMap((x) => (x.trials as Obj[]) ?? []).filter((t) => t[k] !== undefined); return ts.length ? Math.round(ts.reduce((acc, t) => acc + Number(t[k]), 0) / ts.length) : 0; };
  const cost = { a: Number(a.cost_usd ?? 0), b: Number(b.cost_usd ?? 0), delta: +(Number(b.cost_usd ?? 0) - Number(a.cost_usd ?? 0)).toFixed(4), tokens_a: sum(a, "tokens"), tokens_b: sum(b, "tokens"), latency_a: avg(a, "latency_ms"), latency_b: avg(b, "latency_ms"), infra_a: Number(a.infra_error_rate ?? 0), infra_b: Number(b.infra_error_rate ?? 0) };
  // verdict
  const broke = flips.filter((x) => x.change === "Broke"); const regBroke = broke.filter((x) => suites.find((s) => s.name === x.suite)?.kind === "regression");
  const better = suites.filter((s) => s.significant && s.delta > 0), worse = suites.filter((s) => s.significant && s.delta < 0);
  let verdict: Comparison["verdict"];
  if (regBroke.length || worse.length) verdict = { tone: "bad", text: `B ${better.length ? `is better on ${better.map((s) => s.name).join(", ")} and ` : ""}${worse.length ? `worse on ${worse.map((s) => s.name).join(", ")}` : `breaks ${regBroke.length} regression task${regBroke.length > 1 ? "s" : ""}`}. Fix ${regBroke.length ? `the ${regBroke.length} broken task${regBroke.length > 1 ? "s" : ""}` : "that"} before merging.` };
  else if (better.length) verdict = { tone: "good", text: `B is better on ${better.map((s) => `${s.name} (+${s.delta} pts)`).join(", ")}; nothing else moved outside the noise.` };
  else verdict = { tone: "neutral", text: `No significant change between ${aId} and ${bId}: every suite delta is within noise${flips.length ? `, ${flips.length} task${flips.length > 1 ? "s" : ""} flipped` : ""}.` };
  return { a: meta(a), b: meta(b), suites, flips, modes, cost, verdict, common_tasks: common.length };
}
const meta = (r: Obj) => ({ run_id: r.run_id, commit: r.commit, branch: r.branch, started_at: r.started_at, trials: r.trials });

/** Evaluate the gates for suites in B against A. report_only suites never fail. */
export function evaluateGates(c: Comparison, threshold = 90): { passed: boolean; suites: SuiteDelta[] } {
  let passed = true;
  for (const s of c.suites) {
    const g = s.gate ?? {}; const reasons: string[] = [];
    if (g.min_pass_rate !== undefined && s.b < Number(g.min_pass_rate)) reasons.push(`pass rate ${s.b}% is below the ${g.min_pass_rate}% gate`);
    if (g.max_drop_pts !== undefined && s.delta < -Number(g.max_drop_pts) && s.significant) reasons.push(`dropped ${Math.abs(s.delta)} pts (significant), more than the ${g.max_drop_pts} allowed`);
    const ok = reasons.length === 0 || Boolean(g.report_only);
    s.gate_result = { passed: ok, reasons: g.report_only && reasons.length ? reasons.map((r) => `${r} (report only)`) : reasons };
    if (!ok) passed = false;
  }
  void threshold;
  return { passed, suites: c.suites };
}

export function comparisonMarkdown(c: Comparison, opts: { title?: string; gates?: boolean } = {}): string {
  const sign = (n: number) => (n > 0 ? `+${n}` : `${n}`);
  const lines = [`### ${opts.title ?? "litmustest"}: ${String(c.b.run_id)} vs ${String(c.a.run_id)}`, "", `**${c.verdict.text}**`, "", "| Suite | A | B | Δ (95% CI) | | Gate |", "| --- | ---: | ---: | ---: | --- | --- |"];
  for (const s of c.suites) lines.push(`| ${s.name} | ${s.a}% | ${s.b}% | ${sign(s.delta)} (${sign(s.ci.low)}…${sign(s.ci.high)}) | ${s.note} | ${s.gate_result ? (s.gate_result.passed ? (s.gate?.report_only ? "report only" : "✅") : `❌ ${s.gate_result.reasons.join("; ")}`) : s.gate ? "" : "none"} |`);
  if (c.flips.length) { lines.push("", `**${c.flips.length} task${c.flips.length > 1 ? "s" : ""} flipped** (majority verdict across trials)`, "", "| Task | Suite | A → B | Change | Failing check in B |", "| --- | --- | --- | --- | --- |"); for (const x of c.flips.slice(0, 25)) lines.push(`| \`${x.task}\` | ${x.suite} | ${x.a} → ${x.b} | ${x.change} | ${x.check ? `\`${x.check}\`` : "—"} |`); if (c.flips.length > 25) lines.push(`| … | | | ${c.flips.length - 25} more | |`); }
  if (c.modes.length) { lines.push("", "**Failed checks by failure mode**", "", "| Mode | A | B | Δ |", "| --- | ---: | ---: | ---: |"); for (const m of c.modes.slice(0, 10)) lines.push(`| \`${m.name}\` | ${m.a} | ${m.b} | ${sign(m.delta)} |`); }
  lines.push("", `Cost $${c.cost.a} → $${c.cost.b} (${sign(c.cost.delta)}) · tokens ${c.cost.tokens_a} → ${c.cost.tokens_b} · mean latency ${c.cost.latency_a} → ${c.cost.latency_b} ms · infra errors ${c.cost.infra_a}% → ${c.cost.infra_b}%`, "", `<sub>${c.common_tasks} common tasks · B ran ${String(c.b.trials)} trials per task on \`${String(c.b.commit)}\` · judge-corrected pass rates with bootstrap intervals · litmustest</sub>`);
  return lines.join("\n");
}
