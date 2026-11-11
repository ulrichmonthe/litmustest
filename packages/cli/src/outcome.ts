// Outcome checks: how the end state is read and compared. One path walker for the runner, the validator and the
// transcript page. Without `read` on the check the state is `trial.state`, the snapshot the agent's script wrote.
// With `read` the runner reads the state itself from the trial directory (sql, fs) or over HTTP.
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

type Obj = Record<string, unknown>;
export type Fetch = (url: string, init?: { method?: string; headers?: Record<string, string> }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

/** Thrown when the state could not be read for a reason that is not the agent's doing. The runner tags the trial as an infra error. */
export class OutcomeInfraError extends Error { kind: "network" | "harness"; constructor(message: string, kind: "network" | "harness" = "harness") { super(message); this.kind = kind; } }

/** Walk a dotted path with optional [n] indexes: refunds.status, rows[0].id. */
export function getPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const part of path.split(".")) {
    const m = /^([A-Za-z0-9_]+)((?:\[\d+\])*)$/.exec(part);
    if (!m || cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Obj)[m[1]!];
    for (const ix of m[2]!.matchAll(/\[(\d+)\]/g)) cur = Array.isArray(cur) ? cur[Number(ix[1])] : undefined;
  }
  return cur;
}

/** The value an `expect` key addresses. A sql reader keys its state by the whole expect key, so that is tried first. */
export function valueAt(state: unknown, path: string): unknown {
  if (state !== null && typeof state === "object" && !Array.isArray(state) && Object.hasOwn(state as Obj, path)) return (state as Obj)[path];
  return getPath(state, path);
}

export interface Miss { path: string; expected: unknown; actual: unknown }
/** Every `expect` entry that the state does not match, compared as JSON. */
export function compareExpect(expect: Obj, state: unknown): Miss[] {
  const out: Miss[] = [];
  for (const [path, want] of Object.entries(expect ?? {})) { const got = valueAt(state, path); if (JSON.stringify(got) !== JSON.stringify(want)) out.push({ path, expected: want, actual: got }); }
  return out;
}

/** Which reader a check uses: "trial" when it has no `read` (or the backend is page), else its backend. */
export function readerOf(check: Obj): "trial" | "sql" | "fs" | "http" {
  if (!check.read || typeof check.read !== "object") return "trial";
  const b = String(check.backend ?? "sql");
  return b === "sql" || b === "fs" || b === "http" ? b : "trial";
}

function inside(trialDir: string, file: string): string {
  const abs = resolve(trialDir, file); const rel = relative(resolve(trialDir), abs);
  if (isAbsolute(file) || rel.startsWith("..") || isAbsolute(rel)) throw new Error(`read.file '${file}' must stay inside the trial directory`);
  return abs;
}

type Sqlite = { DatabaseSync: new (path: string, opts?: { readOnly?: boolean }) => { prepare(sql: string): { all(): Obj[] }; close(): void } };
let sqlite: Sqlite | undefined;
async function loadSqlite(): Promise<Sqlite> {
  if (sqlite) return sqlite;
  try { sqlite = (await import("node:sqlite")) as unknown as Sqlite; }
  catch { throw new OutcomeInfraError(`outcome checks with backend sql need node:sqlite (Node 22.13 or later); this is Node ${process.versions.node}`); }
  return sqlite;
}

export interface ReadOptions { fetch?: Fetch; env?: Record<string, string | undefined>; vars?: Record<string, string> }
export interface StateRead { state: unknown; reader: "trial" | "sql" | "fs" | "http"; note?: string }

/**
 * Read the end state one outcome check compares against.
 * trialDir null means there is no trial directory (a reference solution): every reader falls back to `trial.state`.
 * A missing file or a query that fails is the trial's state, not an infra error: it returns a note and the check fails on it.
 */
export async function readState(check: Obj, trialDir: string | null, trial: Obj, o: ReadOptions = {}): Promise<StateRead> {
  const reader = readerOf(check);
  if (reader === "trial" || trialDir === null) return { state: trial.state, reader: "trial" };
  const read = check.read as Obj;
  if (reader === "sql") {
    const file = inside(trialDir, String(read.file));
    if (!existsSync(file)) return { state: {}, reader, note: `${read.file} is not in the trial directory` };
    const { DatabaseSync } = await loadSqlite();
    const state: Obj = {}; const notes: string[] = [];
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      for (const [key, sql] of Object.entries((read.queries as Record<string, string>) ?? {})) {
        try { const row = db.prepare(String(sql)).all()[0]; state[key] = row ? normal(Object.values(row)[0]) : null; }
        catch (e) { notes.push(`query for ${key} failed: ${(e as Error).message}`); }
      }
    } finally { db.close(); }
    return { state, reader, ...(notes.length ? { note: notes.join("; ") } : {}) };
  }
  if (reader === "fs") {
    if (read.exists) return { state: { exists: (read.exists as string[]).map((f) => existsSync(inside(trialDir, f))) }, reader };
    const file = inside(trialDir, String(read.file));
    if (!existsSync(file)) return { state: {}, reader, note: `${read.file} is not in the trial directory` };
    try { return { state: JSON.parse(readFileSync(file, "utf8")), reader }; }
    catch (e) { return { state: {}, reader, note: `${read.file} is not JSON: ${(e as Error).message}` }; }
  }
  // http
  const env = o.env ?? process.env; const vars = { trial_dir: trialDir, ...(o.vars ?? {}) };
  const fill = (s: string) => s.replace(/\{([a-z_]+)\}/g, (all, k: string) => (vars as Record<string, string>)[k] ?? all).replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, k: string) => env[k] ?? "");
  const url = fill(String(read.url)); const f = o.fetch ?? (globalThis.fetch as unknown as Fetch);
  let res: Awaited<ReturnType<Fetch>>;
  try { res = await f(url, { method: String(read.method ?? "GET"), headers: Object.fromEntries(Object.entries((read.headers as Record<string, string>) ?? {}).map(([k, v]) => [k, fill(String(v))])) }); }
  catch (e) { throw new OutcomeInfraError(`could not reach ${url}: ${(e as Error).message}`, "network"); }
  if (res.status >= 500) throw new OutcomeInfraError(`${url} answered HTTP ${res.status}`, "network");
  if (!res.ok) return { state: { http_status: res.status }, reader, note: `${url} answered HTTP ${res.status}` };
  const text = await res.text();
  try { return { state: JSON.parse(text), reader }; }
  catch { throw new OutcomeInfraError(`${url} did not answer JSON`, "harness"); }
}

/** SQLite hands back bigint for large integers and Uint8Array for blobs; expect values are plain JSON. */
function normal(v: unknown): unknown { return typeof v === "bigint" ? Number(v) : v instanceof Uint8Array ? Buffer.from(v).toString("hex") : v; }

/** Grade one outcome check: the misses as text, the values the reader saw per expect key, and which reader saw them. */
export async function gradeOutcome(check: Obj, trialDir: string | null, trial: Obj, o: ReadOptions = {}): Promise<{ pass: boolean; reason: string; observed: Obj; reader: StateRead["reader"] }> {
  const r = await readState(check, trialDir, trial, o); const expect = (check.expect as Obj) ?? {};
  const misses = compareExpect(expect, r.state);
  const observed = Object.fromEntries(Object.keys(expect).map((k) => [k, valueAt(r.state, k) ?? null]));
  const by = r.reader === "trial" ? "" : ` (read by the runner: ${r.reader})`;
  const reason = misses.length ? misses.map((m) => `${m.path}: expected ${JSON.stringify(m.expected)}, got ${JSON.stringify(m.actual)}`).join("; ") + (r.note ? `; ${r.note}` : "") + by : `end state matches ${Object.keys(expect).join(", ")}${by}`;
  return { pass: misses.length === 0, reason, observed, reader: r.reader };
}
