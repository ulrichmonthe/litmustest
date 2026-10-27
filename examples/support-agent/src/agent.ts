// The support agent: a manual tool-use loop over the five tools, recording every turn and call.
import Anthropic from "@anthropic-ai/sdk";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { DatabaseSync } from "node:sqlite";
import { TOOL_DEFS, runTool } from "./tools.ts";
import type { Recorded, RecordedCall, Turn } from "./otel.ts";
import { simulatedUserReply } from "./simulated_user.ts";
import type { Persona } from "./catalog.ts";

export const AGENT_MODEL = "claude-opus-5-5";
const here = dirname(fileURLToPath(import.meta.url));
export const SYSTEM_PROMPT = readFileSync(join(here, "..", "prompt.md"), "utf8");

export interface AgentOptions {
  id: string; db: DatabaseSync; message: string; persona?: Persona;
  /** When set, the simulated user keeps the conversation going until it says [DONE] or maxRounds is hit. */
  simulate?: { goal: string; maxRounds?: number };
  client?: Anthropic;
}

export async function runAgent(o: AgentOptions): Promise<Recorded> {
  const client = o.client ?? new Anthropic();
  const started = new Date();
  const turns: Turn[] = [{ role: "user", content: o.message }];
  const calls: RecordedCall[] = [];
  const verified = new Set<string>();
  let messages: Anthropic.Beta.BetaMessageParam[] = [{ role: "user", content: o.message }];
  let inTok = 0, outTok = 0, agentTurn = 0;

  for (let round = 0; round < (o.simulate?.maxRounds ?? 4); round++) {
    // one agent turn: loop until end_turn
    for (let step = 0; step < 12; step++) {
      const res = await client.beta.messages.create({
        model: AGENT_MODEL, max_tokens: 2048, system: SYSTEM_PROMPT,
        tools: TOOL_DEFS.map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema as Anthropic.Beta.BetaTool["input_schema"], strict: true })),
        messages,
      });
      inTok += res.usage.input_tokens; outTok += res.usage.output_tokens;
      messages.push({ role: "assistant", content: res.content });
      const text = res.content.filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text").map((b) => b.text).join("").trim();
      const uses = res.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
      if (res.stop_reason === "refusal" || res.stop_reason === "max_tokens") { turns.push({ role: "agent", content: text || `[${res.stop_reason}]` }); break; }
      if (uses.length === 0) { turns.push({ role: "agent", content: text }); break; }
      const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
      for (const u of uses) {
        const rec = runTool(o.db, u.name, (u.input ?? {}) as Record<string, unknown>, verified);
        calls.push({ ...rec, turn: agentTurn });
        turns.push({ role: "tool", tool: u.name, content: JSON.stringify(rec.result) });
        results.push({ type: "tool_result", tool_use_id: u.id, content: JSON.stringify(rec.result), is_error: !rec.ok });
      }
      messages.push({ role: "user", content: results });
    }
    agentTurn++;
    if (!o.simulate || !o.persona) break;
    const reply = await simulatedUserReply(client, o.persona, o.simulate.goal, turns.filter((t) => t.role !== "tool"));
    if (!reply || reply.includes("[DONE]")) break;
    turns.push({ role: "user", content: reply });
    messages.push({ role: "user", content: reply });
  }
  return { id: o.id, model: AGENT_MODEL, persona: o.persona, turns, calls, started, input_tokens: inTok, output_tokens: outTok };
}
