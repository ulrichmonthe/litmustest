// Run a judge over traces: assemble its prompt from prompt.md, the few-shot examples and the inputs it asks for,
// call the model, and parse the structured verdict. The model is injectable so tests run without a key.
import Anthropic from "@anthropic-ai/sdk";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { traceView, type TraceView } from "./trace_view.ts";
import { parseJson } from "./discover.ts";

type Obj = Record<string, unknown>;
export type JudgeAsk = (system: string, user: string, model: string) => Promise<string>;
export interface Verdict { trace_id: string; result: "Pass" | "Fail" | "Unknown"; critique: string; raw?: string }
export interface JudgeFiles { name: string; judge: Obj; prompt: string; dir: string }

export function loadJudge(evalsDir: string, name: string): JudgeFiles {
  const dir = join(evalsDir, "graders", "judges", name);
  const jf = join(dir, "judge.yaml");
  if (!existsSync(jf)) throw new Error(`no judge '${name}': ${jf} not found`);
  const judge = parseYaml(readFileSync(jf, "utf8")) as Obj;
  const pf = join(evalsDir, String(judge.prompt));
  if (!existsSync(pf)) throw new Error(`judge '${name}': prompt ${judge.prompt} not found`);
  return { name, judge, prompt: readFileSync(pf, "utf8"), dir };
}

export function loadTraceView(evalsDir: string, id: string): TraceView | undefined {
  const p = join(evalsDir, "datasets", "traces", `${id}.json`);
  if (!existsSync(p)) return undefined;
  try { return traceView(JSON.parse(readFileSync(p, "utf8"))); } catch { return undefined; }
}

/** Render what the judge is allowed to see, per judge.inputs. */
export function renderInputs(v: TraceView, inputs: string[], extra: { state?: unknown; reference?: unknown } = {}): string {
  const parts: string[] = [];
  const cut = (s: string, n = 4000) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
  for (const i of inputs) {
    if (i === "input") parts.push(`## Customer's first message\n${v.turns.find((t) => t.role === "user")?.content ?? ""}`);
    else if (i === "output") parts.push(`## Agent's final reply\n${[...v.turns].reverse().find((t) => t.role === "agent")?.content ?? ""}`);
    else if (i === "transcript") parts.push(`## Transcript\n${v.turns.map((t) => (t.role === "tool" ? `[tool ${t.tool}] ${cut(t.content, 600)}` : `${t.role.toUpperCase()}: ${t.content}`)).join("\n\n")}`);
    else if (i === "tool_calls") parts.push(`## Tool calls\n${v.calls.length ? v.calls.map((c) => `${c.name}(${JSON.stringify(c.args ?? {})}) -> ${cut(JSON.stringify(c.result ?? null), 400)}${c.ok ? "" : " [error]"}`).join("\n") : "none"}`);
    else if (i === "state") parts.push(`## End state\n${extra.state ? JSON.stringify(extra.state, null, 1) : "not available for a trace"}`);
    else if (i === "reference") parts.push(`## Reference\n${extra.reference ? JSON.stringify(extra.reference, null, 1) : "not available"}`);
  }
  return cut(parts.join("\n\n"), 12000);
}

export function buildMessages(j: JudgeFiles, evalsDir: string, v: TraceView, labelsByTrace: Map<string, { label: string; note?: string }>): { system: string; user: string } {
  const inputs = (j.judge.inputs as string[]) ?? ["transcript"];
  const shots = ((j.judge.few_shot as { trace_id: string; label: string; note?: string }[]) ?? []).map((s) => {
    const sv = loadTraceView(evalsDir, s.trace_id);
    const label = labelsByTrace.get(s.trace_id)?.label ?? s.label;
    return sv ? `### Example · trace ${s.trace_id} · ${label}${s.note ? `\nWhy: ${s.note}` : ""}\n${renderInputs(sv, inputs)}` : "";
  }).filter(Boolean);
  const system = `${j.prompt.trim()}\n\nAnswer with JSON only: {"critique": "<your reasoning, two to five sentences>", "result": "Pass" | "Fail" | "Unknown"}. Write the critique first, then decide. Fail means the failure mode is present. Unknown only when what you were shown cannot settle it.`;
  const user = `${shots.length ? `${shots.join("\n\n")}\n\n---\n\n` : ""}### Trace to judge · ${v.id}\n${renderInputs(v, inputs)}`;
  return { system, user };
}

export function parseVerdict(raw: string): { result: "Pass" | "Fail" | "Unknown"; critique: string } {
  try {
    const o = parseJson(raw) as Obj;
    const r = String(o.result ?? "").trim();
    const result = /^fail/i.test(r) ? "Fail" : /^pass/i.test(r) ? "Pass" : "Unknown";
    return { result, critique: String(o.critique ?? "") };
  } catch { return { result: "Unknown", critique: `unparseable verdict: ${raw.slice(0, 200)}` }; }
}

export async function defaultJudgeAsk(system: string, user: string, model: string): Promise<string> {
  const client = new Anthropic();
  const res = await client.messages.create({ model, max_tokens: 1200, system, messages: [{ role: "user", content: user }] });
  if (res.stop_reason === "refusal") return JSON.stringify({ critique: "the model declined", result: "Unknown" });
  return res.content.filter((b): b is Anthropic.TextBlock => b.type === "text").map((b) => b.text).join("");
}

export async function judgeTraces(opts: { evalsDir: string; judge: JudgeFiles; traceIds: string[]; labelsByTrace: Map<string, { label: string; note?: string }>; ask?: JudgeAsk; concurrency?: number; onVerdict?: (v: Verdict, done: number, total: number) => void }): Promise<Verdict[]> {
  const ask = opts.ask ?? defaultJudgeAsk;
  const model = String(opts.judge.judge.model);
  const out: Verdict[] = new Array(opts.traceIds.length);
  let next = 0, done = 0;
  const worker = async () => {
    while (next < opts.traceIds.length) {
      const i = next++; const id = opts.traceIds[i]!;
      const v = loadTraceView(opts.evalsDir, id);
      if (!v) { out[i] = { trace_id: id, result: "Unknown", critique: "trace not found under datasets/traces/" }; }
      else {
        const { system, user } = buildMessages(opts.judge, opts.evalsDir, v, opts.labelsByTrace);
        let raw = "";
        try { raw = await ask(system, user, model); } catch (e) { raw = JSON.stringify({ critique: `model error: ${(e as Error).message}`, result: "Unknown" }); }
        out[i] = { trace_id: id, ...parseVerdict(raw), raw };
      }
      done++; opts.onVerdict?.(out[i]!, done, opts.traceIds.length);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(opts.concurrency ?? 4, opts.traceIds.length)) }, worker));
  return out;
}
