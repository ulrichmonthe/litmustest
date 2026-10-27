// Plays the customer for multi-turn tasks. Driven by a cheaper model than the agent.
import Anthropic from "@anthropic-ai/sdk";
import type { Persona } from "./catalog.ts";

export const SIM_MODEL = "claude-sonnet-5-5";

const STYLE: Record<Persona, string> = {
  frustrated: "You are angry and short. You have contacted support before about this. You do not say please. If the agent fixes it, you say so curtly and stop.",
  business: "You write like an accounts-payable clerk: formal, precise, you cite invoice ids and dates, you ask for written confirmation.",
  first_time: "You signed up this week and do not know the product's terms. You ask simple questions and thank the agent when it is resolved.",
};

export async function simulatedUserReply(client: Anthropic, persona: Persona, goal: string, transcript: { role: string; content: string }[]): Promise<string> {
  const history = transcript.map((t) => `${t.role === "agent" ? "AGENT" : "YOU"}: ${t.content}`).join("\n");
  const res = await client.messages.create({
    model: SIM_MODEL, max_tokens: 400,
    system: `You are role-playing a customer talking to a billing support agent. ${STYLE[persona]}\nYour goal: ${goal}\nReply with the customer's next message only, one to three sentences. If the goal is fully resolved or clearly impossible, reply with exactly: [DONE]`,
    messages: [{ role: "user", content: `Conversation so far:\n${history}\n\nYour next message:` }],
  });
  return res.content.filter((b) => b.type === "text").map((b) => b.text).join("").trim();
}
