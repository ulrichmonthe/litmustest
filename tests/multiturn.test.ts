// B3: multi-turn conversations survive every way a trace is built and read.
// The case that broke before: a customer who gives the same answer twice ("yes", then "yes") lost the second turn,
// because user turns were recovered by matching text instead of by their place in the conversation.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { jsonlLineToTrace } from "../packages/cli/src/adapters/jsonl.ts";
import { braintrustLine, langfuseLine } from "../packages/cli/src/adapters/platforms.ts";
import { newMessages, traceView } from "../packages/cli/src/trace_view.ts";
import { viewFromTrial } from "../packages/cli/src/run.ts";
import { traceFromTrial } from "../packages/cli/src/server/transcripts.ts";
import { SchemaSet } from "../packages/cli/src/schemas.ts";
import { toTrace } from "../examples/support-agent/src/otel.ts";

const schemas = new SchemaSet();
const EXAMPLE = join(import.meta.dirname, "..", "examples", "support-agent", "evals");
const roles = (v: { turns: { role: string }[] }) => v.turns.map((t) => t.role);
const said = (v: { turns: { role: string; content: string }[] }) => v.turns.filter((t) => t.role === "user").map((t) => t.content);

describe("user turns are recovered by position, not by text", () => {
  it("newMessages takes what follows the history, or all of a call that carries only the new turn", () => {
    const u = (c: string) => ({ role: "user", content: c }); const a = (c: string) => ({ role: "assistant", content: c });
    expect(newMessages([u("hi")], 0).messages).toEqual([u("hi")]);
    expect(newMessages([u("hi"), a("ok?"), u("yes")], 1).messages).toEqual([u("yes")]);
    expect(newMessages([u("yes"), a("sure?"), u("yes")], 1).messages).toEqual([u("yes")]);
    expect(newMessages([u("yes")], 1).messages).toEqual([u("yes")]); // no history in the call: it is the new turn
    expect(newMessages([u("hi"), a("calling a tool"), { role: "tool", content: "{}" }], 1).messages).toEqual([]); // a tool loop adds no user turn
    expect(newMessages([u("hi")], 1, true).messages).toEqual([]); // the call after a tool call resent only the opening message
  });

  it("JSONL: a repeated answer is two turns, every chat span carries the history, and the trace validates", () => {
    const r = jsonlLineToTrace({ id: "m1", input: "Refund my last charge", output: "Refunded.", model: "m", timestamp: "2026-11-01T10:00:00Z",
      messages: [{ role: "user", content: "Refund my last charge" }, { role: "assistant", content: "The one on 3 October?" }, { role: "user", content: "yes" }, { role: "assistant", content: "Refund it to the card ending 4242?" }, { role: "user", content: "yes" }, { role: "assistant", content: "Refunded." }],
      tool_calls: [{ id: "a", name: "verify_identity", arguments: {}, result: { verified: true }, turn: 0 }, { id: "b", name: "process_refund", arguments: {}, result: { ok: true }, turn: 2 }] });
    expect(schemas.check("trace", r.trace)).toEqual([]);
    const v = traceView(r.trace);
    expect(said(v)).toEqual(["Refund my last charge", "yes", "yes"]);
    expect(roles(v)).toEqual(["user", "tool", "agent", "user", "agent", "user", "tool", "agent"]);
    const chats = (r.trace.spans as { attributes: Record<string, unknown> }[]).filter((s) => s.attributes["gen_ai.operation.name"] === "chat");
    expect((chats[2]!.attributes["gen_ai.input.messages"] as unknown[]).length).toBeGreaterThan(4); // the third call sees the whole conversation
  });

  it("a trace ingested before history was carried, with a tool call and an answer in one turn, keeps the next user turn", () => {
    const span = (i: number, user: string, parts: object[], finish: string) => ({ span_id: `c${i}`, parent_span_id: "r", name: "chat m", kind: "client", start_time: `2026-11-01T10:00:0${i}Z`, end_time: `2026-11-01T10:00:0${i}Z`, attributes: { "gen_ai.operation.name": "chat", "gen_ai.input.messages": [{ role: "user", parts: [{ type: "text", content: user }] }], "gen_ai.output.messages": [{ role: "assistant", parts, finish_reason: finish }] } });
    const old = { id: "old", source: "jsonl", ingested_at: "2026-11-01T10:00:00Z", spans: [span(0, "refund", [{ type: "tool_call", id: "a", name: "lookup", arguments: {} }, { type: "text", content: "Found it. Refund?" }], "tool_call"), span(1, "ok", [{ type: "text", content: "Done." }], "stop")] };
    expect(said(traceView(old))).toEqual(["refund", "ok"]);
  });

  it("JSONL: a tool loop inside one turn adds no user turn", () => {
    const r = jsonlLineToTrace({ id: "m2", input: "hi", output: "done", model: "m", timestamp: "2026-11-01T10:00:00Z",
      messages: [{ role: "user", content: "hi" }, { role: "assistant", content: "" }, { role: "assistant", content: "done" }],
      tool_calls: [{ id: "a", name: "lookup", arguments: {}, result: {}, turn: 0 }] });
    expect(said(traceView(r.trace))).toEqual(["hi"]);
  });

  it("the example's trace builder keeps both answers", () => {
    const trace = toTrace({ id: "e1", model: "m", started: new Date("2026-11-01T10:00:00Z"), calls: [],
      turns: [{ role: "user", content: "Can I get a VAT invoice?" }, { role: "agent", content: "For October?" }, { role: "user", content: "yes" }, { role: "agent", content: "And the September one?" }, { role: "user", content: "yes" }, { role: "agent", content: "Both sent." }] });
    expect(schemas.check("trace", trace)).toEqual([]);
    expect(said(traceView(trace))).toEqual(["Can I get a VAT invoice?", "yes", "yes"]);
    expect(roles(traceView(trace))).toEqual(["user", "agent", "user", "agent", "user", "agent"]);
  });

  it("Langfuse and Braintrust: generations that resend the history yield each user turn once, repeats included", () => {
    const hist = (k: number) => [{ role: "user", content: "refund please" }, ...(k >= 1 ? [{ role: "assistant", content: "The October charge?" }, { role: "user", content: "yes" }] : []), ...(k >= 2 ? [{ role: "assistant", content: "To the card on file?" }, { role: "user", content: "yes" }] : [])];
    const replies = ["The October charge?", "To the card on file?", "Refunded."];
    const lf = langfuseLine({ id: "lf", timestamp: "2026-11-01T10:00:00Z" }, replies.map((text, k) => ({ type: "GENERATION", startTime: `2026-11-01T10:00:0${k}Z`, model: "m", input: hist(k), output: { role: "assistant", content: text } })));
    expect((lf.messages as { role: string; content: string }[]).filter((m) => m.role === "user").map((m) => m.content)).toEqual(["refund please", "yes", "yes"]);
    expect(said(traceView(jsonlLineToTrace(lf).trace))).toEqual(["refund please", "yes", "yes"]);
    const bt = braintrustLine("r", replies.map((text, k) => ({ id: `e${k}`, span_id: `e${k}`, root_span_id: "r", created: `2026-11-01T10:00:0${k}Z`, span_attributes: { type: "llm", name: "chat" }, input: hist(k), output: { role: "assistant", content: text } })));
    expect((bt.messages as { role: string; content: string }[]).filter((m) => m.role === "user").map((m) => m.content)).toEqual(["refund please", "yes", "yes"]);
  });
});

describe("a multi-turn trial round-trips", () => {
  const ref = JSON.parse(readFileSync(join(EXAMPLE, "refs", "vat_invoice_followup_business.json"), "utf8"));
  const task = parseYaml(readFileSync(join(EXAMPLE, "tasks", "capability", "vat_invoice_followup_business.yaml"), "utf8"));

  it("the example ships a two-round capability task whose input asks for a simulated customer", () => {
    expect(task.input.simulate).toEqual({ max_rounds: 3 });
    expect(task.checks.find((c: { id: string }) => c.id === "rounds")).toMatchObject({ type: "transcript", max_turns: 3 });
    expect(ref.transcript.filter((t: { role: string }) => t.role === "agent")).toHaveLength(2);
  });

  it("viewFromTrial and traceFromTrial keep both rounds and their order", () => {
    const view = viewFromTrial(ref, "trial_x");
    expect(roles(view)).toEqual(["user", "tool", "tool", "tool", "tool", "agent", "user", "agent"]);
    const trace = traceFromTrial({ ...ref, input: task.input }, "disputed_x", {});
    expect(schemas.check("trace", trace)).toEqual([]);
    const back = traceView(trace);
    expect(said(back)).toEqual(said(view));
    expect(roles(back)).toEqual(roles(view));
    expect(back.calls.map((c) => c.name)).toEqual(ref.tool_calls.map((c: { name: string }) => c.name));
  });
});
