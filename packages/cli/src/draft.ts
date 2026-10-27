// Draft graders from labels: a judge (prompt.md + judge.yaml + splits) or a code check (a Python function + a test
// against labelled trials). The model writes the draft; the files land uncommitted on the branch for a person to review.
import Anthropic from "@anthropic-ai/sdk";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parse as parseYaml, stringify as yaml } from "yaml";
import { calibrate, labelsFor, makeSplits } from "./calibrate.ts";
import { loadTraceView, renderInputs } from "./judge_run.ts";
import { parseJson, type Ask } from "./discover.ts";
import { SchemaSet } from "./schemas.ts";
import { sha256 } from "./validate.ts";
import type { TraceView } from "./trace_view.ts";

type Obj = Record<string, unknown>;
export const DRAFT_MODEL = "claude-opus-5-5";
export interface DraftResult { files: { path: string; action: "created" | "updated" }[]; notes: string[]; few_shot?: Obj[]; agreement?: { n: number; agree: number; pct: number; output: string } }

function loadMode(evalsDir: string, name: string): Obj {
  const p = join(evalsDir, "failure_modes", `${name}.yaml`);
  if (!existsSync(p)) throw new Error(`no failure mode '${name}' under failure_modes/`);
  return parseYaml(readFileSync(p, "utf8")) as Obj;
}
function config(evalsDir: string): Obj { const p = join(evalsDir, "litmustest.yaml"); return existsSync(p) ? (parseYaml(readFileSync(p, "utf8")) as Obj) : {}; }
async function defaultAsk(system: string, user: string): Promise<string> {
  const client = new Anthropic();
  const res = await client.messages.create({ model: DRAFT_MODEL, max_tokens: 6000, system, messages: [{ role: "user", content: user }] });
  if (res.stop_reason === "refusal") throw new Error("the model declined to draft this");
  return res.content.filter((b): b is Anthropic.TextBlock => b.type === "text").map((b) => b.text).join("");
}
/** The trial shape a code check receives, built from a trace. */
export function trialFromView(v: TraceView): Obj {
  return {
    input: v.turns.find((t) => t.role === "user")?.content ?? "",
    output: [...v.turns].reverse().find((t) => t.role === "agent")?.content ?? "",
    tool_calls: v.calls.map((c) => ({ name: c.name, args: c.args ?? {}, result: c.result ?? null })),
    transcript: v.turns.map((t) => (t.tool ? { role: "tool", tool: t.tool, content: t.content } : { role: t.role, content: t.content })),
  };
}

// ---------------- judge
const JUDGE_SYSTEM = `You write the prompt for a binary LLM judge that detects exactly one failure mode in a support agent's conversations. The judge reads what it is shown, writes a short critique first, then answers Pass, Fail or Unknown.

Write a prompt that:
- Names the one failure mode and restates its definition in the judge's own operating terms.
- Has a "Fail when" list and a "Pass when" list, concrete enough that two readers would agree, using the reviewer's notes as the source of what counts.
- Says what to do when the shown inputs cannot settle it: answer Unknown, never guess.
- Tells the judge to write the critique before the verdict and to quote the line that decides it.
- Stays under 350 words. No headings beyond "Fail when" and "Pass when". Plain prose and lists.

Also choose which inputs the judge needs, from: transcript, output, input, tool_calls. Prefer the smallest set that can settle the verdict.

Return only JSON: {"prompt": "...", "inputs": ["transcript", ...], "rationale": "one sentence"}`;

export async function draftJudge(o: { evalsDir: string; failureMode: string; ask?: Ask; now?: Date }): Promise<DraftResult> {
  const mode = loadMode(o.evalsDir, o.failureMode);
  const labels = labelsFor(o.evalsDir, o.failureMode);
  if (labels.size < 6) throw new Error(`${labels.size} labels for ${o.failureMode}; label at least 6 traces (both Pass and Fail) before drafting a judge`);
  const dir = join(o.evalsDir, "graders", "judges", o.failureMode);
  const calPath = join(dir, "calibration.json");
  const existingSplits = existsSync(calPath) ? (JSON.parse(readFileSync(calPath, "utf8")) as Obj).splits as Record<string, { trace_ids: string[] }> : undefined;
  const splits = makeSplits(o.failureMode, labels, existingSplits ? { train: existingSplits.train.trace_ids, dev: existingSplits.dev.trace_ids, test: existingSplits.test.trace_ids } : undefined);
  if (!splits.train.length) throw new Error("the train split is empty; label more traces first");
  // few-shot: a clear Fail with a note, a clear Pass, and a second Fail (the borderline) from train only
  const train = splits.train.map((id) => ({ id, ...labels.get(id)! })).sort((a, b) => (b.note?.length ?? 0) - (a.note?.length ?? 0));
  const fails = train.filter((t) => t.label === "Fail"), passes = train.filter((t) => t.label === "Pass");
  const shots = [fails[0], passes[0], fails[1] ?? passes[1]].filter(Boolean) as { id: string; label: string; note?: string }[];
  if (!fails.length || !passes.length) throw new Error("the train split needs at least one Pass and one Fail; label more traces");
  const noteLines = [...labels.entries()].filter(([, l]) => l.note).slice(0, 40).map(([id, l]) => `- ${id} · ${l.label}: ${l.note}`);
  const examples = shots.map((s) => { const v = loadTraceView(o.evalsDir, s.id); return v ? `### ${s.id} · ${s.label}${s.note ? ` · note: ${s.note}` : ""}\n${renderInputs(v, ["transcript", "tool_calls"]).slice(0, 2500)}` : ""; }).filter(Boolean).join("\n\n");
  const user = `Failure mode: ${mode.name}\nDefinition: ${mode.definition}\nSeverity: ${mode.severity}\n\nReviewer notes (${noteLines.length}):\n${noteLines.join("\n")}\n\nThree labelled traces from the train split:\n${examples}`;
  const raw = await (o.ask ?? defaultAsk)(JUDGE_SYSTEM, user);
  const out = parseJson(raw) as { prompt?: string; inputs?: string[]; rationale?: string };
  const prompt = String(out.prompt ?? "").trim();
  if (prompt.length < 80) throw new Error("the model returned no usable prompt");
  const allowed = ["transcript", "output", "input", "tool_calls"];
  const inputs = (out.inputs ?? ["transcript"]).filter((i) => allowed.includes(i));
  if (!inputs.length) inputs.push("transcript");
  const model = String((config(o.evalsDir).judges as Obj | undefined)?.default_model ?? "claude-sonnet-5-5");
  const existing = existsSync(join(dir, "judge.yaml")) ? (parseYaml(readFileSync(join(dir, "judge.yaml"), "utf8")) as Obj) : undefined;
  const promptText = prompt + "\n";
  const judge: Obj = {
    id: o.failureMode, failure_mode: o.failureMode, model: existing?.model ?? model, inputs,
    output: { critique: { type: "string", max_chars: 800 }, result: { enum: ["Pass", "Fail", "Unknown"] } },
    few_shot: shots.map((s) => ({ trace_id: s.id, label: s.label, ...(s.note ? { note: s.note.slice(0, 500) } : {}) })),
    prompt: `graders/judges/${o.failureMode}/prompt.md`, prompt_hash: sha256(promptText), temperature: 0, version: existing ? Number(existing.version ?? 1) + 1 : 1,
  };
  const errs = new SchemaSet().check("judge", judge);
  if (errs.length) throw new Error(`drafted judge.yaml would not validate: ${errs.join("; ")}`);
  mkdirSync(dir, { recursive: true });
  const files: DraftResult["files"] = [];
  const write = (p: string, body: string) => { const rel = `graders/judges/${o.failureMode}/${p}`; const abs = join(dir, p); files.push({ path: rel, action: existsSync(abs) ? "updated" : "created" }); writeFileSync(abs, body); };
  write("prompt.md", promptText);
  write("judge.yaml", yaml(judge));
  await calibrate({ evalsDir: o.evalsDir, judge: o.failureMode, split: "none", now: o.now });
  files.push({ path: `graders/judges/${o.failureMode}/calibration.json`, action: existingSplits ? "updated" : "created" });
  return { files, few_shot: judge.few_shot as Obj[], notes: [out.rationale ?? "", `inputs: ${inputs.join(", ")}`, `splits: train ${splits.train.length} / dev ${splits.dev.length} / test ${splits.test.length}`, "Next: litmustest calibrate " + o.failureMode].filter(Boolean) };
}

// ---------------- code check
const CHECK_SYSTEM = `You write a deterministic Python 3.9 function that detects one failure mode in a support agent's trial, plus a test.

The function signature is fixed:

    def check(trial: dict, args: dict) -> bool

trial has: input (str), output (str), tool_calls (list of {name, args, result}), transcript (list of {role, content, tool?}). Return True when the trial PASSES (the failure mode is absent) and False when it FAILS. Use only the standard library. No model calls, no network, no randomness. Prefer structural signals (which tools ran, in what order, with what results, what the output claims) over keyword matching; when text matching is unavoidable, make it narrow and case-insensitive and explain it in a comment.

Also write a test file. It must:
- read the fixture file given as the first command-line argument (JSONL: one trial per line with a "label" field, "Pass" or "Fail", and "trace_id"),
- import check from the module path given as the second argument (use importlib),
- print one line per disagreement as "DISAGREE <trace_id> label=<label> check=<True|False>",
- print a final line "AGREEMENT <agree>/<n>",
- exit 0 always.

Return only JSON: {"module": "<python source of the function>", "test": "<python source of the test>", "rationale": "one sentence", "limits": "one sentence on what this check cannot see"}`;

export async function draftCheck(o: { evalsDir: string; failureMode: string; ask?: Ask; python?: string; fixtureLimit?: number }): Promise<DraftResult> {
  const mode = loadMode(o.evalsDir, o.failureMode);
  const labels = labelsFor(o.evalsDir, o.failureMode);
  if (labels.size < 4) throw new Error(`${labels.size} labels for ${o.failureMode}; label at least 4 traces before drafting a code check`);
  const codeDir = join(o.evalsDir, "graders", "code"); const fixDir = join(codeDir, "fixtures");
  mkdirSync(fixDir, { recursive: true });
  const rows: Obj[] = [];
  for (const [id, l] of labels) { const v = loadTraceView(o.evalsDir, id); if (v) rows.push({ trace_id: id, label: l.label, note: l.note, ...trialFromView(v) }); }
  const fixture = join(fixDir, `${o.failureMode}.jsonl`);
  writeFileSync(fixture, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  const sample = rows.slice(0, o.fixtureLimit ?? 8).map((r) => `### ${r.trace_id} · ${r.label}${r.note ? ` · note: ${r.note}` : ""}\ntools: ${(r.tool_calls as Obj[]).map((c) => `${c.name}(${JSON.stringify(c.args)}) -> ${JSON.stringify(c.result).slice(0, 160)}`).join("; ") || "none"}\noutput: ${String(r.output).slice(0, 500)}`).join("\n\n");
  const user = `Failure mode: ${mode.name}\nDefinition: ${mode.definition}\n\nLabelled trials (${rows.length} in the fixture; ${Math.min(rows.length, o.fixtureLimit ?? 8)} shown):\n${sample}`;
  const raw = await (o.ask ?? defaultAsk)(CHECK_SYSTEM, user);
  const out = parseJson(raw) as { module?: string; test?: string; rationale?: string; limits?: string };
  const mod = String(out.module ?? ""); const test = String(out.test ?? "");
  if (!/def\s+check\s*\(/.test(mod)) throw new Error("the model returned no check(trial, args) function");
  if (!/AGREEMENT/.test(test)) throw new Error("the model returned no usable test");
  const header = `"""${o.failureMode}: drafted by litmustest draft-check from ${rows.length} labelled trials.\n\n${mode.definition}\n${out.limits ? `\nLimits: ${out.limits}\n` : ""}"""\n\n`;
  const modPath = join(codeDir, `${o.failureMode}.py`), testPath = join(codeDir, `test_${o.failureMode}.py`);
  const files: DraftResult["files"] = [{ path: `graders/code/${o.failureMode}.py`, action: existsSync(modPath) ? "updated" : "created" }, { path: `graders/code/test_${o.failureMode}.py`, action: existsSync(testPath) ? "updated" : "created" }, { path: `graders/code/fixtures/${o.failureMode}.jsonl`, action: "created" }];
  writeFileSync(modPath, header + mod.replace(/^"""[\s\S]*?"""\s*/, "") + (mod.endsWith("\n") ? "" : "\n"));
  writeFileSync(testPath, test + (test.endsWith("\n") ? "" : "\n"));
  // run the test against the fixture and report agreement
  let agreement: DraftResult["agreement"];
  const py = o.python ?? "python3";
  const res = spawnSync(py, ["-I", testPath, fixture, modPath], { encoding: "utf8", cwd: dirname(o.evalsDir), timeout: 60_000 });
  const outText = (res.stdout ?? "") + (res.stderr ?? "");
  const m = /AGREEMENT\s+(\d+)\s*\/\s*(\d+)/.exec(outText);
  if (m) agreement = { agree: Number(m[1]), n: Number(m[2]), pct: Number(m[2]) ? +((100 * Number(m[1])) / Number(m[2])).toFixed(1) : 0, output: outText.trim().split("\n").slice(-12).join("\n") };
  else agreement = { agree: 0, n: rows.length, pct: 0, output: (res.error ? `cannot run ${py}: ${res.error.message}` : outText.trim()).slice(-1500) };
  return { files, agreement, notes: [out.rationale ?? "", out.limits ? `limits: ${out.limits}` : "", `agreement with labels: ${agreement.agree}/${agreement.n}`, `Next: add { type: code, fn: graders/code/${o.failureMode}.py, failure_mode: ${o.failureMode} } to the tasks that need it`].filter(Boolean) };
}
