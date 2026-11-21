// Where raw transcripts live. A run summary in git names each trial's transcript by `transcript_ref`; this module turns
// `storage.transcripts` in litmustest.yaml into a store that can put and get the files behind that address.
//
// Every backend has a local directory per trial: for `local` it is the store itself, for a remote backend it is a
// read-through cache under .litmustest/cache/ beside evals/. The runner works in that directory and pushes the trial's
// files after grading; readers pull what is missing and then read the local copy.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { objectStore } from "./object.ts";
import { braintrustStore, langfuseStore } from "./platforms.ts";

type Obj = Record<string, unknown>;
export type StoreFetch = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;
export interface StoreOptions { fetch?: StoreFetch; env?: Record<string, string | undefined>; now?: () => Date }
export type Backend = "local" | "s3" | "gcs" | "braintrust" | "langfuse";

/** What every backend implements. `name` is one of the trial's files: trial.json, grades.json, stdout.txt, stderr.txt. */
export interface TranscriptStore {
  readonly backend: Backend;
  put(run: string, task: string, n: number, name: string, body: string): Promise<void>;
  get(run: string, task: string, n: number, name: string): Promise<string | null>;
  has(run: string, task: string, n: number, name?: string): Promise<boolean>;
  /** The address written into the run summary as transcript_ref. */
  ref(run: string, task: string, n: number): string;
  /** Where a person can open the trial, when the backend has such a place. */
  url?(run: string, task: string, n: number): string | undefined;
}

/** The files of one trial that leave the machine. Anything else in the trial directory (a database, a workspace) stays local. */
export const TRIAL_FILES = ["trial.json", "grades.json", "stdout.txt", "stderr.txt"] as const;
export const safeSegment = (s: string) => s.replace(/[^A-Za-z0-9_.-]/g, "");

/** A store plus its local side: the directory a trial's files sit in on this machine, and pull and push between the two. */
export class OpenStore implements TranscriptStore {
  readonly backend: Backend; readonly remote: TranscriptStore | null; readonly root: string;
  constructor(root: string, remote: TranscriptStore | null) { this.root = root; this.remote = remote; this.backend = remote?.backend ?? "local"; }
  /** The trial's directory on this machine: the store itself for local, the cache for a remote backend. */
  dir(run: string, task: string, n: number): string { return join(this.root, safeSegment(run), safeSegment(task), String(n)); }
  /** A file's local copy, or null when it is not on this machine. Never touches the network. */
  cached(run: string, task: string, n: number, name: string): string | null { const p = join(this.dir(run, task, n), name); return existsSync(p) ? readFileSync(p, "utf8") : null; }
  ref(run: string, task: string, n: number): string { return this.remote ? this.remote.ref(run, task, n) : `local:${run}/${task}/${n}`; }
  url(run: string, task: string, n: number): string | undefined { return this.remote?.url?.(run, task, n); }
  async get(run: string, task: string, n: number, name: string): Promise<string | null> {
    const hit = this.cached(run, task, n, name); if (hit !== null || !this.remote) return hit;
    const body = await this.remote.get(run, task, n, name);
    if (body !== null) { const p = join(this.dir(run, task, n), name); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, body); }
    return body;
  }
  async put(run: string, task: string, n: number, name: string, body: string): Promise<void> {
    const p = join(this.dir(run, task, n), name); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, body);
    if (this.remote) await this.remote.put(run, task, n, name, body);
  }
  async has(run: string, task: string, n: number, name = "trial.json"): Promise<boolean> { return this.cached(run, task, n, name) !== null || (this.remote ? this.remote.has(run, task, n, name) : false); }
  /** Bring a trial's files into the local directory. True when trial.json is there afterwards. A remote that cannot be reached is reported, not thrown. */
  async pull(run: string, task: string, n: number): Promise<{ ok: boolean; error?: string }> {
    if (this.remote) try { for (const name of TRIAL_FILES) await this.get(run, task, n, name); } catch (e) { return { ok: this.cached(run, task, n, "trial.json") !== null, error: (e as Error).message }; }
    return { ok: this.cached(run, task, n, "trial.json") !== null };
  }
  /** Send the trial's files from the local directory to the remote. Returns the names sent; nothing to do for local. */
  async push(run: string, task: string, n: number): Promise<string[]> {
    if (!this.remote) return [];
    const sent: string[] = [];
    for (const name of TRIAL_FILES) { const body = this.cached(run, task, n, name); if (body !== null) { await this.remote.put(run, task, n, name, body); sent.push(name); } }
    return sent;
  }
}

export function storageConfig(evalsDir: string): Obj {
  const file = join(evalsDir, "litmustest.yaml");
  const cfg = existsSync(file) ? ((parseYaml(readFileSync(file, "utf8")) as Obj | null) ?? {}) : {};
  return ((cfg.storage as Obj | undefined)?.transcripts as Obj | undefined) ?? {};
}

/** Open the store `storage.transcripts` describes. Credentials come from the environment only; a missing one is an error naming the variable. */
export function openStore(evalsDir: string, o: StoreOptions = {}): OpenStore {
  const t = storageConfig(evalsDir); const repo = dirname(resolve(evalsDir)); const backend = String(t.backend ?? "local");
  if (backend === "local") return new OpenStore(resolve(repo, String(t.path ?? ".litmustest/transcripts")), null);
  const cache = resolve(repo, ".litmustest", "cache", "transcripts");
  if (backend === "s3" || backend === "gcs") return new OpenStore(cache, objectStore(backend, t, o));
  if (backend === "braintrust") return new OpenStore(cache, braintrustStore(t, o));
  if (backend === "langfuse") return new OpenStore(cache, langfuseStore(t, o));
  if (backend === "langsmith") throw new Error("storage.transcripts.backend langsmith is not written yet (it waits on the LangSmith adapter); use local, s3, gcs, braintrust or langfuse");
  throw new Error(`storage.transcripts.backend '${backend}' is not one of local, s3, gcs, braintrust, langfuse`);
}

/** The local directory transcripts are read from on this machine, without opening the remote: the store for local, the cache otherwise. Never throws. */
export function localRoot(evalsDir: string): string {
  const t = storageConfig(evalsDir); const repo = dirname(resolve(evalsDir));
  return String(t.backend ?? "local") === "local" ? resolve(repo, String(t.path ?? ".litmustest/transcripts")) : resolve(repo, ".litmustest", "cache", "transcripts");
}

/** run, task and trial number from any transcript_ref: the last three path segments, whatever the scheme. */
export function parseRef(ref: string): { scheme: string; run: string; task: string; n: number } | null {
  const m = /^([a-z0-9]+):(?:\/\/)?(.*)$/.exec(ref); if (!m) return null;
  const parts = m[2]!.split("/").filter(Boolean); if (parts.length < 3) return null;
  const n = Number(parts.at(-1)); if (!Number.isInteger(n) || n < 1) return null;
  return { scheme: m[1]!, run: parts.at(-3)!, task: parts.at(-2)!, n };
}
/** True when the ref says the transcript went to a store other than this machine's directory. */
export const isRemoteRef = (ref: unknown): boolean => typeof ref === "string" && !ref.startsWith("local:") && parseRef(ref) !== null;
