// Home (docs/stories/redesign.md, R2): the verdict, every suite's gate, and "Up next", ranked by fixed rules from the files.
// Tier 1 blocks the merge, tier 2 keeps the numbers honest, tier 3 makes the evals better. No model is involved.
import { compareRuns, evaluateGates } from "../compare.ts";
import { gatherNotes } from "../discover.ts";
import { judgeStatus, loadFiles, modesView, overview } from "./overview.ts";

type Obj = Record<string, unknown>;
export interface Gate { suite: string; kind: string; n_tasks: number; rate: number | null; ci: { low: number; high: number } | null; min: number | null; max_drop: number | null; report_only: boolean; gated: boolean; passed: boolean; below_min: boolean; dropped: boolean; delta: { pts: number; ci: { low: number; high: number }; significant: boolean; vs: string } | null }
export interface UpNext { tier: 1 | 2 | 3; level: "bad" | "warn" | "todo"; title: string; reason: string; place: "Ship" | "Teach" | "Cover"; action: string; href: string; term?: string }
export interface Decision { task: string; suite: string; n: number; check: string; failure_mode: string; judge: string }

const enc = encodeURIComponent;
const runTasks = (r: Obj | undefined) => ((r?.tasks as Record<string, Obj>) ?? {});

/** Broke flips whose failing trial failed only on judge checks: a person decides whether the judge or the agent is wrong. */
function decisions(f: ReturnType<typeof loadFiles>, latest: Obj, flips: { task: string; suite: string; change: string; expected?: boolean }[]): Decision[] {
  const out: Decision[] = [];
  for (const x of flips) {
    if (x.change !== "Broke" || x.expected) continue;
    const task = f.tasks.find((t) => t.id === x.task); const checks = (task?.checks as Obj[]) ?? [];
    const trials = (runTasks(latest)[x.task]?.trials as Obj[]) ?? [];
    const i = trials.findIndex((t) => !t.pass && !t.infra_error); if (i < 0) continue;
    const failed = (trials[i]!.failed_checks as string[]) ?? [];
    const judged = failed.map((id) => checks.find((c) => c.id === id)).filter((c): c is Obj => Boolean(c));
    if (!judged.length || judged.some((c) => c.type !== "judge")) continue;
    const c = judged[0]!;
    out.push({ task: x.task, suite: x.suite, n: i + 1, check: String(c.id), failure_mode: String(c.failure_mode), judge: String(c.judge ?? c.failure_mode) });
  }
  return out;
}

export function home(evalsDir: string): Obj {
  const o = overview(evalsDir); const f = loadFiles(evalsDir);
  const latest = f.runs[f.runs.length - 1]; const prev = f.runs[f.runs.length - 2];
  const threshold = Number((f.config.judges as Obj | undefined)?.trust_threshold ?? 90);
  const comparison = latest && prev ? compareRuns(evalsDir, String(prev.run_id), String(latest.run_id)) : null;
  if (comparison) evaluateGates(comparison);

  const gates: Gate[] = (o.suites as Obj[]).map((s) => {
    const cur = s.current as Obj | null; const g = (s.gate as Obj | null) ?? {}; const d = s.delta as Obj | null;
    const min = g.min_pass_rate !== undefined ? Number(g.min_pass_rate) : null; const maxDrop = g.max_drop_pts !== undefined ? Number(g.max_drop_pts) : null;
    const rate = cur ? Number(cur.pass_rate) : null; const ci = cur?.ci ? { low: Number((cur.ci as Obj).low), high: Number((cur.ci as Obj).high) } : null;
    const below = min !== null && rate !== null && rate < min;
    const dropped = Boolean(maxDrop !== null && d && d.significant && Number(d.pts) < -maxDrop);
    const report = Boolean(g.report_only); const gated = !report && (min !== null || maxDrop !== null);
    const sd = comparison?.suites.find((x) => x.name === s.name);
    const passed = sd?.gate_result ? sd.gate_result.passed : report || (!below && !dropped);
    return { suite: String(s.name), kind: String(s.kind), n_tasks: Number(s.n_tasks), rate, ci, min, max_drop: maxDrop, report_only: report, gated, passed, below_min: below, dropped,
      delta: d ? { pts: Number(d.pts), ci: d.ci as { low: number; high: number }, significant: Boolean(d.significant), vs: String(d.vs) } : null };
  });

  const flips = comparison?.flips ?? [];
  const decide = latest ? decisions(f, latest, flips) : [];
  const failing = gates.filter((g) => g.gated && g.rate !== null && !g.passed);
  const state = !latest ? "no_runs" : failing.length ? "hold" : "safe";

  const up: UpNext[] = [];
  // 1. what blocks the merge
  for (const g of failing) {
    const name = g.suite[0]!.toUpperCase() + g.suite.slice(1);
    up.push({ tier: 1, level: "bad", place: "Ship", action: "See what changed", href: "#/ship", term: "gate",
      title: g.dropped && g.delta ? `${name} fell ${Math.abs(g.delta.pts)} points` : `${name} is below its gate`,
      reason: `${g.rate}%${g.ci ? ` (could be ${Math.round(g.ci.low)}–${Math.round(g.ci.high)}%)` : ""}${g.below_min ? `; needs ${g.min}%` : `; dropped more than the ${g.max_drop} points allowed`}` });
  }
  if (decide.length) up.push({ tier: 1, level: "bad", place: "Ship", action: `Decide ${decide.length}`, href: "#/ship/decide", term: "judge",
    title: `${decide.length} broken ${decide.length === 1 ? "task fails" : "tasks fail"} only on a judge`, reason: "Say whether the judge or the agent is right" });
  // 2. what keeps the numbers honest
  for (const j of f.judges) {
    const s = judgeStatus(j, threshold); const href = `#/teach/judges/${enc(j.name)}`;
    if (s.status === "stale") up.push({ tier: 2, level: "warn", place: "Teach", action: "Run on dev set", href, term: "stale", title: `${j.name} judge is stale`, reason: "Changed after its test; left out of scores" });
    else if (s.status === "dev") up.push({ tier: 2, level: "warn", place: "Teach", action: "Open judge", href, term: "calibration", title: `${j.name} judge is below the bar`, reason: `Needs ${threshold}% on both rates before its test set runs` });
    else if (s.status === "untested" && f.tasks.some((t) => ((t.checks as Obj[]) ?? []).some((c) => c.type === "judge" && (c.judge ?? c.failure_mode) === j.name))) up.push({ tier: 2, level: "warn", place: "Teach", action: "Open judge", href, term: "calibration", title: `${j.name} judge has never been checked`, reason: "Tasks use it; it counts only once trusted" });
  }
  for (const [tid, t] of Object.entries(runTasks(latest))) {
    const suite = String(t.suite ?? f.tasks.find((x) => x.id === tid)?.suite ?? "");
    if (t.likely_broken) up.push({ tier: 2, level: "warn", place: "Cover", action: "Open task", href: `#/cover/tasks/${enc(suite)}/${enc(tid)}`, term: "likely_broken", title: `${tid} is likely broken`, reason: "Fails every trial; its reference solution passes" });
    else if (t.flaky) { const n = ((t.trials as Obj[]) ?? []).length; up.push({ tier: 2, level: "warn", place: "Ship", action: `Read ${n} trials`, href: `#/library/runs/${enc(String(latest!.run_id))}/${enc(tid)}/1`, term: "flaky", title: `${tid} is flaky`, reason: "Passes some trials and fails others" }); }
  }
  // 3. what makes the evals better
  const batch = f.batches[f.batches.length - 1];
  if (batch) {
    const items = (batch.items as { trace_id: string }[]) ?? []; const done = items.filter((i) => f.labels.some((l) => l.trace_id === i.trace_id)).length;
    if (done < items.length) up.push({ tier: 3, level: "todo", place: "Teach", action: "Start labeling", href: "#/teach/label", term: "label", title: `${items.length - done} conversations to label`, reason: `Only people can do this · ${done} of ${items.length} done` });
  }
  const loose = gatherNotes(evalsDir).notes.filter((n) => n.failure_mode === "overall" && n.label === "Fail");
  if (loose.length) up.push({ tier: 3, level: "todo", place: "Teach", action: "Group notes", href: "#/teach/group", term: "failure_mode", title: `${loose.length} notes are not in a failure mode`, reason: "Proposed as a change; nothing is saved until you accept" });
  const gaps = modesView(evalsDir, f).filter((m) => m.severity === "high" && (m.grader as Obj | undefined)?.status !== "trusted");
  if (gaps.length) up.push({ tier: 3, level: "todo", place: "Cover", action: "See the gaps", href: "#/cover", term: "coverage", title: `${gaps.length} high-severity ${gaps.length === 1 ? "gap" : "gaps"}`, reason: `No check you can trust: ${gaps.map((m) => m.name).join(", ")}` });
  const ready = (o.alerts as Obj[]).find((a) => a.kind === "Graduation");
  if (ready) { const n = Number(String(ready.title).split(" ")[0]); up.push({ tier: 3, level: "todo", place: "Cover", action: "Review", href: "#/cover/tasks/capability?status=graduate", term: "graduation", title: `${n} capability ${n === 1 ? "task is" : "tasks are"} ready to graduate`, reason: "Passed every trial for 3 runs" }); }

  const count = (c: string) => flips.filter((x) => x.change === c).length;
  return {
    state, run: o.run, previous: o.previous, gates,
    counts: comparison ? { broke: count("Broke"), fixed: count("Fixed"), flaky: count("Flaky"), expected: flips.filter((x) => x.expected).length } : null,
    decide, up_next: up.sort((a, b) => a.tier - b.tier),
    labels: o.labels,
  };
}
