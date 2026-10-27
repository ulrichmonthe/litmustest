// Graduation and saturation: capability tasks that passed every trial in the last three runs are proposed for the
// regression suite; a capability suite above 90% raises a saturation alert. litmustest doctor prints the alerts.
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { loadFiles, overview } from "./server/overview.ts";
import type { App } from "./server/app.ts";

type Obj = Record<string, unknown>;
export interface Proposal { task: string; from: string; to: string; runs: string[]; trials: number }
export interface GraduateResult { proposals: Proposal[]; saturation: { suite: string; pass_rate: number }[]; runs_considered: string[] }

export function graduationProposals(evalsDir: string, opts: { runs?: number; threshold?: number } = {}): GraduateResult {
  const f = loadFiles(evalsDir); const n = opts.runs ?? 3; const threshold = opts.threshold ?? 90;
  const capTasks = f.tasks.filter((t) => f.suites.find((s) => s.name === t.suite)?.kind === "capability");
  const proposals: Proposal[] = [];
  for (const t of capTasks) {
    const id = String(t.id);
    const runs = f.runs.filter((r) => (r.tasks as Record<string, Obj>)?.[id]).slice(-n);
    if (runs.length < n) continue;
    let trials = 0;
    const allPass = runs.every((r) => { const tr = (((r.tasks as Record<string, Obj>)[id]!.trials as Obj[]) ?? []).filter((x) => !x.infra_error); trials += tr.length; return tr.length > 0 && tr.every((x) => x.pass); });
    if (allPass) proposals.push({ task: id, from: String(t.suite), to: "regression", runs: runs.map((r) => String(r.run_id)), trials });
  }
  const latest = f.runs[f.runs.length - 1];
  const saturation = latest ? Object.entries((latest.suites as Record<string, Obj>) ?? {}).filter(([name, s]) => f.suites.find((x) => x.name === name)?.kind === "capability" && Number(s.pass_rate) > threshold).map(([suite, s]) => ({ suite, pass_rate: Number(s.pass_rate) })) : [];
  return { proposals, saturation, runs_considered: f.runs.slice(-n).map((r) => String(r.run_id)) };
}

/** Apply graduations as one multi-file change: the task moves suites and both suite lists follow, validated together. */
export function applyGraduations(app: App, taskIds: string[], to = "regression"): { moved: string[]; refused: { task: string; message: string }[] } {
  const moved: string[] = []; const refused: { task: string; message: string }[] = [];
  for (const id of taskIds) {
    const f = loadFiles(app.evalsDir);
    const target = f.suites.find((s) => s.name === to); if (!target) throw new Error(`no suite ${to}`);
    const t = f.tasks.find((x) => x.id === id); if (!t) { refused.push({ task: id, message: "no such task" }); continue; }
    const from = String(t.suite); const fromSuite = f.suites.find((s) => s.name === from);
    const taskPath = findTaskPath(app.evalsDir, id); if (!taskPath) { refused.push({ task: id, message: "task file not found" }); continue; }
    if (from === to) { refused.push({ task: id, message: `already in ${to}` }); continue; }
    const items: { path: string; data: unknown }[] = [{ path: taskPath, data: { ...t, suite: to, graduated_from: from } }];
    if (fromSuite?.tasks) items.push({ path: `suites/${from}.yaml`, data: { ...fromSuite, tasks: (fromSuite.tasks as string[]).filter((x) => x !== id) } });
    if (target.tasks) items.push({ path: `suites/${to}.yaml`, data: { ...target, tasks: [...new Set([...(target.tasks as string[]), id])] } });
    const r = app.putFiles(items);
    if (r.status !== 200) { refused.push({ task: id, message: String(((r.body as Obj).problems as Obj[] | undefined)?.[0]?.message ?? (r.body as Obj).message ?? r.status) }); continue; }
    moved.push(id);
  }
  return { moved, refused };
}
function findTaskPath(evalsDir: string, id: string): string | undefined {
  const walk = (d: string, rel: string): string | undefined => { for (const e of readdirSync(d, { withFileTypes: true })) { if (e.isDirectory()) { const r = walk(join(d, e.name), `${rel}${e.name}/`); if (r) return r; } else if (e.name === `${id}.yaml`) return `${rel}${e.name}`; } return undefined; };
  return walk(join(evalsDir, "tasks"), "tasks/");
}

export function doctor(evalsDir: string): { alerts: Obj[]; proposals: Proposal[]; saturation: { suite: string; pass_rate: number }[]; next: string } {
  const o = overview(evalsDir) as Obj; const g = graduationProposals(evalsDir);
  const alerts = (o.alerts as Obj[]).slice();
  if (g.proposals.length) alerts.push({ kind: "Graduation", level: "neutral", title: `${g.proposals.length} capability task${g.proposals.length > 1 ? "s" : ""} passed every trial for ${g.runs_considered.length} runs.`, body: "Graduate them to regression so they stay guarded while capability keeps climbing.", action: "Review and graduate", href: "#/tasks" });
  const next = alerts.length ? `${alerts[0]!.title} ${alerts[0]!.action}: ${alerts[0]!.href}` : "Nothing needs attention. Next: ingest more traces or write harder capability tasks.";
  return { alerts, proposals: g.proposals, saturation: g.saturation, next };
}
