// Plain-language explanations of a trial: what was tested, what went wrong and where, what kind of failure it is,
// and what would make it pass. The template needs no model and always matches the data. Claude can add a reading
// of the transcript, stored in the run summary as trials[n].explanation so it is written once and reviewed as a diff.
import Anthropic from "@anthropic-ai/sdk";
import type { TraceView } from "./trace_view.ts";
import { parseJson, type Ask } from "./discover.ts";

type Obj = Record<string, unknown>;
export const EXPLAIN_MODEL = "claude-opus-5-5";

export type ExplainKind = "pass" | "not_built" | "broke" | "quality" | "infra" | "broken_task" | "grader_doubt" | "flaky";
export interface Grade { check: string; type: string; pass: boolean | null; reason?: string; failure_mode?: string; excluded?: boolean; critique?: string; step?: number }
export interface OutcomeRow { check: string; path: string; expected: unknown; actual: unknown; reference?: unknown }
export interface ExplainInput {
  task: { id: string; suite?: string; description?: string; source?: string; checks?: Obj[] };
  suiteKind?: string;                       // regression | capability | quality
  summary: Obj;                             // the trial's entry in the run summary
  grades: Grade[];
  view: TraceView | null;
  outcome: OutcomeRow[];
  modes?: Record<string, string>;           // failure mode name -> definition
  likelyBroken?: boolean; flaky?: boolean;
  stderr?: string;
}
export interface Where { step: number; label: string; detail: string }
export interface TemplateExplanation {
  kind: ExplainKind; title: string; headline: string;
  tested: string; happened: string; where?: Where; meaning: string; to_pass: string[];
  failed: { check: string; type: string; failure_mode?: string; mode_definition?: string; plain: string }[];
}
export interface ClaudeExplanation { summary: string; cause: string; fix: string; confidence: "high" | "medium" | "low"; model: string; at: string }

const show = (v: unknown) => (v === undefined ? "nothing" : v === null ? "null" : typeof v === "string" ? `"${v}"` : JSON.stringify(v));

/** The first step that went wrong: a tool call with an error, or an HTTP-like status of 400 or more. */
export function firstProblem(view: TraceView | null): Where | undefined {
  if (!view) return;
  let toolIx = -1;
  for (let i = 0; i < view.turns.length; i++) {
    const t = view.turns[i]!; if (t.role !== "tool") continue; toolIx++;
    const c = view.calls[toolIx]; const r = (c?.result ?? null) as Obj | null;
    const status = r && typeof r === "object" ? Number(r.status ?? r.status_code ?? NaN) : NaN;
    const err = r && typeof r === "object" ? (r.error ?? (r.body as Obj | undefined)?.error) : undefined;
    if ((c && !c.ok) || status >= 400 || err) {
      const args = (c?.args ?? {}) as Obj;
      const label = args.path ? `${String(args.method ?? (c?.name.startsWith("get_") ? "GET" : "POST")).toUpperCase()} ${args.path}` : (c?.name ?? t.tool ?? "a tool call");
      const body = (r?.body ?? r) as Obj | undefined;
      const msg = [body?.detail, body?.message, body?.error, err].find((x) => typeof x === "string" && x) as string | undefined;
      const detail = `${Number.isFinite(status) ? `returned ${status}` : "failed"}${msg ? `: “${msg.trim().replace(/[.!]+$/, "")}”` : ""}`;
      return { step: i, label, detail };
    }
  }
}

function plainFor(g: Grade, outcome: OutcomeRow[], checks: Obj[]): string {
  if (g.type === "outcome") {
    const rows = outcome.filter((r) => r.check === g.check && JSON.stringify(r.actual) !== JSON.stringify(r.expected));
    if (rows.length) return `The end state was wrong: ${rows.map((r) => `${r.path} should be ${show(r.expected)} but was ${show(r.actual)}`).join("; ")}.`;
  }
  if (g.type === "code") { const fn = checks.find((c) => c.id === g.check)?.fn; return `The code check ${fn ? String(fn).split("/").pop() : g.check} said no${g.reason && !/returned False$/.test(g.reason) ? `: ${g.reason}` : "."}`; }
  if (g.type === "judge") return `The judge said Fail${g.critique ? `: ${g.critique}` : g.reason ? `: ${g.reason}` : "."}`;
  if (g.type === "transcript") return `The transcript check failed${g.reason ? `: ${g.reason}` : "."}`;
  return g.reason ? `${g.check} failed: ${g.reason}` : `The ${g.type === "check" ? "" : g.type + " "}check ${g.check} failed${g.failure_mode ? ` (failure mode ${g.failure_mode})` : ""}.`;
}

/** The deterministic explanation. */
export function explainTemplate(x: ExplainInput): TemplateExplanation {
  const checks = (x.task.checks ?? []) as Obj[];
  const tested = x.task.description ? x.task.description.trim() : `Task ${x.task.id}${x.task.source ? ` (from ${x.task.source})` : ""}.`;
  // Without the stored grades (transcripts not in the local store), fall back to the run summary's failed check ids.
  const failedGrades = x.grades.length ? x.grades.filter((g) => g.pass === false && !g.excluded)
    : ((x.summary.failed_checks as string[] | undefined) ?? []).map((id) => { const c = checks.find((k) => k.id === id); return { check: id, type: String(c?.type ?? "check"), pass: false, failure_mode: c?.failure_mode as string | undefined }; });
  const failed = failedGrades.map((g) => ({ check: g.check, type: g.type, failure_mode: g.failure_mode, mode_definition: g.failure_mode ? x.modes?.[g.failure_mode] : undefined, plain: plainFor(g, x.outcome, checks) }));
  const where = firstProblem(x.view);
  const whereText = where ? ` It went wrong at step ${where.step + 1}, when ${where.label} ${where.detail}.` : "";
  const toPass: string[] = [];
  for (const g of failedGrades) {
    if (g.type === "outcome") for (const r of x.outcome.filter((o) => o.check === g.check && JSON.stringify(o.actual) !== JSON.stringify(o.expected))) toPass.push(`Make ${r.path} equal ${show(r.expected)}${r.reference !== undefined && JSON.stringify(r.reference) === JSON.stringify(r.expected) ? " (the reference solution gets this)" : ""}.`);
    else if (g.type === "judge") toPass.push(`Fix what the ${g.failure_mode ?? g.check} judge objected to, or dispute its verdict if you disagree.`);
    else toPass.push(`Make ${g.check} pass${g.failure_mode ? ` (failure mode ${g.failure_mode})` : ""}.`);
  }
  const short = where ? `${where.label} ${where.detail} at step ${where.step + 1}.` : failed[0]?.plain ?? "";

  const s = x.summary;
  if (s.infra_error) {
    const kind = String(s.infra_error_kind ?? "harness");
    return { kind: "infra", title: "The run itself broke.", headline: `The trial did not finish (${kind}), so nothing about the product was measured.`, tested, happened: `The harness reported a ${kind} error before the checks could run.${x.stderr ? ` Last output: ${x.stderr.trim().split("\n").slice(-1)[0]}` : ""}`, where, meaning: "Infra failures are excluded from scores and gates. Fix the environment and run again.", to_pass: ["Run the task again; if it repeats, read the harness output below the timeline."], failed };
  }
  if (s.pass) return { kind: "pass", title: "Passed.", headline: `Every check passed (${x.grades.filter((g) => g.pass === true).length} of ${x.grades.length}).`, tested, happened: "The product did what this task asks.", meaning: x.suiteKind === "capability" ? "A passing capability task is progress; after three clean runs it can graduate to regression." : "Nothing to do.", to_pass: [], failed };
  if (x.likelyBroken) return { kind: "broken_task", title: "The task is probably wrong.", headline: "This task has failed every trial across recent runs while its reference solution passes.", tested, happened: (failed[0]?.plain ?? "") + whereText, where, meaning: "When nothing ever passes, suspect the task's setup, inputs or expectations before the product.", to_pass: ["Check the task's input and expected values against the spec.", ...toPass], failed };
  if (failedGrades.length && failedGrades.every((g) => g.type === "judge")) return { kind: "grader_doubt", title: "Only a judge failed it.", headline: "The code and outcome checks passed; a model judge said Fail.", tested, happened: failed.map((f) => f.plain).join(" ") + whereText, where, meaning: "Read the judge's critique before trusting it. If it is wrong, dispute it; that becomes a label that recalibrates the judge.", to_pass: toPass, failed };
  const happened = (failed.length ? failed.map((f) => f.plain).join(" ") : x.grades.some((g) => g.pass === null) ? "Some checks could not decide." : "It failed.") + whereText;
  if (x.flaky) return { kind: "flaky", title: "Flaky.", headline: "This task passes some trials and fails others with nothing changed.", tested, happened, where, meaning: "Its pass rate is not trustworthy until the variation is understood. Compare a passing and a failing trial.", to_pass: toPass, failed };
  if (x.suiteKind === "capability") return { kind: "not_built", title: "Not built yet.", headline: short || "The feature this task checks is not there yet.", tested, happened, where, meaning: "This is a capability task: it was written ahead of the feature, so failing is expected until the feature exists. It does not block merging.", to_pass: toPass, failed };
  if (x.suiteKind === "quality") return { kind: "quality", title: "Quality below the bar.", headline: short || `A quality check failed on ${x.task.id}.`, tested, happened, where, meaning: "Quality tasks are scored by trusted judges; this counts toward the quality gate.", to_pass: toPass, failed };
  return { kind: "broke", title: "Something that worked is broken.", headline: short || "A check that used to pass now fails.", tested, happened, where, meaning: "This is a regression task: it passed before, so this failure blocks the merge gate until it is fixed or the task is changed on purpose.", to_pass: toPass, failed };
}

/** A compact, bounded transcript for the model. */
export function transcriptText(view: TraceView | null, limit = 12000): string {
  if (!view) return "(no transcript)";
  let toolIx = -1; const lines: string[] = [];
  view.turns.forEach((t, i) => {
    if (t.role === "tool") { toolIx++; const c = view.calls[toolIx]; lines.push(`[${i + 1}] TOOL ${c?.name ?? t.tool}(${JSON.stringify(c?.args ?? {}).slice(0, 600)}) -> ${JSON.stringify(c?.result ?? t.content).slice(0, 900)}`); }
    else lines.push(`[${i + 1}] ${t.role.toUpperCase()}: ${t.content.slice(0, 1500)}`);
  });
  const s = lines.join("\n"); return s.length > limit ? s.slice(0, limit) + "\n…(truncated)" : s;
}

const SYSTEM = `You explain why an automated eval of a software product failed, for the person who owns the product.
Write for someone who knows the product but did not write the test. Plain words, no jargon about evals.
Use only what is in the facts and the transcript. If the cause is not visible there, say what is visible and that the cause is not.
Return only JSON: {"summary": "2-3 sentences: what the test tried, what happened, and what that means", "cause": "one sentence: the most likely reason, naming the step", "fix": "one sentence: the concrete change that would make it pass", "confidence": "high" | "medium" | "low"}`;

export function explainPrompt(x: ExplainInput, t: TemplateExplanation): string {
  return [
    `Task: ${x.task.id} (${x.suiteKind ?? x.task.suite ?? "unknown"} suite)${x.task.source ? `, written from ${x.task.source}` : ""}`,
    `What it tests: ${t.tested}`,
    `Kind of result: ${t.title} ${t.meaning}`,
    `Failed checks:\n${t.failed.map((f) => `- ${f.check} (${f.type}${f.failure_mode ? `, failure mode ${f.failure_mode}` : ""}): ${f.plain}${f.mode_definition ? `\n  Failure mode definition: ${f.mode_definition}` : ""}`).join("\n") || "- none"}`,
    t.where ? `First step that went wrong: step ${t.where.step + 1}, ${t.where.label} ${t.where.detail}` : "No step returned an error.",
    `Transcript (numbered steps):\n${transcriptText(x.view)}`,
  ].join("\n\n");
}

export async function explainWithClaude(x: ExplainInput, opts: { ask?: Ask; model?: string; now?: Date } = {}): Promise<ClaudeExplanation> {
  const model = opts.model ?? EXPLAIN_MODEL;
  const t = explainTemplate(x);
  const raw = await (opts.ask ?? defaultExplainAsk(model))(SYSTEM, explainPrompt(x, t));
  const p = parseJson(raw) as Obj;
  const str = (v: unknown, n: number) => String(v ?? "").trim().slice(0, n);
  const out: ClaudeExplanation = { summary: str(p.summary, 1200), cause: str(p.cause, 500), fix: str(p.fix, 500), confidence: (["high", "medium", "low"].includes(String(p.confidence)) ? p.confidence : "low") as ClaudeExplanation["confidence"], model, at: (opts.now ?? new Date()).toISOString().replace(/\.\d{3}Z$/, "Z") };
  if (!out.summary) throw new Error("the model returned no summary");
  return out;
}

function defaultExplainAsk(model: string): Ask {
  return async (system, user) => {
    const client = new Anthropic();
    const res = await client.messages.create({ model, max_tokens: 1500, system, messages: [{ role: "user", content: user }] });
    if (res.stop_reason === "refusal") throw new Error("the model declined to explain this trial");
    return res.content.filter((b): b is Anthropic.TextBlock => b.type === "text").map((b) => b.text).join("");
  };
}
