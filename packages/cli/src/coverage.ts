// Eval coverage: which parts of the application would an eval catch if they broke?
// Six maps, and it says which are measured wherever it reports:
//   spec     - test-case ids found in your docs (coverage.spec)
//   surface  - API routes or tool names the product exposes, matched against the calls trials actually made (coverage.surface)
//   risk     - failure modes by severity (always on)
//   traffic  - the surface items production traces actually used, weighted by how many traces used them
//   code     - lines that ran while the suites ran, from an lcov or Istanbul report your own process writes (coverage.code)
//   frontend - pages of the product, matched against the page URLs trials opened (coverage.frontend)
// It does not judge whether a check is a good check, and it does not draft tasks for gaps.
import { existsSync, globSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { loadFiles } from "./server/overview.ts";
import { storeDirFor } from "./server/transcripts.ts";
import { traceView } from "./trace_view.ts";

type Obj = Record<string, unknown>;
export type Depth = "none" | "planned" | "checked" | "guarded";
export type MapKey = "spec" | "surface" | "risk" | "traffic" | "code" | "frontend";
export const MAP_KEYS: MapKey[] = ["spec", "surface", "risk", "traffic", "code", "frontend"];
export interface CoveringTask { id: string; suite: string; status: "pass" | "fail" | "not_run"; via: "covers" | "source" | "called" | "check"; note?: string }
export interface CoverageItem { id: string; area: string; title?: string; priority?: string; depth: Depth; failing: boolean; tasks: CoveringTask[]; /** How much this item counts in a weighted map: traces that used it, or lines in the file. */ weight?: number; /** The covered part of the weight, where an item can be partly covered (lines that ran). */ covered?: number }
export interface AreaRow { name: string; total: number; planned: number; checked: number; guarded: number }
export interface Totals { total: number; none: number; planned: number; checked: number; guarded: number }
export interface CoverageMap { key: MapKey; label: string; configured: boolean; reason?: string; items: CoverageItem[]; areas: AreaRow[]; totals: Totals; unknown_covers: string[]; /** Set on maps where items differ in size: the headline is the covered share of the weight, not of the item count. */ weighted?: { unit: string; total: number; covered: number } }
export interface Coverage { run_id: string | null; maps: Record<MapKey, CoverageMap>; scope: { measures: string[]; not_measured: string[] }; warnings: string[] }

export const SCOPE = {
  measures: [
    "Spec: every test-case id in the files under coverage.spec, covered by a task's covers: list or its source: spec:<id>.",
    "Surface: every route (or tool) under coverage.surface, covered when a trial in the latest run called it or a task's covers: lists it.",
    "Risk: every failure mode, covered by a task with a check for it that counts (code, outcome, transcript, or a trusted judge).",
    "Traffic: every surface item an ingested production trace used, weighted by how many traces used it. Needs coverage.surface and traces under datasets/traces.",
    "Code: lines that ran while the suites ran, read from the lcov or Istanbul report named by coverage.code.report. Your agent's own process has to write that report; litmustest instruments nothing.",
    "Frontend: every page under coverage.frontend, covered when a trial in the latest run opened its URL or a task's covers: lists it.",
  ],
  not_measured: [
    "Whether a check is a good check: covered means a check would run, not that it would catch every bug.",
    "Drafting tasks for gaps: the gap list says what is missing; writing the task is still yours.",
  ],
};

const DEPTH_RANK: Record<Depth, number> = { none: 0, planned: 1, checked: 2, guarded: 3 };

/** Depth from the tasks that cover an item: guarded needs a passing regression task, checked any passing task, planned any task. */
export function depthOf(tasks: CoveringTask[]): { depth: Depth; failing: boolean } {
  const counted = tasks.filter((t) => t.via !== "check" || !t.note);
  const failing = tasks.some((t) => t.suite === "regression" && t.status === "fail");
  if (counted.some((t) => t.suite === "regression" && t.status === "pass")) return { depth: "guarded", failing };
  if (counted.some((t) => t.status === "pass")) return { depth: "checked", failing };
  return { depth: tasks.length ? "planned" : "none", failing };
}

function taskStatus(run: Obj | undefined, id: string): CoveringTask["status"] {
  const t = (run?.tasks as Record<string, Obj> | undefined)?.[id]; if (!t) return "not_run";
  const trials = ((t.trials as Obj[]) ?? []).filter((x) => !x.infra_error);
  if (!trials.length) return "not_run";
  return trials.every((x) => x.pass) ? "pass" : "fail";
}

const globs = (root: string, patterns: string[]) => [...new Set(patterns.flatMap((p) => globSync(p, { cwd: root })))].sort();

// ---------------- spec
export function specItems(root: string, cfg: Obj): { items: { id: string; area: string; title?: string; priority?: string }[]; files: string[] } {
  const files = globs(root, (cfg.files as string[]) ?? []);
  const re = new RegExp(String(cfg.id_pattern), "g");
  const areaRe = cfg.area_pattern ? new RegExp(String(cfg.area_pattern)) : null;
  // An id's definition is the line that starts with it (a table row, heading or list item); a mention elsewhere is a cross-reference.
  const defined = new Map<string, { title?: string; priority?: string }>(); const order: string[] = [];
  const clean = (x: string) => x.replace(/\*\*|[*`#>]|(^|\s)_|_(\s|$)/g, "$1$2").replace(/\s+/g, " ").trim();
  for (const f of files) {
    for (const line of readFileSync(join(root, f), "utf8").split("\n")) {
      for (const m of line.matchAll(re)) {
        const id = m[0];
        if (!order.includes(id)) order.push(id);
        const lead = line.slice(0, m.index ?? 0);
        if (!/^[\s|#*>\-+\d.`]*$/.test(lead) || defined.has(id)) continue;
        const rest = line.slice((m.index ?? 0) + id.length);
        const cells = rest.includes("|") ? rest.split("|").map(clean).filter(Boolean) : [clean(rest.replace(/^[\s:.\-–—]+/, ""))].filter(Boolean);
        const pIx = cells.findIndex((c) => /^P[0-4]$/i.test(c));
        const priority = pIx >= 0 ? cells.splice(pIx, 1)[0]!.toUpperCase() : undefined;
        const title = cells.join(" · ").slice(0, 200);
        defined.set(id, { ...(title ? { title } : {}), ...(priority ? { priority } : {}) });
      }
    }
  }
  const items = order.map((id) => ({ id, area: areaRe ? (areaRe.exec(id)?.[1] ?? id) : id.replace(/[-_.]?\d+$/, ""), ...(defined.get(id) ?? {}) }));
  return { items, files };
}

// ---------------- surface
const METHODS = ["get", "post", "put", "patch", "delete"];
/** Route decorators and calls in source files. Resolves FastAPI/Flask-style router prefixes declared in the same file. */
export function scanRoutes(root: string, patterns: string[]): string[] {
  const out = new Set<string>();
  for (const f of globs(root, patterns)) {
    const src = readFileSync(join(root, f), "utf8");
    const prefixes = new Map<string, string>();
    for (const m of src.matchAll(/^\s*(\w+)\s*=\s*(?:APIRouter|Blueprint|Router)\(([^)]*)\)/gm)) { const p = /(?:prefix|url_prefix)\s*=\s*["']([^"']*)["']/.exec(m[2]!); prefixes.set(m[1]!, p?.[1] ?? ""); }
    for (const m of src.matchAll(/@?(\w+)\.(get|post|put|patch|delete)\(\s*["'`]([^"'`]+)["'`]/g)) {
      const [, obj, method, path] = m as unknown as [string, string, string, string];
      if (!path.startsWith("/")) continue;
      out.add(`${method.toUpperCase()} ${(prefixes.get(obj) ?? "") + path}`.replace(/(.)\/$/, "$1"));
    }
  }
  return [...out].sort();
}
export function openapiRoutes(root: string, file: string): string[] {
  const raw = readFileSync(join(root, file), "utf8");
  const doc = (file.endsWith(".json") ? JSON.parse(raw) : parseYaml(raw)) as { paths?: Record<string, Record<string, unknown>> };
  return Object.entries(doc.paths ?? {}).flatMap(([p, ops]) => Object.keys(ops).filter((k) => METHODS.includes(k)).map((k) => `${k.toUpperCase()} ${p}`)).sort();
}
const ignored = (id: string, ignore: string[]) => ignore.some((g) => (g.endsWith("*") ? id.startsWith(g.slice(0, -1)) : id === g));
export function surfaceArea(id: string, depth = 2): string {
  const m = /^[A-Z]+ (\/\S*)$/.exec(id); if (!m) return "tools";
  const segs = m[1]!.split("/").filter(Boolean).filter((s) => !s.startsWith("{") && !s.startsWith(":"));
  return "/" + segs.slice(0, depth).join("/");
}
/** "POST /api/classes/{id}/students" -> a matcher for concrete paths. */
function routeMatcher(route: string): { method: string; re: RegExp; specificity: number } | null {
  const m = /^([A-Z]+) (\/\S*)$/.exec(route); if (!m) return null;
  let params = 0;
  const body = m[2]!.split("/").map((s) => { if (/^\{[^}]*:path\}$/.test(s)) { params += 10; return ".+"; } if (/^(\{[^}]+\}|:\w+)$/.test(s)) { params++; return "[^/]+"; } return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }).join("/");
  return { method: m[1]!, re: new RegExp(`^${body || "/"}/?$`), specificity: -params };
}
/** What a recorded tool call touched: a route when it carries a path, else the tool's name. */
export function callTarget(call: Obj): { method?: string; path?: string; name: string } {
  const name = String(call.name ?? ""); const args = (call.args ?? {}) as Obj;
  const path = typeof args.path === "string" ? args.path.split("?")[0] : typeof args.url === "string" ? String(args.url).replace(/^https?:\/\/[^/]+/, "").split("?")[0] : undefined;
  const method = typeof args.method === "string" ? args.method.toUpperCase() : METHODS.find((m) => name.toLowerCase().startsWith(m + "_"))?.toUpperCase() ?? (path ? "GET" : undefined);
  return { name, ...(path ? { path, method } : {}) };
}
export function matchRoute(routes: string[], call: Obj): string | undefined {
  const t = callTarget(call);
  if (!t.path) return routes.includes(t.name) ? t.name : undefined;
  const hits = routes.map((r) => ({ r, m: routeMatcher(r) })).filter((x) => x.m && x.m.method === t.method && x.m.re.test(t.path!)).sort((a, b) => b.m!.specificity - a.m!.specificity);
  return hits[0]?.r;
}

// ---------------- the maps
function build(key: MapKey, label: string, raw: { id: string; area: string; title?: string; priority?: string; tasks: CoveringTask[] }[], unknown: string[] = []): CoverageMap {
  return tally(key, label, raw.map((r) => ({ ...r, ...depthOf(r.tasks) })), unknown);
}
function tally(key: MapKey, label: string, items: CoverageItem[], unknown: string[] = []): CoverageMap {
  const areas = new Map<string, AreaRow>();
  const totals: Totals = { total: 0, none: 0, planned: 0, checked: 0, guarded: 0 };
  for (const it of items) {
    const a = areas.get(it.area) ?? { name: it.area, total: 0, planned: 0, checked: 0, guarded: 0 }; areas.set(it.area, a);
    a.total++; totals.total++; totals[it.depth]++;
    // cumulative: guarded counts as checked and planned too, so the chart's rings nest
    if (DEPTH_RANK[it.depth] >= 1) a.planned++; if (DEPTH_RANK[it.depth] >= 2) a.checked++; if (it.depth === "guarded") a.guarded++;
  }
  return { key, label, configured: true, items, areas: [...areas.values()].sort((a, b) => a.name.localeCompare(b.name)), totals, unknown_covers: unknown };
}
const empty = (key: MapKey, label: string, reason: string): CoverageMap => ({ key, label, configured: false, reason, items: [], areas: [], totals: { total: 0, none: 0, planned: 0, checked: 0, guarded: 0 }, unknown_covers: [] });

export function computeCoverage(evalsDir: string, opts: { run?: Obj; files?: ReturnType<typeof loadFiles> } = {}): Coverage {
  const f = opts.files ?? loadFiles(evalsDir);
  const root = resolve(dirname(evalsDir));
  const cfg = ((f.config as Obj).coverage ?? {}) as Obj;
  const run = opts.run ?? f.runs[f.runs.length - 1];
  const warnings: string[] = [];
  const tasks = f.tasks.map((t) => ({ id: String(t.id), suite: String(t.suite), source: String(t.source ?? ""), covers: ((t.covers as string[]) ?? []).map(String), checks: (t.checks as Obj[]) ?? [], status: taskStatus(run, String(t.id)) }));
  const claimed = new Set(tasks.flatMap((t) => t.covers));
  const used = new Set<string>();

  // spec
  let spec: CoverageMap;
  if (!cfg.spec) spec = empty("spec", "Spec", "Not configured. Add coverage.spec to litmustest.yaml: the files that list your test cases and a pattern for their ids.");
  else {
    const { items, files } = specItems(root, cfg.spec as Obj);
    if (!files.length) warnings.push(`coverage.spec.files matched no files under ${root}`);
    const byLower = new Map(items.map((i) => [i.id.toLowerCase(), i.id]));
    const raw = items.map((i) => ({ ...i, tasks: [] as CoveringTask[] }));
    const ix = new Map(raw.map((r) => [r.id, r]));
    for (const t of tasks) {
      const src = /^spec:(.+)$/.exec(t.source)?.[1]?.toLowerCase();
      if (src && byLower.has(src)) { ix.get(byLower.get(src)!)!.tasks.push({ id: t.id, suite: t.suite, status: t.status, via: "source" }); used.add(`spec:${src}`); }
      for (const c of t.covers) { const id = byLower.get(c.toLowerCase()); if (id) { const r = ix.get(id)!; if (!r.tasks.some((x) => x.id === t.id)) r.tasks.push({ id: t.id, suite: t.suite, status: t.status, via: "covers" }); used.add(c); } }
    }
    spec = build("spec", "Spec", raw);
    if (!items.length) { spec.configured = false; spec.reason = `No ids matching ${String((cfg.spec as Obj).id_pattern)} in ${files.join(", ") || "the configured files"}.`; }
  }

  // The tool calls each task's trials made in the latest run, read once from the transcript store.
  let cached: { byTask: Map<string, Obj[]>; readAny: boolean } | undefined;
  const calls = () => {
    if (cached) return cached;
    const byTask = new Map<string, Obj[]>(); let readAny = false; const store = storeDirFor(evalsDir);
    if (run) for (const t of tasks) {
      const n = (((run.tasks as Record<string, Obj> | undefined)?.[t.id]?.trials as Obj[]) ?? []).length;
      for (let i = 1; i <= n; i++) {
        const file = join(store, String(run.run_id).replace(/[^A-Za-z0-9_.-]/g, ""), t.id.replace(/[^A-Za-z0-9_.-]/g, ""), String(i), "trial.json");
        if (!existsSync(file)) continue; readAny = true;
        byTask.set(t.id, [...(byTask.get(t.id) ?? []), ...(((JSON.parse(readFileSync(file, "utf8")) as Obj).tool_calls as Obj[]) ?? [])]);
      }
    }
    return (cached = { byTask, readAny });
  };

  // surface
  let surfaceRoutes: string[] = [];
  let surface: CoverageMap;
  const sc = cfg.surface as Obj | undefined;
  if (!sc || !(sc.openapi || sc.scan || sc.items)) surface = empty("surface", "Surface", "Not configured. Add coverage.surface to litmustest.yaml: an OpenAPI file, source globs to scan for routes, or a list of tool names.");
  else {
    let routes: string[] = [];
    try {
      if (sc.openapi) routes.push(...openapiRoutes(root, String(sc.openapi)));
      if (sc.scan) routes.push(...scanRoutes(root, sc.scan as string[]));
      if (sc.items) routes.push(...(sc.items as string[]));
    } catch (e) { warnings.push(`coverage.surface: ${(e as Error).message}`); }
    routes = [...new Set(routes)].filter((r) => !ignored(r, (sc.ignore as string[]) ?? []));
    const depth = Number(sc.group_depth ?? 2);
    const raw = routes.map((r) => ({ id: r, area: surfaceArea(r, depth), tasks: [] as CoveringTask[] }));
    const ix = new Map(raw.map((r) => [r.id, r]));
    const add = (route: string, t: (typeof tasks)[number], via: CoveringTask["via"]) => { const r = ix.get(route); if (r && !r.tasks.some((x) => x.id === t.id)) r.tasks.push({ id: t.id, suite: t.suite, status: t.status, via }); };
    // calls made by the latest run's trials, from the transcript store
    for (const t of tasks) for (const c of calls().byTask.get(t.id) ?? []) { const r = matchRoute(routes, c); if (r) add(r, t, "called"); }
    if (run && !calls().readAny) warnings.push(`No transcripts for ${String(run.run_id)} in ${storeDirFor(evalsDir)}; surface coverage counts covers: lists only. Run the suites on this machine to count real calls.`);
    surfaceRoutes = routes;
    for (const t of tasks) for (const c of t.covers) if (ix.has(c)) { add(c, t, "covers"); used.add(c); }
    surface = build("surface", "Surface", raw);
    if (!routes.length) { surface.configured = false; surface.reason = "coverage.surface found no routes. Check the globs, or point it at an OpenAPI file."; }
  }

  // risk
  const trusted = new Set(f.judges.filter((j) => (j.calibration as Obj | undefined)?.status === "trusted").map((j) => j.name));
  const risk = build("risk", "Risk", f.modes.filter((m) => !m.retired).map((m) => {
    const name = String(m.name);
    const ts: CoveringTask[] = [];
    for (const t of tasks) for (const c of t.checks) if (c.failure_mode === name && !ts.some((x) => x.id === t.id)) {
      const untrusted = c.type === "judge" && !trusted.has(String(c.judge ?? c.failure_mode));
      ts.push({ id: t.id, suite: t.suite, status: t.status, via: "check", ...(untrusted ? { note: "judge not trusted yet; does not count" } : {}) });
    }
    return { id: name, area: String(m.severity ?? "med"), title: String(m.definition ?? "").split(/(?<=\.)\s/)[0], tasks: ts };
  }));

  // traffic: the surface items production traces used, weighted by how many traces used them
  let traffic: CoverageMap;
  const traceDir = join(evalsDir, "datasets", "traces");
  const traceFiles = existsSync(traceDir) ? readdirSync(traceDir).filter((x) => x.endsWith(".json")) : [];
  if (!surface.configured) traffic = empty("traffic", "Traffic", "Needs coverage.surface: traffic is measured over the routes or tools it lists.");
  else if (!traceFiles.length) traffic = empty("traffic", "Traffic", "No ingested traces under datasets/traces. Run litmustest ingest or litmustest sample first.");
  else {
    const seen = new Map<string, number>(); let unmatched = 0; let read = 0;
    for (const file of traceFiles) {
      let view; try { view = traceView(JSON.parse(readFileSync(join(traceDir, file), "utf8")) as Obj); } catch { continue; }
      read++;
      const hit = new Set<string>();
      for (const c of view.calls) { const r = matchRoute(surfaceRoutes, { name: c.name, args: c.args }); if (r) hit.add(r); else unmatched++; }
      for (const r of hit) seen.set(r, (seen.get(r) ?? 0) + 1);
    }
    const items = surface.items.filter((i) => seen.has(i.id)).map((i) => ({ ...i, weight: seen.get(i.id)!, title: `used by ${seen.get(i.id)} of ${read} traces` })).sort((a, b) => b.weight - a.weight);
    traffic = tally("traffic", "Traffic", items);
    const total = items.reduce((n, i) => n + i.weight, 0);
    traffic.weighted = { unit: "trace uses", total, covered: items.filter((i) => DEPTH_RANK[i.depth] >= 2).reduce((n, i) => n + i.weight, 0) };
    if (!items.length) { traffic.configured = false; traffic.reason = `None of the ${read} ingested traces called an item under coverage.surface.`; }
    if (unmatched) warnings.push(`${unmatched} tool call${unmatched > 1 ? "s" : ""} in production traces match no item under coverage.surface; add them or list them under coverage.surface.ignore.`);
  }

  // code: lines that ran while the suites ran, from a report the agent's own process wrote
  let code: CoverageMap;
  const cc = cfg.code as Obj | undefined;
  if (!cc?.report) code = empty("code", "Code", "Not configured. Add coverage.code.report to litmustest.yaml: an lcov or Istanbul JSON file your agent's process writes while the suites run.");
  else if (!existsSync(join(root, String(cc.report)))) code = empty("code", "Code", `No report at ${String(cc.report)}. Run the suites with your coverage tool switched on so it writes one.`);
  else {
    let files: { file: string; total: number; covered: number }[] = [];
    try { files = codeReport(join(root, String(cc.report)), root); } catch (e) { warnings.push(`coverage.code: ${(e as Error).message}`); }
    files = files.filter((x) => x.total > 0 && !ignored(x.file, (cc.ignore as string[]) ?? []));
    const items: CoverageItem[] = files.map((x) => ({ id: x.file, area: x.file.includes("/") ? x.file.split("/").slice(0, Number(cc.group_depth ?? 1)).join("/") : ".", title: `${x.covered} of ${x.total} lines ran`, depth: x.covered > 0 ? "checked" : "none", failing: false, tasks: [], weight: x.total, covered: x.covered }));
    code = tally("code", "Code", items);
    code.weighted = { unit: "lines", total: files.reduce((n, x) => n + x.total, 0), covered: files.reduce((n, x) => n + x.covered, 0) };
    if (!files.length) { code.configured = false; code.reason = `The report at ${String(cc.report)} lists no files with lines.`; }
  }

  // frontend: the product's pages, matched against the page URLs trials opened
  let frontend: CoverageMap;
  const fc = cfg.frontend as Obj | undefined;
  if (!fc || !(fc.routes || fc.scan)) frontend = empty("frontend", "Frontend", "Not configured. Add coverage.frontend to litmustest.yaml: a list of page routes, or source globs to scan for them.");
  else {
    let pages: string[] = [...((fc.routes as string[]) ?? [])];
    try { if (fc.scan) pages.push(...scanPages(root, fc.scan as string[])); } catch (e) { warnings.push(`coverage.frontend: ${(e as Error).message}`); }
    pages = [...new Set(pages.map((x) => (x.startsWith("/") ? x : `/${x}`)))].filter((x) => !ignored(x, (fc.ignore as string[]) ?? [])).sort();
    const raw = pages.map((x) => ({ id: x, area: "/" + x.split("/").filter(Boolean).filter((seg) => !seg.startsWith("{") && !seg.startsWith(":")).slice(0, 1).join("/"), tasks: [] as CoveringTask[] }));
    const ix = new Map(raw.map((r) => [r.id, r]));
    const add = (page: string, t: (typeof tasks)[number], via: CoveringTask["via"]) => { const r = ix.get(page); if (r && !r.tasks.some((x) => x.id === t.id)) r.tasks.push({ id: t.id, suite: t.suite, status: t.status, via }); };
    for (const t of tasks) {
      for (const c of calls().byTask.get(t.id) ?? []) { const pg = matchPage(pages, c); if (pg) add(pg, t, "called"); }
      for (const c of t.covers) if (ix.has(c)) { add(c, t, "covers"); used.add(c); }
    }
    frontend = build("frontend", "Frontend", raw);
    if (!pages.length) { frontend.configured = false; frontend.reason = "coverage.frontend found no pages. Check the globs, or list the routes."; }
  }

  const unknown = [...claimed].filter((c) => !used.has(c));
  for (const mp of [spec, surface, frontend]) if (mp.configured) mp.unknown_covers = unknown;
  if (unknown.length && (spec.configured || surface.configured || frontend.configured)) warnings.push(`covers: entries that match no spec id, route or page: ${unknown.slice(0, 10).join(", ")}${unknown.length > 10 ? "…" : ""}`);
  return { run_id: run ? String(run.run_id) : null, maps: { spec, surface, risk, traffic, code, frontend }, scope: SCOPE, warnings };
}

/** Files and their line counts from an lcov tracefile or an Istanbul JSON report (coverage-final.json or coverage-summary.json). */
export function codeReport(file: string, root: string): { file: string; total: number; covered: number }[] {
  const raw = readFileSync(file, "utf8");
  const rel = (x: string) => (x.startsWith(root) ? x.slice(root.length).replace(/^[\\/]+/, "") : x).split("\\").join("/");
  if (raw.trimStart().startsWith("{")) {
    const doc = JSON.parse(raw) as Record<string, Obj>;
    return Object.entries(doc).filter(([k]) => k !== "total").map(([k, v]) => {
      const lines = v.lines as Obj | undefined; // coverage-summary.json
      if (lines && typeof lines.total === "number") return { file: rel(k), total: Number(lines.total), covered: Number(lines.covered ?? 0) };
      const s = (v.s ?? {}) as Record<string, number>, map = (v.statementMap ?? {}) as Record<string, { start: { line: number } }>; // coverage-final.json: statements folded to lines
      const byLine = new Map<number, boolean>();
      for (const [id, n] of Object.entries(s)) { const line = map[id]?.start.line; if (line !== undefined) byLine.set(line, (byLine.get(line) ?? false) || n > 0); }
      return { file: rel(String(v.path ?? k)), total: byLine.size, covered: [...byLine.values()].filter(Boolean).length };
    });
  }
  const out: { file: string; total: number; covered: number }[] = []; let cur: { file: string; total: number; covered: number } | undefined;
  for (const line of raw.split("\n")) {
    if (line.startsWith("SF:")) cur = { file: rel(line.slice(3).trim()), total: 0, covered: 0 };
    else if (line.startsWith("DA:") && cur) { cur.total++; if (Number(line.slice(3).split(",")[1]) > 0) cur.covered++; }
    else if (line.startsWith("end_of_record") && cur) { out.push(cur); cur = undefined; }
  }
  if (!out.length) throw new Error(`${file} is neither an lcov tracefile nor an Istanbul JSON report`);
  return out;
}

/** Page routes from source: Next.js app/ and pages/ folders by file name, React Router and Vue Router by their path: declarations. */
export function scanPages(root: string, patterns: string[]): string[] {
  const out = new Set<string>();
  const seg = (x: string) => x.replace(/^\[\.\.\.(.+)\]$/, "{$1:path}").replace(/^\[(.+)\]$/, "{$1}");
  for (const f of globs(root, patterns)) {
    const file = f.split("\\").join("/");
    const app = /(?:^|\/)app\/(.*?)\/?page\.(?:tsx|jsx|ts|js)$/.exec(file);
    if (app) { out.add("/" + app[1]!.split("/").filter((x) => x && !/^\(.*\)$/.test(x) && !x.startsWith("@")).map(seg).join("/")); continue; }
    const pages = /(?:^|\/)pages\/(.+)\.(?:tsx|jsx|ts|js|vue)$/.exec(file);
    if (pages && !pages[1]!.startsWith("api/") && !pages[1]!.split("/").some((x) => x.startsWith("_"))) { out.add("/" + pages[1]!.split("/").filter((x) => x !== "index").map(seg).join("/")); continue; }
    const src = readFileSync(join(root, f), "utf8");
    for (const m of src.matchAll(/(?:\bpath\s*[:=]\s*)["'`](\/[^"'`*]*)["'`]/g)) out.add(m[1]!.replace(/(.)\/$/, "$1"));
  }
  return [...out].sort();
}
/** The page a recorded call opened, if its URL or path matches one. */
export function matchPage(pages: string[], call: Obj): string | undefined {
  const t = callTarget(call); if (!t.path) return undefined;
  const hits = pages.map((r) => ({ r, m: routeMatcher(`GET ${r}`) })).filter((x) => x.m && x.m.re.test(t.path!)).sort((a, b) => b.m!.specificity - a.m!.specificity);
  return hits[0]?.r;
}

/** The compact form stored in each run summary, for trends and CI. */
export function coverageSnapshot(c: Coverage): Obj {
  const out: Obj = {};
  for (const m of Object.values(c.maps)) if (m.configured) out[m.key] = { ...m.totals, uncovered: m.items.filter((i) => i.depth === "none").map((i) => i.id).slice(0, 1000), ...(m.weighted ? { weighted: m.weighted } : {}) };
  return out;
}
