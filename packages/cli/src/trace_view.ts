// The derived, never-stored view of a trace: an ordered list of turns and tool calls.
// The review queue and the transcript page render this; judges receive it; clustering reads it.
export interface ViewTurn { role: "user" | "agent" | "tool" | "system"; content: string; tool?: string; span_id?: string }
export interface ViewCall { name: string; args: unknown; result: unknown; ok: boolean; span_id: string }
export interface TraceView { id: string; turns: ViewTurn[]; calls: ViewCall[]; model?: string; input_tokens: number; output_tokens: number; metadata: Record<string, unknown> }

type Obj = Record<string, unknown>;
interface Span { span_id: string; parent_span_id?: string; name: string; start_time: string; attributes?: Obj; status?: { code?: string } }

export function traceView(trace: Obj): TraceView {
  const spans = ([...(trace.spans as Span[])]).sort((a, b) => a.start_time.localeCompare(b.start_time));
  const turns: ViewTurn[] = []; const calls: ViewCall[] = [];
  let model: string | undefined; let inTok = 0, outTok = 0;
  const seenUser = new Set<string>();
  for (const s of spans) {
    const a = (s.attributes ?? {}) as Obj;
    const op = a["gen_ai.operation.name"];
    if (op === "chat" || op === "text_completion" || op === "generate_content") {
      model ??= (a["gen_ai.response.model"] ?? a["gen_ai.request.model"]) as string | undefined;
      inTok += Number(a["gen_ai.usage.input_tokens"] ?? 0); outTok += Number(a["gen_ai.usage.output_tokens"] ?? 0);
      for (const m of (a["gen_ai.input.messages"] as Obj[] | undefined) ?? []) {
        if (m.role !== "user" && m.role !== "system") continue;
        const text = partsText(m.parts as Obj[]);
        if (!text || seenUser.has(text)) continue; // the same user turn is resent on every request
        seenUser.add(text); turns.push({ role: m.role as "user" | "system", content: text, span_id: s.span_id });
      }
      for (const m of (a["gen_ai.output.messages"] as Obj[] | undefined) ?? []) {
        const text = partsText(m.parts as Obj[]);
        if (text) turns.push({ role: "agent", content: text, span_id: s.span_id });
      }
    } else if (op === "execute_tool") {
      const name = String(a["gen_ai.tool.name"] ?? s.name.replace(/^execute_tool\s*/, ""));
      const call: ViewCall = { name, args: a["gen_ai.tool.call.arguments"], result: a["gen_ai.tool.call.result"], ok: s.status?.code !== "error", span_id: s.span_id };
      calls.push(call);
      // a tool turn sits before the agent text of its parent chat span
      const parentIx = turns.findIndex((t) => t.role === "agent" && t.span_id === s.parent_span_id);
      const turn: ViewTurn = { role: "tool", tool: name, content: JSON.stringify(call.result ?? null), span_id: s.span_id };
      if (parentIx >= 0) turns.splice(parentIx, 0, turn); else turns.push(turn);
    }
  }
  return { id: String(trace.id), turns, calls, model, input_tokens: inTok, output_tokens: outTok, metadata: (trace.metadata as Obj) ?? {} };
}

function partsText(parts: Obj[] | undefined): string {
  return (parts ?? []).filter((p) => p.type === "text").map((p) => String(p.content ?? "")).join("\n").trim();
}

/** Plain text used for clustering: what the user said, what the agent said, which tools ran. */
export function viewText(v: TraceView): string {
  return [
    ...v.turns.filter((t) => t.role === "user").map((t) => t.content),
    ...v.turns.filter((t) => t.role === "agent").map((t) => t.content),
    ...v.calls.map((c) => `tool_${c.name}${c.ok ? "" : "_error"}`),
    ...Object.entries(v.metadata).filter(([, val]) => typeof val === "string").map(([k, val]) => `${k}_${val}`),
  ].join("\n");
}
