// Platform adapters: pull traces from Langfuse or Braintrust over their HTTP APIs, without a manual export, and
// hand them to the JSONL adapter as plain lines. `fetch` is injectable so tests run against recorded payloads.
// Tested against recorded response shapes, not live accounts: field names follow the public API docs as of 2026-10.
type Obj = Record<string, unknown>;
export type Fetch = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown>; text: () => Promise<string> }>;
export interface PullOptions { since?: string; limit?: number; fetch?: Fetch; env?: Record<string, string | undefined> }
export interface PullResult { lines: Obj[]; warnings: string[]; source: string }

const need = (env: Record<string, string | undefined>, k: string, what: string) => { const v = env[k]; if (!v) throw new Error(`${what} needs ${k} in the environment`); return v; };
const toText = (v: unknown): string => (typeof v === "string" ? v : v === undefined || v === null ? "" : JSON.stringify(v));

/** Langfuse: GET /api/public/traces (paged, fromTimestamp) then /api/public/traces/{id} for observations. */
export async function pullLangfuse(o: PullOptions = {}): Promise<PullResult> {
  const env = o.env ?? process.env; const f = o.fetch ?? (globalThis.fetch as unknown as Fetch);
  const host = (env.LANGFUSE_HOST ?? "https://cloud.langfuse.com").replace(/\/$/, "");
  const auth = "Basic " + Buffer.from(`${need(env, "LANGFUSE_PUBLIC_KEY", "the Langfuse adapter")}:${need(env, "LANGFUSE_SECRET_KEY", "the Langfuse adapter")}`).toString("base64");
  const headers = { Authorization: auth, "Content-Type": "application/json" };
  const lines: Obj[] = []; const warnings: string[] = []; const limit = o.limit ?? 500;
  for (let page = 1; lines.length < limit; page++) {
    const url = `${host}/api/public/traces?page=${page}&limit=${Math.min(100, limit - lines.length)}${o.since ? `&fromTimestamp=${encodeURIComponent(o.since)}` : ""}&orderBy=timestamp.asc`;
    const res = await f(url, { headers }); if (!res.ok) throw new Error(`Langfuse ${res.status} on ${url.replace(host, "")}: ${(await res.text()).slice(0, 200)}`);
    const body = (await res.json()) as { data?: Obj[]; meta?: { totalPages?: number } };
    const data = body.data ?? []; if (!data.length) break;
    for (const t of data) {
      const id = String(t.id);
      let observations: Obj[] = [];
      try { const d = await f(`${host}/api/public/traces/${encodeURIComponent(id)}`, { headers }); if (d.ok) observations = (((await d.json()) as Obj).observations as Obj[]) ?? []; else warnings.push(`trace ${id}: observations ${d.status}`); } catch (e) { warnings.push(`trace ${id}: ${(e as Error).message}`); }
      lines.push(langfuseLine(t, observations));
    }
    if (body.meta?.totalPages !== undefined && page >= body.meta.totalPages) break;
  }
  return { lines, warnings, source: `langfuse:${host}` };
}
export function langfuseLine(t: Obj, observations: Obj[]): Obj {
  const gens = observations.filter((ob) => ob.type === "GENERATION").sort((a, b) => String(a.startTime).localeCompare(String(b.startTime)));
  const messages: Obj[] = []; const toolCalls: Obj[] = []; let turn = 0;
  for (const g of gens) {
    const input = g.input; const output = g.output;
    if (Array.isArray(input)) for (const m of input as Obj[]) { if (m.role === "user" || m.role === "system") { if (!messages.some((x) => x.role === m.role && x.content === toText(m.content))) messages.push({ role: m.role, content: toText(m.content) }); } }
    else if (input !== undefined && !messages.length) messages.push({ role: "user", content: toText(input) });
    const out = (Array.isArray(output) ? (output as Obj[])[0] : output) as Obj | string | undefined;
    const outObj = out && typeof out === "object" ? out : undefined;
    if (outObj?.tool_calls) for (const c of outObj.tool_calls as Obj[]) toolCalls.push({ id: c.id, name: String((c.function as Obj | undefined)?.name ?? c.name ?? "tool"), arguments: parseMaybe((c.function as Obj | undefined)?.arguments ?? c.arguments), turn });
    messages.push({ role: "assistant", content: toText(outObj ? outObj.content ?? outObj.text ?? "" : out) });
    turn++;
  }
  for (const s of observations.filter((ob) => ob.type === "SPAN" || ob.type === "TOOL")) { const name = String(s.name ?? "tool"); const tc = toolCalls.find((c) => c.name === name && c.result === undefined); if (tc) tc.result = s.output; }
  return { id: String(t.id), input: toText(t.input ?? messages.find((m) => m.role === "user")?.content ?? ""), output: toText(t.output ?? [...messages].reverse().find((m) => m.role === "assistant")?.content ?? ""), messages: messages.length ? messages : undefined, tool_calls: toolCalls.length ? toolCalls : undefined, timestamp: t.timestamp, model: gens[0]?.model, metadata: { ...((t.metadata as Obj) ?? {}), ...(t.sessionId ? { session: t.sessionId } : {}), ...(t.userId ? { user: t.userId } : {}), ...(t.name ? { name: t.name } : {}) } };
}

/** Braintrust: POST /v1/project_logs/{project_id}/fetch (BTQL-less, cursor paged); root spans become traces. */
export async function pullBraintrust(o: PullOptions & { project?: string } = {}): Promise<PullResult> {
  const env = o.env ?? process.env; const f = o.fetch ?? (globalThis.fetch as unknown as Fetch);
  const host = (env.BRAINTRUST_API_URL ?? "https://api.braintrust.dev").replace(/\/$/, "");
  const key = need(env, "BRAINTRUST_API_KEY", "the Braintrust adapter");
  const project = o.project ?? need(env, "BRAINTRUST_PROJECT_ID", "the Braintrust adapter");
  const headers = { Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
  const lines: Obj[] = []; const warnings: string[] = []; const limit = o.limit ?? 500;
  let cursor: string | undefined; const byRoot = new Map<string, Obj[]>();
  for (let i = 0; i < 50; i++) {
    const res = await f(`${host}/v1/project_logs/${encodeURIComponent(project)}/fetch`, { method: "POST", headers, body: JSON.stringify({ limit: 1000, ...(cursor ? { cursor } : {}) }) });
    if (!res.ok) throw new Error(`Braintrust ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const body = (await res.json()) as { events?: Obj[]; cursor?: string };
    for (const e of body.events ?? []) { if (o.since && String(e.created ?? "") < o.since) continue; const root = String(e.root_span_id ?? e.span_id ?? e.id); byRoot.set(root, [...(byRoot.get(root) ?? []), e]); }
    if (!body.cursor || !(body.events ?? []).length) break; cursor = body.cursor;
  }
  for (const [root, events] of byRoot) { if (lines.length >= limit) break; lines.push(braintrustLine(root, events)); }
  return { lines, warnings, source: `braintrust:${project}` };
}
export function braintrustLine(root: string, events: Obj[]): Obj {
  const sorted = events.slice().sort((a, b) => String(a.created ?? "").localeCompare(String(b.created ?? "")));
  const rootEv = sorted.find((e) => String(e.span_id ?? e.id) === root) ?? sorted[0]!;
  const llm = sorted.filter((e) => ((e.span_attributes as Obj | undefined)?.type ?? "") === "llm");
  const tools = sorted.filter((e) => ((e.span_attributes as Obj | undefined)?.type ?? "") === "tool");
  const messages: Obj[] = []; const toolCalls: Obj[] = [];
  llm.forEach((e, turn) => { const input = e.input; if (Array.isArray(input)) for (const m of input as Obj[]) if ((m.role === "user" || m.role === "system") && !messages.some((x) => x.role === m.role && x.content === toText(m.content))) messages.push({ role: m.role, content: toText(m.content) }); const out = (Array.isArray(e.output) ? (e.output as Obj[])[0] : e.output) as Obj | string; const outObj = out && typeof out === "object" ? out : undefined; if (outObj?.tool_calls) for (const c of outObj.tool_calls as Obj[]) toolCalls.push({ id: c.id, name: String((c.function as Obj | undefined)?.name ?? c.name ?? "tool"), arguments: parseMaybe((c.function as Obj | undefined)?.arguments ?? c.arguments), turn }); messages.push({ role: "assistant", content: toText(outObj ? outObj.content ?? "" : out) }); });
  for (const t of tools) { const name = String((t.span_attributes as Obj).name ?? "tool"); const tc = toolCalls.find((c) => c.name === name && c.result === undefined); if (tc) tc.result = t.output; else toolCalls.push({ name, arguments: t.input ?? {}, result: t.output, turn: Math.max(0, messages.filter((m) => m.role === "assistant").length - 1) }); }
  const metrics = (llm[0]?.metrics as Obj) ?? {};
  return { id: root, input: toText(rootEv.input ?? messages.find((m) => m.role === "user")?.content ?? ""), output: toText(rootEv.output ?? [...messages].reverse().find((m) => m.role === "assistant")?.content ?? ""), messages: messages.length ? messages : undefined, tool_calls: toolCalls.length ? toolCalls : undefined, timestamp: rootEv.created, model: (llm[0]?.metadata as Obj | undefined)?.model as string | undefined, metadata: { ...((rootEv.metadata as Obj) ?? {}), ...(metrics.tokens ? { tokens: metrics.tokens } : {}) } };
}
function parseMaybe(v: unknown): unknown { if (typeof v !== "string") return v ?? {}; try { return JSON.parse(v); } catch { return { raw: v }; } }

export async function pullSource(format: string, o: PullOptions & { project?: string }): Promise<PullResult> {
  if (format === "langfuse") return pullLangfuse(o);
  if (format === "braintrust") return pullBraintrust(o);
  if (format === "langsmith") throw new Error("the LangSmith adapter is not written yet; export a JSONL from LangSmith and ingest that");
  throw new Error(`no pull adapter for format '${format}'; ingest a file instead`);
}
