// litmustest discover: group the annotators' free-text notes into failure modes and propose them as files.
// The model proposes; nothing is written unless --apply (CLI) or Accept (dashboard). Every proposal carries a diff.
import Anthropic from "@anthropic-ai/sdk";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml, stringify as yaml } from "yaml";
import { SchemaSet } from "./schemas.ts";
import { traceView } from "./trace_view.ts";

type Obj = Record<string, unknown>;
export const DISCOVER_MODEL = "claude-opus-5-5";
export type Ask = (system: string, user: string) => Promise<string>;

export interface Proposal {
  action: "create" | "update" | "retire";
  name: string; path: string; content: string; diff: string; rationale: string;
  definition: string; severity: "high" | "med" | "low"; owner?: string; examples: string[]; merged_into?: string;
}
export interface DiscoverResult { proposals: Proposal[]; notes_used: number; traces_used: number; unassigned: string[]; model: string; existing: string[] }

export function gatherNotes(evalsDir: string, batch?: string): { notes: { trace_id: string; note: string; failure_mode: string; label: string; annotator: string; excerpt: string }[]; existing: Obj[] } {
  const labelsDir = join(evalsDir, "labels");
  const files = existsSync(labelsDir) ? readdirSync(labelsDir).filter((f) => f.endsWith(".jsonl") && (!batch || f === `${batch}.jsonl`)) : [];
  const seen = new Map<string, { trace_id: string; note: string; failure_mode: string; label: string; annotator: string; excerpt: string }>();
  for (const f of files) for (const line of readFileSync(join(labelsDir, f), "utf8").split("\n")) {
    if (!line.trim()) continue;
    let l: Obj; try { l = JSON.parse(line); } catch { continue; }
    if (!l.note || l.label === "Skip") continue;
    const key = `${l.trace_id}|${l.failure_mode}`;
    seen.set(key, { trace_id: String(l.trace_id), note: String(l.note), failure_mode: String(l.failure_mode), label: String(l.label), annotator: String(l.annotator), excerpt: excerpt(evalsDir, String(l.trace_id)) });
  }
  const fmDir = join(evalsDir, "failure_modes");
  const existing = existsSync(fmDir) ? readdirSync(fmDir).filter((f) => f.endsWith(".yaml")).map((f) => parseYaml(readFileSync(join(fmDir, f), "utf8")) as Obj) : [];
  return { notes: [...seen.values()], existing };
}

function excerpt(evalsDir: string, traceId: string): string {
  const p = join(evalsDir, "datasets", "traces", `${traceId}.json`);
  if (!existsSync(p)) return "";
  try {
    const v = traceView(JSON.parse(readFileSync(p, "utf8")));
    const user = v.turns.find((t) => t.role === "user")?.content ?? "";
    const agent = [...v.turns].reverse().find((t) => t.role === "agent")?.content ?? "";
    const tools = v.calls.map((c) => c.name + (c.ok ? "" : "(error)")).join(", ");
    const cut = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
    return `customer: ${cut(user.replace(/\s+/g, " "), 220)}\ntools: ${tools || "none"}\nagent: ${cut(agent.replace(/\s+/g, " "), 320)}`;
  } catch { return ""; }
}

const SYSTEM = `You organize a human reviewer's free-text notes about an AI product's conversations into a small set of named failure modes. This is axial coding: the reviewer noticed; you group.

Rules:
- Each failure mode is one way the product goes wrong, specific enough that a judge could apply it and a new annotator could recognise it. Not "quality issues"; yes "agent states a refund window without fetching the policy".
- Prefer updating or keeping an existing mode over creating a near-duplicate. Create only when notes describe something no existing mode covers. Propose retiring a mode only when it has no notes and another mode clearly subsumes it (name merged_into).
- Names are snake_case, lowercase, under 40 characters. Definitions are 1 to 3 sentences in plain words, and say what Pass and Fail look like.
- Severity: high when the customer is harmed or data is wrong; med when the answer is right but the experience is poor; low for inefficiency.
- Examples are trace ids taken from the notes, at most 5 per mode, that show the mode clearly.
- Put notes that fit no mode in unassigned rather than forcing them.
- Return only JSON, no prose, matching exactly:
{"modes":[{"action":"create|update|keep|retire","name":"...","definition":"...","severity":"high|med|low","owner":"...","examples":["tr_..."],"rationale":"one sentence citing the notes","merged_into":"name or omitted"}],"unassigned":["tr_..."]}`;

export async function discover(opts: { evalsDir: string; batch?: string; ask?: Ask; maxNotes?: number }): Promise<DiscoverResult> {
  let { notes, existing } = gatherNotes(opts.evalsDir, opts.batch);
  if (!notes.length && opts.batch) ({ notes, existing } = gatherNotes(opts.evalsDir)); // the batch has no labels yet: use every note
  if (!notes.length) throw new Error("no notes to group yet: label some traces in the review queue with a note first");
  const used = notes.slice(0, opts.maxNotes ?? 200);
  const user = [
    `Existing failure modes (${existing.length}):`,
    ...existing.map((m) => `- ${m.name} [${m.severity}${m.retired ? ", retired" : ""}]: ${m.definition}`),
    "",
    `Reviewer notes (${used.length}; each with the trace it was written on):`,
    ...used.map((n, i) => `\n### note ${i + 1} · trace ${n.trace_id} · labelled ${n.label} for ${n.failure_mode} by ${n.annotator}\n${n.note}\n${n.excerpt}`),
  ].join("\n");
  const ask: Ask = opts.ask ?? defaultAsk;
  const raw = await ask(SYSTEM, user);
  const parsed = parseJson(raw) as { modes?: Obj[]; unassigned?: string[] };
  const schemas = new SchemaSet();
  const fmDir = join(opts.evalsDir, "failure_modes");
  const today = new Date().toISOString().slice(0, 10);
  const proposals: Proposal[] = [];
  const existingByName = new Map(existing.map((m) => [String(m.name), m]));
  for (const m of parsed.modes ?? []) {
    const name = String(m.name ?? "").trim();
    const action = String(m.action ?? "create");
    if (action === "keep" || !name) continue;
    const prev = existingByName.get(name);
    const examples = [...new Set(((m.examples as string[]) ?? []).filter((id) => used.some((n) => n.trace_id === id)))].slice(0, 5);
    const file: Obj = prev ? { ...prev } : { name, created: today };
    file.name = name;
    if (action === "retire") { if (!prev) continue; file.retired = today; if (m.merged_into) file.merged_into = m.merged_into; }
    else {
      file.definition = String(m.definition ?? prev?.definition ?? "");
      file.severity = String(m.severity ?? prev?.severity ?? "med");
      if (m.owner) file.owner = String(m.owner);
      const ex = new Set([...(((prev?.examples as string[]) ?? [])), ...examples]);
      if (ex.size) file.examples = [...ex].slice(0, 8);
    }
    const ordered: Obj = {}; for (const k of ["name", "definition", "severity", "owner", "examples", "created", "retired", "merged_into"]) if (file[k] !== undefined) ordered[k] = file[k];
    const errs = schemas.check("failure_mode", ordered);
    if (errs.length) continue; // the model produced something the schema rejects; drop rather than propose a broken file
    const content = yaml(ordered);
    const path = `failure_modes/${name}.yaml`;
    const current = existsSync(join(fmDir, `${name}.yaml`)) ? readFileSync(join(fmDir, `${name}.yaml`), "utf8") : undefined;
    if (current === content) continue;
    proposals.push({ action: prev ? (action === "retire" ? "retire" : "update") : "create", name, path, content, diff: diffText(path, current, content), rationale: String(m.rationale ?? ""), definition: String(ordered.definition ?? ""), severity: ordered.severity as Proposal["severity"], owner: ordered.owner as string | undefined, examples: (ordered.examples as string[]) ?? [], merged_into: ordered.merged_into as string | undefined });
  }
  return { proposals, notes_used: used.length, traces_used: new Set(used.map((n) => n.trace_id)).size, unassigned: (parsed.unassigned ?? []).filter((id) => typeof id === "string"), model: opts.ask ? "injected" : DISCOVER_MODEL, existing: existing.map((m) => String(m.name)) };
}

async function defaultAsk(system: string, user: string): Promise<string> {
  const client = new Anthropic();
  const res = await client.messages.create({ model: DISCOVER_MODEL, max_tokens: 8000, system, messages: [{ role: "user", content: user }] });
  if (res.stop_reason === "refusal") throw new Error("the model declined to group these notes");
  return res.content.filter((b): b is Anthropic.TextBlock => b.type === "text").map((b) => b.text).join("");
}

export function parseJson(raw: string): unknown {
  const t = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  try { return JSON.parse(t); } catch { /* try the first balanced object */ }
  const start = t.indexOf("{"); const end = t.lastIndexOf("}");
  if (start >= 0 && end > start) return JSON.parse(t.slice(start, end + 1));
  throw new Error("the model did not return JSON");
}

/** Unified diff between the current file (or nothing) and the proposed content, via git. */
export function diffText(path: string, before: string | undefined, after: string): string {
  const dir = mkdtempSync(join(tmpdir(), "litmustest-diff-"));
  try {
    const a = join(dir, "a"), b = join(dir, "b");
    mkdirSync(a); mkdirSync(b);
    if (before !== undefined) { mkdirSync(join(a, "failure_modes")); writeFileSync(join(a, path), before); }
    mkdirSync(join(b, "failure_modes")); writeFileSync(join(b, path), after);
    try { return execFileSync("git", ["diff", "--no-index", "--", before === undefined ? "/dev/null" : join("a", path), join("b", path)], { cwd: dir, encoding: "utf8" }); }
    catch (e) { return String((e as { stdout?: string }).stdout ?? "").replace(/a\/a\//g, "a/").replace(/b\/b\//g, "b/").replace(/^diff --git a\/b\//m, "diff --git a/"); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
