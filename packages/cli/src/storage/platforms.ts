// Logging platforms as a transcript store: each trial is pushed as one trace tagged with its run, task and trial, and each
// of its files is a span under that trace holding the file's text. Reads go back by the trial's deterministic trace id.
// Same credentials and injectable fetch as the pull adapters (adapters/platforms.ts).
// Tested against recorded request and response shapes, not live accounts: endpoints follow the public API docs as of 2026-10.
import { createHash } from "node:crypto";
import { safeSegment, type StoreFetch, type StoreOptions, type TranscriptStore } from "./index.ts";

type Obj = Record<string, unknown>;
const need = (env: Record<string, string | undefined>, k: string, what: string) => { const v = env[k]; if (!v) throw new Error(`${what} needs ${k} in the environment`); return v; };
const hex = (s: string, len: number) => createHash("sha256").update(s).digest("hex").slice(0, len);
const key = (run: string, task: string, n: number) => `${safeSegment(run)}/${safeSegment(task)}/${n}`;
const tags = (run: string, task: string, n: number) => ["litmustest", `run:${run}`, `task:${task}`, `trial:${n}`];
/** What the platform shows as the trace's input and output, when the file is the trial itself. */
function trialFields(name: string, body: string): Obj { if (name !== "trial.json") return {}; try { const t = JSON.parse(body) as Obj; return { input: t.input ?? (t.transcript as Obj[] | undefined)?.find((x) => x.role === "user")?.content ?? null, output: t.output ?? null }; } catch { return {}; } }

/** Langfuse: POST /api/public/ingestion (trace-create + span-create, both upserts by id); GET /api/public/traces/{id} to read. */
export function langfuseStore(_t: Obj, o: StoreOptions = {}): TranscriptStore {
  const env = o.env ?? process.env; const f = o.fetch ?? (globalThis.fetch as unknown as StoreFetch); const what = "storage.transcripts.backend langfuse";
  const host = (env.LANGFUSE_HOST ?? "https://cloud.langfuse.com").replace(/\/$/, "");
  const headers = () => ({ Authorization: "Basic " + Buffer.from(`${need(env, "LANGFUSE_PUBLIC_KEY", what)}:${need(env, "LANGFUSE_SECRET_KEY", what)}`).toString("base64"), "Content-Type": "application/json" });
  const traceId = (run: string, task: string, n: number) => hex(`litmustest/${key(run, task, n)}`, 32);
  const load = async (run: string, task: string, n: number): Promise<Obj | null> => {
    const r = await f(`${host}/api/public/traces/${traceId(run, task, n)}`, { headers: headers() });
    if (r.status === 404) return null; if (!r.ok) throw new Error(`Langfuse ${r.status} reading trace ${traceId(run, task, n)}: ${(await r.text()).slice(0, 200)}`);
    return JSON.parse(await r.text()) as Obj;
  };
  const file = (trace: Obj | null, name: string): string | null => { const ob = ((trace?.observations as Obj[] | undefined) ?? []).find((x) => x.name === name); return ob === undefined ? null : typeof ob.input === "string" ? ob.input : JSON.stringify(ob.input); };
  return {
    backend: "langfuse",
    async put(run, task, n, name, body) {
      const now = (o.now?.() ?? new Date()).toISOString(); const id = traceId(run, task, n);
      const batch = [
        { id: hex(`${id}/trace/${name}`, 32), type: "trace-create", timestamp: now, body: { id, name: `litmustest ${task} #${n}`, sessionId: run, tags: tags(run, task, n), metadata: { litmustest: { run, task, trial: n } }, ...trialFields(name, body) } },
        { id: hex(`${id}/span/${name}`, 32), type: "span-create", timestamp: now, body: { id: hex(`${id}/${name}`, 16), traceId: id, name, startTime: now, endTime: now, input: body } },
      ];
      const r = await f(`${host}/api/public/ingestion`, { method: "POST", headers: headers(), body: JSON.stringify({ batch }) });
      const text = await r.text();
      if (!r.ok) throw new Error(`Langfuse ${r.status} on ingestion: ${text.slice(0, 200)}`);
      // the ingestion endpoint answers 207 with per-event errors
      let errors: Obj[] = []; try { errors = ((JSON.parse(text) as Obj).errors as Obj[]) ?? []; } catch { /* no body */ }
      if (errors.length) throw new Error(`Langfuse refused ${name}: ${JSON.stringify(errors[0]).slice(0, 200)}`);
    },
    async get(run, task, n, name) { return file(await load(run, task, n), name); },
    async has(run, task, n, name = "trial.json") { return file(await load(run, task, n), name) !== null; },
    ref: (run, task, n) => `langfuse:${key(run, task, n)}`,
    url: (run, task, n) => `${host}/trace/${traceId(run, task, n)}`,
  };
}

/** Braintrust: POST /v1/project_logs/{project}/insert (events upsert by id); POST /btql to read one event back by id. */
export function braintrustStore(t: Obj, o: StoreOptions = {}): TranscriptStore {
  const env = o.env ?? process.env; const f = o.fetch ?? (globalThis.fetch as unknown as StoreFetch); const what = "storage.transcripts.backend braintrust";
  const host = (env.BRAINTRUST_API_URL ?? "https://api.braintrust.dev").replace(/\/$/, "");
  const project = () => String(t.project ?? need(env, "BRAINTRUST_PROJECT_ID", what));
  const headers = () => ({ Authorization: `Bearer ${need(env, "BRAINTRUST_API_KEY", what)}`, "Content-Type": "application/json" });
  const rootId = (run: string, task: string, n: number) => `litmustest:${key(run, task, n)}`;
  const one = async (id: string): Promise<Obj | null> => {
    const query = `select: id, input | from: project_logs('${project().replace(/'/g, "")}') | filter: id = '${id.replace(/'/g, "")}' | limit: 1`;
    const r = await f(`${host}/btql`, { method: "POST", headers: headers(), body: JSON.stringify({ query, fmt: "json" }) });
    if (!r.ok) throw new Error(`Braintrust ${r.status} reading ${id}: ${(await r.text()).slice(0, 200)}`);
    return (((JSON.parse(await r.text()) as Obj).data as Obj[] | undefined) ?? [])[0] ?? null;
  };
  return {
    backend: "braintrust",
    async put(run, task, n, name, body) {
      const root = rootId(run, task, n);
      const events = [
        { id: root, span_id: root, root_span_id: root, _is_merge: true, tags: tags(run, task, n), metadata: { litmustest: { run, task, trial: n } }, span_attributes: { name: `litmustest ${task} #${n}`, type: "task" }, ...trialFields(name, body) },
        { id: `${root}/${name}`, span_id: `${root}/${name}`, root_span_id: root, span_parents: [root], span_attributes: { name, type: "task" }, input: body },
      ];
      const r = await f(`${host}/v1/project_logs/${encodeURIComponent(project())}/insert`, { method: "POST", headers: headers(), body: JSON.stringify({ events }) });
      if (!r.ok) throw new Error(`Braintrust ${r.status} on insert: ${(await r.text()).slice(0, 200)}`);
    },
    async get(run, task, n, name) { const e = await one(`${rootId(run, task, n)}/${name}`); return e === null ? null : typeof e.input === "string" ? e.input : JSON.stringify(e.input); },
    async has(run, task, n, name = "trial.json") { return (await one(`${rootId(run, task, n)}/${name}`)) !== null; },
    ref: (run, task, n) => `braintrust:${project()}/${key(run, task, n)}`,
  };
}
