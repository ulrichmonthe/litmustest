// litmustest ingest: normalize a trace source to the internal shape, write datasets/traces/, cluster, and sample a review batch.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import { parse as parseYaml, stringify as yaml } from "yaml";
import { jsonlLineToTrace } from "./adapters/jsonl.ts";
import { SchemaSet } from "./schemas.ts";
import { traceView, viewText } from "./trace_view.ts";
import { kmeans, tfidf } from "./cluster.ts";

type Obj = Record<string, unknown>;
export interface IngestOptions { evalsDir: string; source: string; size?: number; clusters?: number; seed?: number; batch?: string; now?: Date; cwd?: string }
export interface IngestResult {
  traces: number; written: number; skipped: number; invalid: { id: string; errors: string[] }[]; warnings: Map<string, number>;
  batchFile: string; batch: Obj; coverage: Obj;
}

export function ingest(o: IngestOptions): IngestResult {
  const cwd = resolve(o.cwd ?? process.cwd());
  const evalsDir = resolve(cwd, o.evalsDir);
  const configFile = join(evalsDir, "litmustest.yaml");
  if (!existsSync(configFile)) throw new Error(`${relative(cwd, evalsDir) || "."}/litmustest.yaml not found; run litmustest init first`);
  const config = parseYaml(readFileSync(configFile, "utf8")) as Obj;
  const sampler = ((config.sources as Obj)?.sampler ?? {}) as Obj;
  const size = o.size ?? Number(sampler.size ?? 60);
  const k = o.clusters ?? Number(sampler.clusters ?? 8);
  const seed = o.seed ?? 1;
  const now = o.now ?? new Date();
  const schemas = new SchemaSet();
  const sourcePath = resolve(cwd, o.source);
  if (!existsSync(sourcePath)) throw new Error(`source not found: ${o.source}`);

  // ---- read and normalize
  const lines = readFileSync(sourcePath, "utf8").split("\n").map((l, i) => [l, i + 1] as const).filter(([l]) => l.trim());
  const traces: Obj[] = []; const invalid: { id: string; errors: string[] }[] = []; const warnings = new Map<string, number>();
  const warn = (w: string) => warnings.set(w, (warnings.get(w) ?? 0) + 1);
  const format = String(((config.sources as Obj)?.traces as Obj)?.format ?? "jsonl");
  lines.forEach(([l, no]) => {
    let obj: Obj;
    try { obj = JSON.parse(l); } catch (e) { invalid.push({ id: `line ${no}`, errors: [`cannot parse: ${(e as Error).message}`] }); return; }
    let trace: Obj;
    if (format === "otel" || (obj.spans && !obj.input)) {
      trace = obj; // already in the internal shape
    } else {
      const errs = schemas.check("trace.jsonl_adapter", obj);
      if (errs.length) { invalid.push({ id: String(obj.id ?? `line ${no}`), errors: errs }); return; }
      const r = jsonlLineToTrace(obj, { ingestedAt: now, lineNo: no });
      for (const w of r.warnings) warn(w);
      trace = r.trace;
    }
    const errs = schemas.check("trace", trace);
    if (errs.length) { invalid.push({ id: String(trace.id ?? `line ${no}`), errors: errs }); return; }
    traces.push(trace);
  });
  const seen = new Set<string>();
  for (const t of traces) { if (seen.has(String(t.id))) throw new Error(`duplicate trace id ${t.id} in ${o.source}`); seen.add(String(t.id)); }
  if (!traces.length) throw new Error(`no valid traces in ${o.source}`);

  // ---- write datasets/traces/<id>.json, leaving identical files untouched
  const outDir = join(evalsDir, "datasets", "traces"); mkdirSync(outDir, { recursive: true });
  let written = 0, skipped = 0;
  for (const t of traces) {
    const p = join(outDir, `${t.id}.json`);
    const body = JSON.stringify(t, null, 1);
    if (existsSync(p) && sameTrace(readFileSync(p, "utf8"), body)) { skipped++; continue; }
    writeFileSync(p, body); written++;
  }

  // ---- cluster and sample
  const views = traces.map((t) => traceView(t));
  const vectors = tfidf(views.map(viewText));
  const km = kmeans(vectors, k, seed);
  const reps = km.representatives.filter((i) => i >= 0);
  const chosen = new Set<number>(reps);
  const items: Obj[] = reps.map((i) => ({ trace_id: traces[i]!.id, cluster: km.assignments[i], reason: "representative" }));
  const rng = mulberry32(seed);
  const pool = traces.map((_, i) => i).filter((i) => !chosen.has(i));
  for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [pool[i], pool[j]] = [pool[j]!, pool[i]!]; }
  for (const i of pool.slice(0, Math.max(0, size - items.length))) { chosen.add(i); items.push({ trace_id: traces[i]!.id, cluster: km.assignments[i], reason: "random" }); }
  items.sort((a, b) => Number(a.cluster) - Number(b.cluster) || String(a.trace_id).localeCompare(String(b.trace_id)));
  const clusters = km.centroids.map((_, j) => ({ id: j, size: km.assignments.filter((a) => a === j).length, sampled: items.filter((it) => it.cluster === j).length, terms: km.terms[j], ...(km.representatives[j]! >= 0 ? { representative: traces[km.representatives[j]!]!.id } : {}) }));
  const coverage = { total_traces: traces.length, sampled: items.length, clusters };
  const name = o.batch ?? now.toISOString().slice(0, 10);
  const batch = { name, created: now.toISOString().replace(/\.\d{3}Z$/, "Z"), source: relative(cwd, sourcePath).split("\\").join("/") || basename(sourcePath), sampler: { size, clusters: k, seed, method: "tfidf_kmeans" }, items, coverage };
  const bErrs = schemas.check("batch", batch);
  if (bErrs.length) throw new Error(`batch does not validate: ${bErrs.join("; ")}`);
  const batchDir = join(evalsDir, "batches"); mkdirSync(batchDir, { recursive: true });
  const batchFile = join(batchDir, `${name}.yaml`);
  writeFileSync(batchFile, `# Review batch written by litmustest ingest. Edit by re-running ingest, not by hand.\n${yaml(batch)}`);
  return { traces: traces.length, written, skipped, invalid, warnings, batchFile, batch, coverage };
}

function sameTrace(a: string, b: string): boolean {
  try { const x = JSON.parse(a), y = JSON.parse(b); delete x.ingested_at; delete y.ingested_at; return JSON.stringify(x) === JSON.stringify(y); } catch { return false; }
}
function mulberry32(seed: number): () => number {
  let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
