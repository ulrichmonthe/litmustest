// Generates docs/SCHEMAS.md from the descriptions in schemas/*.json. Run: npm run docs:schemas
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

type S = Record<string, any>;
const root = join(import.meta.dirname, "..");
const dir = join(root, "schemas");
const schemas: Record<string, S> = {};
for (const f of readdirSync(dir).sort()) if (f.endsWith(".json")) schemas[f.replace(/\.json$/, "")] = JSON.parse(readFileSync(join(dir, f), "utf8"));

const FILE: Record<string, string> = {
  config: "evals/litmustest.yaml", failure_mode: "evals/failure_modes/<name>.yaml", task: "evals/tasks/**/<id>.yaml",
  "check.code": "inline in a task", "check.judge": "inline in a task", "check.outcome": "inline in a task", "check.transcript": "inline in a task",
  reference_solution: "evals/refs/<task id>.json", judge: "evals/graders/judges/<name>/judge.yaml", calibration: "evals/graders/judges/<name>/calibration.json",
  label: "evals/labels/<batch>.jsonl (one object per line)", suite: "evals/suites/<name>.yaml", run_summary: "evals/runs/<run id>.json",
  trace: "evals/datasets/traces/<id>.json", "trace.jsonl_adapter": "ingest input only; never stored",
};
const ORDER = ["config", "failure_mode", "task", "check.code", "check.judge", "check.outcome", "check.transcript", "reference_solution", "judge", "calibration", "label", "suite", "run_summary", "trace", "trace.jsonl_adapter"];

function refName(ref: string): string {
  const m = /^(?:([a-z_.]+)\.json)?#\/\$defs\/([a-z_]+)$/.exec(ref);
  if (m) return m[2]!;
  const n = /^([a-z_.]+)\.json$/.exec(ref);
  return n ? n[1]! : ref;
}
function typeOf(p: S): string {
  if (p.$ref) return `[${refName(p.$ref)}](#${refName(p.$ref).replace(/\./g, "")})`;
  if (p.const !== undefined) return `\`${JSON.stringify(p.const)}\``;
  if (p.enum) return p.enum.map((e: unknown) => `\`${e}\``).join(" · ");
  if (p.oneOf || p.anyOf) return (p.oneOf ?? p.anyOf).map(typeOf).join(" or ");
  if (p.type === "array") return `array of ${p.items ? typeOf(p.items) : "any"}`;
  if (p.type === "object" && p.additionalProperties && typeof p.additionalProperties === "object" && !p.properties) return `map of ${typeOf(p.additionalProperties)}`;
  if (Array.isArray(p.type)) return p.type.join(" or ");
  return p.type ?? "any";
}
function constraints(p: S): string {
  const c: string[] = [];
  if (p.pattern) c.push(`pattern \`${p.pattern}\``);
  if (p.format) c.push(p.format);
  if (p.minimum !== undefined) c.push(`≥ ${p.minimum}`);
  if (p.exclusiveMinimum !== undefined) c.push(`> ${p.exclusiveMinimum}`);
  if (p.maximum !== undefined) c.push(`≤ ${p.maximum}`);
  if (p.minLength !== undefined) c.push(`min length ${p.minLength}`);
  if (p.maxLength !== undefined) c.push(`max length ${p.maxLength}`);
  if (p.minItems !== undefined) c.push(`min ${p.minItems} items`);
  if (p.maxItems !== undefined) c.push(`max ${p.maxItems} items`);
  if (p.uniqueItems) c.push("unique");
  if (p.default !== undefined) c.push(`default \`${JSON.stringify(p.default)}\``);
  return c.join(", ");
}
function cell(s: unknown): string { return String(s ?? "").replace(/\|/g, "\\|").replace(/\n/g, " "); }

function table(props: S, required: string[], depth: number): string[] {
  const out: string[] = ["| Field | Type | Required | Constraints | Description |", "| --- | --- | --- | --- | --- |"];
  const nested: string[] = [];
  for (const [k, p] of Object.entries(props) as [string, S][]) {
    out.push(`| \`${k}\` | ${typeOf(p)} | ${required.includes(k) ? "yes" : ""} | ${cell(constraints(p))} | ${cell(p.description)} |`);
    const inner = p.type === "object" && p.properties ? p : p.type === "array" && p.items?.properties ? p.items : p.additionalProperties?.properties ? p.additionalProperties : null;
    if (inner && depth < 3) {
      nested.push("", `${"#".repeat(Math.min(depth + 4, 6))} \`${k}\`${p.type === "array" ? " (each item)" : p.additionalProperties ? " (each value)" : ""}`, "");
      nested.push(...table(inner.properties, inner.required ?? [], depth + 1));
    }
  }
  return [...out, ...nested];
}

const lines: string[] = [
  "# Schemas",
  "",
  "Generated from `schemas/*.json` by `npm run docs:schemas`. Do not edit by hand.",
  "",
  "Every file under `evals/` has a JSON Schema (draft 2020-12), versioned under `https://litmustest.dev/schemas/v1/`. `litmustest validate` checks every file against its schema and then applies the cross-file rules listed at the end.",
  "",
  "| Schema | File | Purpose |",
  "| --- | --- | --- |",
];
for (const n of ORDER) {
  const s = schemas[n]!;
  lines.push(`| [${n}](#${n.replace(/\./g, "")}) | \`${FILE[n]}\` | ${cell(s.title)} |`);
}
lines.push("", "Shared definitions (names, timestamps, model ids, gates, confusion matrices) live in [common](#common).", "");
for (const n of [...ORDER, "common"]) {
  const s = schemas[n]!;
  lines.push(`## ${n}`, "", s.description, "");
  if (s.properties) {
    lines.push(...table(s.properties, s.required ?? [], 0));
    if (s.anyOf && !s.properties.type) lines.push("", `At least one of: ${s.anyOf.map((a: S) => (a.required ?? []).map((r: string) => `\`${r}\``).join(", ")).join("; ")}.`);
  }
  if (s.$defs) {
    lines.push("", `### Definitions in ${n}`, "");
    for (const [k, d] of Object.entries(s.$defs) as [string, S][]) {
      lines.push(`#### ${k}`, "", d.description ?? "", "");
      if (d.properties) lines.push(...table(d.properties, d.required ?? [], 1));
      else { const c = constraints(d); lines.push(`Type: ${typeOf(d)}${c ? `. ${c}` : ""}.`); }
      lines.push("");
    }
  }
  lines.push("");
}
lines.push(
  "## Cross-file rules",
  "",
  "`litmustest validate` enforces these after the per-file schema checks. Errors fail the run; warnings do not.",
  "",
  "| Rule | Level | What it checks |",
  "| --- | --- | --- |",
  "| `name_matches_file` | error | A failure mode, task, suite, judge, calibration, trace or run summary carries the id its file or directory name says. |",
  "| `failure_mode_exists` | error | Every failure mode referenced by a check, a judge or a label exists under `failure_modes/`. |",
  "| `failure_mode_not_retired` | error | No check references a retired failure mode. |",
  "| `suite_exists` | error | A task's `suite` has a file under `suites/`. |",
  "| `task_exists`, `task_suite_matches` | error | A suite's `tasks` list names real tasks that declare that suite. |",
  "| `reference_exists`, `reference_task_matches` | error | A task's `reference_solution` exists and names the task. |",
  "| `judge_exists`, `judge_failure_mode_matches` | error | A judge check's judge exists and detects the check's failure mode. |",
  "| `judge_calibrated` | error | A judge used by a check has a `calibration.json`. |",
  "| `judge_trusted` | warning | A judge whose status is not `trusted` will not count in gates. |",
  "| `prompt_exists`, `prompt_hash` | error / warning | `prompt.md` exists; its SHA-256 matches `prompt_hash`, otherwise the judge is stale. |",
  "| `stale_on_change` | error | A calibration marked `trusted` measured the prompt and model the judge uses now. |",
  "| `trusted_requires_test`, `trust_threshold` | error | `trusted` needs a test run with TPR and TNR at or above `judges.trust_threshold`. |",
  "| `splits_disjoint` | error | Train, dev and test share no trace ids. |",
  "| `no_leakage`, `few_shot_from_train` | error / warning | No few-shot example comes from dev or test; each should come from train. |",
  "| `code_fn_exists` | error | A code check's `fn` file exists. |",
  "| `check_ids_unique` | error | Check ids are unique within a task. |",
  "| `gate_suite_exists` | warning | Every gate in `litmustest.yaml` names a suite file. |",
  "| `trace_exists` | warning | A label's trace is present under `datasets/traces/` (only checked when that directory has files). |",
  "| `reference_passes` | error (`--deep`) | Each task's code, outcome and transcript checks pass against its reference solution. Judge checks are noted and skipped; they run under `litmustest run`. |",
  "",
  "## Code check contract",
  "",
  "A code check is a Python file under `graders/code/` exposing `check(trial: dict, args: dict) -> bool`. `trial` carries `input`, `output`, `state`, `tool_calls` and `transcript` in the shape of a reference solution; `args` is the check's `args` from the task. The validator runs it with `python3 -I` against the reference solution under `--deep`.",
  "",
);
writeFileSync(join(root, "docs", "SCHEMAS.md"), lines.join("\n"));
console.log("wrote docs/SCHEMAS.md");
