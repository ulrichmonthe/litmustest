// Build a trace in the internal shape (OpenTelemetry GenAI spans) from a recorded conversation.
export interface Turn { role: "user" | "agent" | "tool"; content: string; tool?: string }
export interface RecordedCall { name: string; args: Record<string, unknown>; result: unknown; ok: boolean; turn: number }
export interface Recorded {
  id: string; model: string; persona?: string; scenario?: string;
  turns: Turn[]; calls: RecordedCall[]; started: Date; input_tokens?: number; output_tokens?: number;
}

export function toTrace(r: Recorded): Record<string, unknown> {
  let t = r.started.getTime();
  const iso = (ms: number) => new Date(ms).toISOString();
  const spans: Record<string, unknown>[] = [];
  const root = "s_root";
  const userTurns = r.turns.filter((x) => x.role === "user");
  const agentTurns = r.turns.filter((x) => x.role === "agent");
  let callIx = 0;
  for (let i = 0; i < agentTurns.length; i++) {
    const start = t; t += 1800;
    const inMsgs = [{ role: "user", parts: [{ type: "text", content: userTurns[i]?.content ?? userTurns[0]?.content ?? "" }] }];
    const callsThisTurn = r.calls.filter((c) => c.turn === i);
    const outParts: Record<string, unknown>[] = [];
    for (const c of callsThisTurn) outParts.push({ type: "tool_call", id: `tc_${callIx++}`, name: c.name, arguments: c.args });
    outParts.push({ type: "text", content: agentTurns[i]!.content });
    spans.push({
      span_id: `s_chat_${i}`, parent_span_id: root, name: `chat ${r.model}`, kind: "client", start_time: iso(start), end_time: iso(t),
      attributes: { "gen_ai.operation.name": "chat", "gen_ai.provider.name": "anthropic", "gen_ai.request.model": r.model, "gen_ai.response.model": r.model,
        "gen_ai.usage.input_tokens": Math.round((r.input_tokens ?? 900) / agentTurns.length), "gen_ai.usage.output_tokens": Math.round((r.output_tokens ?? 120) / agentTurns.length),
        "gen_ai.input.messages": inMsgs, "gen_ai.output.messages": [{ role: "assistant", parts: outParts, finish_reason: callsThisTurn.length ? "tool_call" : "stop" }] },
    });
    let k = callIx - callsThisTurn.length;
    for (const c of callsThisTurn) {
      const s = t; t += 120;
      spans.push({ span_id: `s_tool_${k}`, parent_span_id: `s_chat_${i}`, name: `execute_tool ${c.name}`, kind: "internal", start_time: iso(s), end_time: iso(t),
        status: { code: c.ok ? "ok" : "error" },
        attributes: { "gen_ai.operation.name": "execute_tool", "gen_ai.tool.name": c.name, "gen_ai.tool.call.id": `tc_${k}`, "gen_ai.tool.call.arguments": c.args, "gen_ai.tool.call.result": c.result } });
      k++;
    }
  }
  spans.unshift({ span_id: root, name: "invoke_agent support", kind: "server", start_time: iso(r.started.getTime()), end_time: iso(t), status: { code: "ok" },
    attributes: { "gen_ai.operation.name": "invoke_agent", "gen_ai.agent.name": "support", "gen_ai.conversation.id": r.id } });
  return { id: r.id, source: "support-agent", ingested_at: iso(t), metadata: { persona: r.persona, scenario: r.scenario }, spans };
}

/** The plain JSONL shape a team would have before litmustest: one line per conversation. */
export function toJsonlLine(r: Recorded): Record<string, unknown> {
  return {
    id: r.id, input: r.turns.find((x) => x.role === "user")?.content ?? "", output: [...r.turns].reverse().find((x) => x.role === "agent")?.content ?? "",
    messages: r.turns.map((x) => (x.role === "tool" ? { role: "tool", name: x.tool, content: x.content } : { role: x.role === "agent" ? "assistant" : "user", content: x.content })),
    tool_calls: r.calls.map((c, i) => ({ id: `tc_${i}`, name: c.name, arguments: c.args, result: c.result, turn: c.turn })),
    timestamp: r.started.toISOString(), model: r.model, metadata: { persona: r.persona, scenario: r.scenario },
  };
}
