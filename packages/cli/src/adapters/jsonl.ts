// The JSONL adapter: one plain log line (id, input, output, optional messages and tool_calls)
// becomes one trace in the internal OpenTelemetry GenAI shape. Every field it could not fill is a warning.
type Obj = Record<string, unknown>;
export interface AdapterResult { trace: Obj; warnings: string[] }

export function jsonlLineToTrace(line: Obj, opts: { ingestedAt?: Date; lineNo?: number } = {}): AdapterResult {
  const warnings: string[] = [];
  const id = String(line.id);
  const asText = (v: unknown): string => (typeof v === "string" ? v : JSON.stringify(v ?? ""));
  const ingested = (opts.ingestedAt ?? new Date()).toISOString();
  let t0: number;
  if (typeof line.timestamp === "string" && !Number.isNaN(Date.parse(line.timestamp))) t0 = Date.parse(line.timestamp);
  else { t0 = Date.parse(ingested); warnings.push("no timestamp; using ingest time"); }
  const model = typeof line.model === "string" ? line.model : undefined;
  if (!model) warnings.push("no model");

  // messages: fall back to one user turn and one agent turn
  let messages = Array.isArray(line.messages) ? (line.messages as Obj[]) : undefined;
  if (!messages || messages.length === 0) {
    messages = [{ role: "user", content: line.input }, { role: "assistant", content: line.output }];
    warnings.push("no messages; built one user turn and one agent turn from input and output");
  }
  const toolCalls = Array.isArray(line.tool_calls) ? (line.tool_calls as Obj[]) : [];
  if (!Array.isArray(line.tool_calls)) warnings.push("no tool_calls");

  // group into agent turns: each assistant message closes a turn; tool messages in between are results
  const spans: Obj[] = [];
  const iso = (ms: number) => new Date(ms).toISOString();
  let t = t0; let turn = 0; let pendingUser: Obj[] = []; let callIx = 0;
  const byTurn = new Map<number, Obj[]>();
  for (const c of toolCalls) { const k = typeof c.turn === "number" ? c.turn : 0; byTurn.set(k, [...(byTurn.get(k) ?? []), c]); }
  const root = "s_root";
  for (const m of messages) {
    const role = String(m.role);
    if (role === "user" || role === "system") { pendingUser.push({ role, parts: [{ type: "text", content: asText(m.content) }] }); continue; }
    if (role === "tool") continue; // results are carried on the tool spans below
    if (role !== "assistant") { warnings.push(`unknown message role '${role}' skipped`); continue; }
    const calls = byTurn.get(turn) ?? [];
    const start = t; t += 1500;
    const spanId = `s_chat_${turn}`;
    const parts: Obj[] = calls.map((c) => ({ type: "tool_call", id: String(c.id ?? `tc_${callIx++}`), name: String(c.name), arguments: c.arguments ?? {} }));
    const text = asText(m.content); if (text) parts.push({ type: "text", content: text });
    spans.push({ span_id: spanId, parent_span_id: root, name: `chat ${model ?? "unknown"}`, kind: "client", start_time: iso(start), end_time: iso(t),
      attributes: { "gen_ai.operation.name": "chat", ...(model ? { "gen_ai.request.model": model, "gen_ai.response.model": model } : {}),
        "gen_ai.input.messages": pendingUser.length ? pendingUser : [{ role: "user", parts: [{ type: "text", content: asText(line.input) }] }],
        "gen_ai.output.messages": [{ role: "assistant", parts: parts.length ? parts : [{ type: "text", content: "" }], finish_reason: calls.length ? "tool_call" : "stop" }] } });
    pendingUser = [];
    for (const c of calls) {
      const s = t; t += 100;
      const ok = !(c.result && typeof c.result === "object" && "error" in (c.result as Obj));
      spans.push({ span_id: `s_tool_${c.id ?? spanId}_${calls.indexOf(c)}`, parent_span_id: spanId, name: `execute_tool ${c.name}`, kind: "internal", start_time: iso(s), end_time: iso(t), status: { code: ok ? "ok" : "error" },
        attributes: { "gen_ai.operation.name": "execute_tool", "gen_ai.tool.name": String(c.name), ...(c.id ? { "gen_ai.tool.call.id": String(c.id) } : {}), "gen_ai.tool.call.arguments": c.arguments ?? {}, "gen_ai.tool.call.result": c.result ?? null } });
    }
    turn++;
  }
  if (turn === 0) { warnings.push("no assistant message; agent turn built from output"); spans.push({ span_id: "s_chat_0", parent_span_id: root, name: `chat ${model ?? "unknown"}`, kind: "client", start_time: iso(t0), end_time: iso(t0 + 1500), attributes: { "gen_ai.operation.name": "chat", "gen_ai.input.messages": [{ role: "user", parts: [{ type: "text", content: asText(line.input) }] }], "gen_ai.output.messages": [{ role: "assistant", parts: [{ type: "text", content: asText(line.output) }], finish_reason: "stop" }] } }); t = t0 + 1500; }
  const unplaced = [...byTurn.keys()].filter((k) => k >= turn);
  if (unplaced.length) warnings.push(`tool_calls reference turns ${unplaced.join(", ")} that do not exist; dropped`);
  spans.unshift({ span_id: root, name: "invoke_agent", kind: "server", start_time: iso(t0), end_time: iso(t), status: { code: "ok" }, attributes: { "gen_ai.operation.name": "invoke_agent", "gen_ai.conversation.id": id } });
  const metadata = (line.metadata && typeof line.metadata === "object" ? line.metadata : {}) as Obj;
  return { trace: { id, source: "jsonl", ingested_at: ingested, metadata, spans }, warnings };
}
