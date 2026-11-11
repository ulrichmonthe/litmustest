// Layer 2's facts: for each source, the typed fields a glossary template may print and how to build them from the files.
// Every number an explanation shows is computed here, never in a template. docs/EXPLAINER.md "Sources" lists them.
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { labelsFor } from "./calibrate.ts";
import { compareRuns, evaluateGates } from "./compare.ts";
import { graduationProposals } from "./graduate.ts";
import { computeCoverage } from "./coverage.ts";
import { loadFiles, judgeStatus, type Files } from "./server/overview.ts";
import { wilson } from "./stats.ts";
import { commitBranch } from "./server/git.ts";

type Obj = Record<string, unknown>;
export type Kind = "rate" | "interval" | "percent" | "pts" | "pts_interval" | "points" | "usd" | "count" | "text" | "enum" | "bool" | "date";
export type Ctx = Record<string, string>;
export interface Source {
  /** Context keys the surface passes (`?` marks optional). */
  context: string[];
  /** Every printable or testable fact, by dotted path. */
  fields: Record<string, Kind>;
  /** A rate or pts field -> the interval that must be printed with it. */
  intervals?: Record<string, string>;
  build(evalsDir: string, ctx: Ctx, f: Files): Obj | null;
  /** Every context the source can be built for, for `explain <term>` and the tests. */
  contexts(evalsDir: string, f: Files): Ctx[];
}

const ci = (c: unknown): { low: number; high: number } | null => { const x = c as Obj | undefined; return x && x.low !== undefined ? { low: Number(x.low), high: Number(x.high) } : null; };
const iv = (x: { low: number; high: number }) => ({ low: x.low, high: x.high });
const runsWith = (f: Files, key: "suites" | "tasks", id: string) => f.runs.filter((r) => (r[key] as Obj | undefined)?.[id] !== undefined);
const pickRun = (f: Files, key: "suites" | "tasks", id: string, runId?: string) => { const rs = runsWith(f, key, id); return runId ? rs.find((r) => r.run_id === runId) : rs[rs.length - 1]; };
const gateOf = (f: Files, suite: string): Obj | null => { const file = f.suites.find((s) => s.name === suite); return ((file?.gate as Obj | undefined) ?? ((f.config.gates as Obj | undefined)?.[suite] as Obj | undefined)) ?? null; };

function split(x: unknown) {
  const s = x as Obj | null | undefined;
  if (!s || s.tpr === undefined) return { ran: false };
  const m = (s.matrix as Obj) ?? {}; const n = (k: string) => Number(m[k] ?? 0);
  const tp = n("tp"), fn = n("fn"), fp = n("fp"), tn = n("tn"), unknown = n("unknown");
  return { ran: true, tpr: Number(s.tpr), tnr: Number(s.tnr), tpr_ci: ci(s.tpr_ci) ?? iv(wilson(tp, tp + fn)), tnr_ci: ci(s.tnr_ci) ?? iv(wilson(tn, tn + fp)), tp, fn, fp, tn, unknown, n: tp + fn + fp + tn + unknown, ran_at: s.ran_at ? String(s.ran_at).slice(0, 10) : null };
}
const splitFields = (p: string): Record<string, Kind> => ({ [`${p}.ran`]: "bool", [`${p}.tpr`]: "rate", [`${p}.tnr`]: "rate", [`${p}.tpr_ci`]: "interval", [`${p}.tnr_ci`]: "interval", [`${p}.tp`]: "count", [`${p}.fn`]: "count", [`${p}.fp`]: "count", [`${p}.tn`]: "count", [`${p}.unknown`]: "count", [`${p}.n`]: "count", [`${p}.ran_at`]: "date" });

export const SOURCES: Record<string, Source> = {
  judge: {
    context: ["judge"],
    fields: { judge: "text", failure_mode: "text", status: "enum", stale_reason: "enum", threshold: "percent", model: "text", labels: "count", labels_fail: "count", labels_pass: "count", few_shot: "count", used_by: "count", ...splitFields("dev"), ...splitFields("test"), "splits.train": "count", "splits.dev": "count", "splits.test": "count" },
    intervals: { "dev.tpr": "dev.tpr_ci", "dev.tnr": "dev.tnr_ci", "test.tpr": "test.tpr_ci", "test.tnr": "test.tnr_ci" },
    build(evalsDir, ctx, f) {
      const j = f.judges.find((x) => x.name === ctx.judge); if (!j) return null;
      const threshold = Number((f.config.judges as Obj | undefined)?.trust_threshold ?? 90);
      const mode = String(j.judge?.failure_mode ?? j.name); const labels = [...labelsFor(evalsDir, mode).values()];
      const c = j.calibration; const sp = (c?.splits as Obj | undefined) ?? {}; const len = (k: string) => (((sp[k] as Obj | undefined)?.trace_ids as unknown[]) ?? []).length;
      return { judge: j.name, failure_mode: mode, status: judgeStatus(j, threshold).status, stale_reason: c?.stale_reason ?? null, threshold, model: j.judge?.model ?? null, labels: labels.length, labels_fail: labels.filter((l) => l.label === "Fail").length, labels_pass: labels.filter((l) => l.label === "Pass").length, few_shot: ((j.judge?.few_shot as unknown[]) ?? []).length, used_by: f.tasks.filter((t) => ((t.checks as Obj[]) ?? []).some((ch) => ch.type === "judge" && (ch.judge ?? ch.failure_mode) === j.name)).length, dev: split(c?.dev), test: split(c?.test), splits: { train: len("train"), dev: len("dev"), test: len("test") } };
    },
    contexts: (_d, f) => f.judges.map((j) => ({ judge: j.name })),
  },

  suite: {
    context: ["suite", "run?"],
    fields: { suite: "text", kind: "enum", run_id: "text", pass_rate: "rate", pass_rate_ci: "interval", pass_at_1: "rate", pass_at_1_ci: "interval", pass_hat_k: "rate", pass_hat_k_ci: "interval", k: "count", n_tasks: "count", n_trials: "count", infra_errors: "count", unknown_rate: "percent", excluded_judges: "text", excluded_count: "count", "gate.exists": "bool", "gate.min_pass_rate": "percent", "gate.max_drop_pts": "points", "gate.report_only": "bool", below_min: "bool", "prev.exists": "bool", "prev.run_id": "text", "prev.delta": "pts", "prev.delta_ci": "pts_interval", "prev.significant": "bool", "prev.gate_passed": "bool", corrected: "bool", corrected_by: "text", graduate_ready: "count", saturated: "bool" },
    intervals: { pass_rate: "pass_rate_ci", pass_at_1: "pass_at_1_ci", pass_hat_k: "pass_hat_k_ci", "prev.delta": "prev.delta_ci" },
    build(evalsDir, ctx, f) {
      const run = pickRun(f, "suites", ctx.suite!, ctx.run); if (!run) return null;
      const s = (run.suites as Record<string, Obj>)[ctx.suite!]!;
      const suiteTrials = Object.values((run.tasks as Record<string, Obj>) ?? {}).filter((t) => t.suite === ctx.suite).flatMap((t) => (t.trials as Obj[]) ?? []);
      const nTrials = Number(s.n_trials ?? suiteTrials.filter((t) => !t.infra_error).length), nTasks = Number(s.n_tasks ?? 0);
      const suiteJudges = new Set(f.tasks.filter((t) => t.suite === ctx.suite).flatMap((t) => ((t.checks as Obj[]) ?? []).filter((c) => c.type === "judge").map((c) => String(c.judge ?? c.failure_mode))));
      const corrected = ((run.judge_corrections as Obj[]) ?? []).map((j) => String(j.judge)).filter((j) => suiteJudges.has(j));
      const grad = graduationProposals(evalsDir); const ready = grad.proposals.filter((p) => p.from === ctx.suite).length; const sat = grad.saturation.find((x) => x.suite === ctx.suite);
      const g = gateOf(f, ctx.suite!); const excluded = ((s.excluded_judges as string[]) ?? []);
      const rs = runsWith(f, "suites", ctx.suite!); const prevRun = rs[rs.indexOf(run) - 1];
      let prev: Obj = { exists: false };
      if (prevRun) { const d = evaluateGates(compareRuns(evalsDir, String(prevRun.run_id), String(run.run_id))).suites.find((x) => x.name === ctx.suite); if (d) prev = { exists: true, run_id: prevRun.run_id, delta: d.delta, delta_ci: d.ci, significant: d.significant, gate_passed: d.gate_result ? d.gate_result.passed : null }; }
      const kind = f.suites.find((x) => x.name === ctx.suite)?.kind ?? ctx.suite;
      return { suite: ctx.suite, kind, run_id: run.run_id, pass_rate: Number(s.pass_rate), pass_rate_ci: ci(s.ci) ?? iv(wilson(Math.round((Number(s.pass_rate) * nTrials) / 100), nTrials)), pass_at_1: Number(s.pass_at_1), pass_at_1_ci: iv(wilson(Math.round((Number(s.pass_at_1) * nTrials) / 100), nTrials)), pass_hat_k: Number(s.pass_hat_k), pass_hat_k_ci: iv(wilson(Math.round((Number(s.pass_hat_k) * nTasks) / 100), nTasks)), k: Number(s.k ?? 5), n_tasks: nTasks, n_trials: nTrials, infra_errors: Number(s.infra_errors ?? suiteTrials.filter((t) => t.infra_error).length), corrected: corrected.length > 0, corrected_by: corrected.length ? corrected.join(", ") : null, graduate_ready: ready, saturated: Boolean(sat), unknown_rate: Number(s.unknown_rate ?? 0), excluded_judges: excluded.length ? excluded.join(", ") : null, excluded_count: excluded.length, gate: { exists: Boolean(g), min_pass_rate: g?.min_pass_rate ?? null, max_drop_pts: g?.max_drop_pts ?? null, report_only: Boolean(g?.report_only) }, below_min: g?.min_pass_rate !== undefined && Number(s.pass_rate) < Number(g.min_pass_rate), prev };
    },
    contexts: (_d, f) => { const last = f.runs[f.runs.length - 1]; return last ? Object.keys((last.suites as Obj) ?? {}).map((suite) => ({ suite })) : []; },
  },

  task: {
    context: ["task", "run?"],
    fields: { task: "text", suite: "text", run_id: "text", passed: "count", trials: "count", infra_errors: "count", pass_rate: "rate", pass_rate_ci: "interval", flaky: "bool", likely_broken: "bool", failed_check: "text", failed_check_type: "enum", first_failed: "count", first_infra: "count" },
    intervals: { pass_rate: "pass_rate_ci" },
    build(_d, ctx, f) {
      const run = pickRun(f, "tasks", ctx.task!, ctx.run); if (!run) return null;
      const t = (run.tasks as Record<string, Obj>)[ctx.task!]!; const all = (t.trials as Obj[]) ?? []; const scored = all.filter((x) => !x.infra_error);
      const passed = scored.filter((x) => x.pass).length; const counts = new Map<string, number>();
      for (const x of scored) for (const c of (x.failed_checks as string[]) ?? []) counts.set(c, (counts.get(c) ?? 0) + 1);
      const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
      const task = f.tasks.find((x) => x.id === ctx.task); const ctype = top ? (((task?.checks as Obj[]) ?? []).find((c) => c.id === top)?.type ?? null) : null;
      const at = (pred: (x: Obj) => boolean) => { const i = all.findIndex(pred); return i < 0 ? null : i + 1; };
      return { failed_check_type: ctype, first_failed: at((x) => !x.infra_error && !x.pass), first_infra: at((x) => Boolean(x.infra_error)), task: ctx.task, suite: t.suite, run_id: run.run_id, passed, trials: scored.length, infra_errors: all.length - scored.length, pass_rate: scored.length ? (100 * passed) / scored.length : null, pass_rate_ci: iv(wilson(passed, scored.length)), flaky: Boolean(t.flaky), likely_broken: Boolean(t.likely_broken), failed_check: top };
    },
    contexts: (_d, f) => { const last = f.runs[f.runs.length - 1]; return last ? Object.keys((last.tasks as Obj) ?? {}).map((task) => ({ task })) : []; },
  },

  delta: {
    context: ["a", "b", "suite"],
    fields: { a: "text", b: "text", suite: "text", rate_a: "rate", rate_a_ci: "interval", rate_b: "rate", rate_b_ci: "interval", delta: "pts", delta_ci: "pts_interval", significant: "bool", flips: "count", n_tasks: "count", "gate.exists": "bool", "gate.report_only": "bool", "gate.passed": "bool", "gate.min_pass_rate": "percent", "gate.max_drop_pts": "points", below_min: "bool" },
    intervals: { rate_a: "rate_a_ci", rate_b: "rate_b_ci", delta: "delta_ci" },
    build(evalsDir, ctx, f) {
      if (!f.runs.some((r) => r.run_id === ctx.a) || !f.runs.some((r) => r.run_id === ctx.b)) return null;
      const d = evaluateGates(compareRuns(evalsDir, ctx.a!, ctx.b!)).suites.find((x) => x.name === ctx.suite); if (!d) return null;
      const wil = (rate: number) => iv(wilson(Math.round((rate * d.n_tasks) / 100), d.n_tasks));
      return { a: ctx.a, b: ctx.b, suite: d.name, rate_a: d.a, rate_a_ci: ci(d.a_ci) ?? wil(d.a), rate_b: d.b, rate_b_ci: ci(d.b_ci) ?? wil(d.b), delta: d.delta, delta_ci: d.ci, significant: d.significant, flips: d.flips, n_tasks: d.n_tasks, gate: { exists: Boolean(d.gate), report_only: Boolean(d.gate?.report_only), passed: d.gate_result ? d.gate_result.passed : null, min_pass_rate: d.gate?.min_pass_rate ?? null, max_drop_pts: d.gate?.max_drop_pts ?? null }, below_min: d.gate?.min_pass_rate !== undefined && d.b < Number(d.gate.min_pass_rate) };
    },
    contexts: (_d, f) => { const [a, b] = f.runs.slice(-2); return a && b ? Object.keys((b.suites as Obj) ?? {}).map((suite) => ({ a: String(a.run_id), b: String(b.run_id), suite })) : []; },
  },

  failure_mode: {
    context: ["mode"],
    fields: { mode: "text", judge: "text", severity: "enum", labels: "count", labels_fail: "count", labels_pass: "count", fail_rate: "rate", fail_rate_ci: "interval", has_judge: "bool", judge_status: "enum", has_code_check: "bool", tasks: "count", retired: "bool" },
    intervals: { fail_rate: "fail_rate_ci" },
    build(evalsDir, ctx, f) {
      const m = f.modes.find((x) => x.name === ctx.mode); if (!m) return null;
      const ls = [...labelsFor(evalsDir, ctx.mode!).values()]; const fail = ls.filter((l) => l.label === "Fail").length;
      const j = f.judges.find((x) => x.name === ctx.mode || x.judge?.failure_mode === ctx.mode);
      const threshold = Number((f.config.judges as Obj | undefined)?.trust_threshold ?? 90);
      const checks = f.tasks.flatMap((t) => ((t.checks as Obj[]) ?? []).filter((c) => c.failure_mode === ctx.mode || c.judge === ctx.mode).map((c) => ({ t, c })));
      return { mode: ctx.mode, judge: j?.judge ? j.name : null, severity: m.severity ?? null, labels: ls.length, labels_fail: fail, labels_pass: ls.length - fail, fail_rate: ls.length ? (100 * fail) / ls.length : null, fail_rate_ci: iv(wilson(fail, ls.length)), has_judge: Boolean(j?.judge), judge_status: j ? judgeStatus(j, threshold).status : "none", has_code_check: checks.some((x) => x.c.type === "code"), tasks: new Set(checks.map((x) => x.t.id)).size, retired: Boolean(m.retired) };
    },
    contexts: (_d, f) => f.modes.filter((m) => !m.retired).map((m) => ({ mode: String(m.name) })),
  },

  run: {
    context: ["run?"],
    fields: { run_id: "text", branch: "text", commit: "text", tasks: "count", trials: "count", infra_error_rate: "percent", cost_usd: "usd", started_at: "date" },
    build(_d, ctx, f) {
      const run = ctx.run ? f.runs.find((r) => r.run_id === ctx.run) : f.runs[f.runs.length - 1]; if (!run) return null;
      const tasks = Object.values((run.tasks as Record<string, Obj>) ?? {});
      return { run_id: run.run_id, branch: run.branch ?? null, commit: run.commit ?? null, tasks: tasks.length, trials: tasks.reduce((n, t) => n + ((t.trials as unknown[]) ?? []).length, 0), infra_error_rate: Number(run.infra_error_rate ?? 0), cost_usd: Number(run.cost_usd ?? 0), started_at: String(run.started_at ?? "").slice(0, 10) || null };
    },
    contexts: (_d, f) => (f.runs.length ? [{}] : []),
  },

  queue: {
    context: ["batch?"],
    fields: { batch: "text", items: "count", labelled: "count", left: "count", fails: "count" },
    build(_d, ctx, f) {
      const b = ctx.batch ? f.batches.find((x) => x.name === ctx.batch) : f.batches[f.batches.length - 1]; if (!b) return null;
      const ids = new Set(((b.items as Obj[]) ?? []).map((i) => String(i.trace_id)));
      const latest = new Map<string, Obj>(); for (const l of f.labels) if (ids.has(String(l.trace_id))) latest.set(`${l.trace_id}|${l.failure_mode}`, l);
      const labelled = new Set([...latest.values()].map((l) => String(l.trace_id)));
      const fails = new Set([...latest.values()].filter((l) => l.label === "Fail").map((l) => String(l.trace_id)));
      return { batch: b.name, items: ids.size, labelled: labelled.size, left: ids.size - labelled.size, fails: fails.size };
    },
    contexts: (_d, f) => f.batches.map((b) => ({ batch: String(b.name) })),
  },

  coverage: {
    context: ["map"],
    fields: { map: "text", label: "text", configured: "bool", total: "count", with_task: "count", checked: "count", guarded: "count", planned: "count", none: "count", checked_share: "percent" },
    build(evalsDir, ctx, f) {
      const m = computeCoverage(evalsDir, { files: f }).maps[ctx.map as "spec"]; if (!m) return null;
      const t = m.totals; const checked = t.checked + t.guarded;
      return { map: ctx.map, label: m.label, configured: m.configured, total: t.total, with_task: t.total - t.none, checked, guarded: t.guarded, planned: t.planned, none: t.none, checked_share: t.total ? (100 * checked) / t.total : null };
    },
    contexts: () => ["spec", "surface", "risk"].map((map) => ({ map })),
  },

  pending: {
    context: [],
    fields: { count: "count", branch: "text", commit_branch: "text", on_evals_branch: "bool" },
    build(evalsDir) {
      const dir = resolve(evalsDir); const repo = dirname(dir);
      try {
        const lines = execFileSync("git", ["status", "--porcelain", "--untracked-files=all", "--", dir], { cwd: repo, encoding: "utf8" }).split("\n").filter(Boolean);
        const branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
        return { count: lines.length, branch, commit_branch: commitBranch(branch, lines.map((l) => l.slice(3).trim())), on_evals_branch: branch.startsWith("evals/") };
      } catch { return null; }
    },
    contexts: () => [{}],
  },
};

/** Build the facts for one source and context; the context keys are facts too, so templates can name them. */
export function factsFor(evalsDir: string, source: string, ctx: Ctx, f = loadFiles(evalsDir)): Obj | null {
  const s = SOURCES[source]; if (!s) return null;
  const facts = s.build(evalsDir, ctx, f);
  return facts ? { ...ctx, ...facts } : null;
}

