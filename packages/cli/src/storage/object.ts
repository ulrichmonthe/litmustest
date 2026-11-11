// Object stores: Amazon S3 (and anything S3-compatible through `endpoint`) and Google Cloud Storage through its
// S3-compatible XML API with HMAC keys. One object per file: <prefix>/<run>/<task>/<n>/<name>.
// Tested against recorded request and response shapes, not live buckets.
import { encodeKey, signV4 } from "./sigv4.ts";
import { safeSegment, type StoreFetch, type StoreOptions, type TranscriptStore } from "./index.ts";

type Obj = Record<string, unknown>;
const need = (env: Record<string, string | undefined>, k: string, what: string) => { const v = env[k]; if (!v) throw new Error(`${what} needs ${k} in the environment`); return v; };

export function objectStore(backend: "s3" | "gcs", t: Obj, o: StoreOptions = {}): TranscriptStore {
  const env = o.env ?? process.env; const f = o.fetch ?? (globalThis.fetch as unknown as StoreFetch);
  const what = `storage.transcripts.backend ${backend}`;
  // `path` may carry the bucket URI (s3://bucket/prefix), the way the schema has always described it
  const uri = /^(?:s3|gs):\/\/([^/]+)\/?(.*)$/.exec(String(t.path ?? ""));
  const bucket = String(t.bucket ?? uri?.[1] ?? ""); if (!bucket) throw new Error(`${what} needs storage.transcripts.bucket`);
  const prefix = String(t.prefix ?? uri?.[2] ?? "").replace(/^\/+|\/+$/g, "");
  const region = backend === "gcs" ? "auto" : String(t.region ?? env.AWS_REGION ?? env.AWS_DEFAULT_REGION ?? "us-east-1");
  const endpoint = t.endpoint ? String(t.endpoint).replace(/\/$/, "") : undefined;
  // AWS: virtual-hosted style. A custom endpoint (MinIO, R2) and GCS: path style.
  const base = endpoint ? `${endpoint}/${bucket}` : backend === "gcs" ? `https://storage.googleapis.com/${bucket}` : `https://${bucket}.s3.${region}.amazonaws.com`;
  const creds = () => backend === "gcs"
    ? { accessKeyId: need(env, "GCS_ACCESS_KEY_ID", what), secretAccessKey: need(env, "GCS_SECRET_ACCESS_KEY", what) }
    : { accessKeyId: need(env, "AWS_ACCESS_KEY_ID", what), secretAccessKey: need(env, "AWS_SECRET_ACCESS_KEY", what), ...(env.AWS_SESSION_TOKEN ? { sessionToken: env.AWS_SESSION_TOKEN } : {}) };
  const key = (run: string, task: string, n: number, name?: string) => [prefix, safeSegment(run), safeSegment(task), String(n), ...(name ? [name] : [])].filter(Boolean).join("/");
  const call = async (method: string, k: string, body?: string) => {
    const url = `${base}/${encodeKey(k)}`;
    const headers = signV4({ method, url, body, region, ...creds(), now: o.now?.(), headers: body !== undefined ? { "content-type": k.endsWith(".json") ? "application/json" : "text/plain; charset=utf-8" } : {} });
    return f(url, { method, headers, ...(body !== undefined ? { body } : {}) });
  };
  const scheme = backend === "gcs" ? "gs" : "s3";
  return {
    backend,
    async put(run, task, n, name, body) { const r = await call("PUT", key(run, task, n, name), body); if (!r.ok) throw new Error(`${backend} PUT ${key(run, task, n, name)}: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`); },
    async get(run, task, n, name) { const r = await call("GET", key(run, task, n, name)); if (r.status === 404) return null; if (!r.ok) throw new Error(`${backend} GET ${key(run, task, n, name)}: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`); return r.text(); },
    async has(run, task, n, name = "trial.json") { const r = await call("HEAD", key(run, task, n, name)); if (r.status === 404) return false; if (!r.ok) throw new Error(`${backend} HEAD ${key(run, task, n, name)}: HTTP ${r.status}`); return true; },
    ref: (run, task, n) => `${scheme}://${bucket}/${key(run, task, n)}`,
    // the console page for the trial's folder; it needs a signed-in browser, which is the point of a private bucket
    url: (run, task, n) => (endpoint ? undefined : backend === "gcs" ? `https://console.cloud.google.com/storage/browser/${bucket}/${key(run, task, n)}` : `https://s3.console.aws.amazon.com/s3/buckets/${bucket}?region=${region}&prefix=${encodeURIComponent(key(run, task, n) + "/")}`),
  };
}
