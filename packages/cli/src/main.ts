#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateEvals, type Problem } from "./validate.ts";
import { initEvals } from "./init.ts";
import { ingest } from "./ingest.ts";
import { serve } from "./serve.ts";
import { discover } from "./discover.ts";
import { App } from "./server/app.ts";
import { calibrate } from "./calibrate.ts";
import { draftCheck, draftJudge } from "./draft.ts";

const VERSION: string = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf8")).version;

const HELP = `litmustest ${VERSION}

Usage:
  litmustest init [--dir evals] [--project name] [--source file.jsonl] [--force]
      Scaffold an evals/ directory with litmustest.yaml, the folders, a README
      and three empty suites. Detects a JSONL trace source in the usual places.

  litmustest ingest <source> [--dir evals] [--size N] [--clusters K] [--seed S] [--batch name]
      Normalize traces to the internal shape under datasets/traces/, cluster
      them (TF-IDF + k-means, offline), and write a review batch of one
      representative per cluster plus a random draw to batches/<name>.yaml
      with a coverage report. Defaults come from sources.sampler in the config.

  litmustest discover [--dir evals] [--batch name] [--apply] [--json]
      Group the reviewers' notes into failure modes with the model and show
      each proposed failure_modes/<name>.yaml as a diff. Nothing is written
      unless --apply, which saves the files (validated) as pending changes
      on the branch for a person to commit. Needs ANTHROPIC_API_KEY.

  litmustest draft-judge <failure_mode> [--dir evals]
      Draft a judge from the labels: prompt.md with Fail/Pass criteria from
      the reviewers' notes, judge.yaml with three few-shot examples from the
      train split, and calibration.json with the splits (status untested).
      Lands uncommitted on the branch. Needs ANTHROPIC_API_KEY.

  litmustest draft-check <failure_mode> [--dir evals]
      Draft a Python code check for the failure mode plus a test, write a
      fixture of labelled trials under graders/code/fixtures/, run the test
      and report agreement with the labels. Needs ANTHROPIC_API_KEY.

  litmustest calibrate <judge> [--dir evals] [--split dev|test|none] [--force] [--json]
      Split the judge's labels 15/45/40 (train/dev/test, test locked once
      drawn), run the judge on the dev split (freely) or the test split
      (once, after dev reaches the trust threshold), and write TPR, TNR,
      bootstrap intervals, the confusion matrix and the disagreements to
      calibration.json. --split none only refreshes splits and status.

  litmustest serve [--dir evals] [--port 4242] [--host 127.0.0.1]
      Local server over evals/: reads with content hashes, validated writes
      that land on an evals/<slug> branch, the Pending changes API (commit,
      open PR, discard), append-only labels, batches and traces for the
      review queue, and server-sent events from the file watcher.

  litmustest validate [path] [--deep] [--json] [--quiet]
      Validate an evals/ directory (default: ./evals) against the schemas and
      the cross-file rules. --deep also runs each task's code, outcome and
      transcript checks against its reference solution. Exit 1 on any error.

  litmustest --version
  litmustest --help

Commands run, compare, ci and doctor arrive in later
phases; see docs/SPEC.md.
`;

function main(argv: string[]): number {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === "--help" || cmd === "-h" || cmd === "help") { process.stdout.write(HELP); return 0; }
  if (cmd === "--version" || cmd === "-v") { process.stdout.write(VERSION + "\n"); return 0; }
  if (cmd === "init") return runInit(rest);
  if (cmd === "ingest") return runIngest(rest);
  if (cmd === "serve") { runServe(rest); return 0; }
  if (cmd === "discover") { runDiscover(rest); return 0; }
  if (cmd === "calibrate") { runCalibrate(rest); return 0; }
  if (cmd === "draft-judge" || cmd === "draft-check") { runDraft(cmd, rest); return 0; }
  if (cmd !== "validate") { process.stderr.write(`unknown command '${cmd}'\n\n${HELP}`); return 2; }

  const flags = new Set(rest.filter((a) => a.startsWith("--")));
  const unknown = [...flags].filter((f) => !["--deep", "--json", "--quiet"].includes(f));
  if (unknown.length) { process.stderr.write(`unknown flag ${unknown.join(", ")}\n`); return 2; }
  const path = resolve(rest.find((a) => !a.startsWith("--")) ?? "evals");

  const result = validateEvals(path, { deep: flags.has("--deep") });

  if (flags.has("--json")) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    return result.errors ? 1 : 0;
  }
  const byFile = new Map<string, Problem[]>();
  for (const p of result.problems) byFile.set(p.file, [...(byFile.get(p.file) ?? []), p]);
  for (const [file, ps] of byFile) {
    process.stdout.write(`${file}\n`);
    for (const p of ps) {
      if (flags.has("--quiet") && p.level !== "error") continue;
      process.stdout.write(`  ${p.level.padEnd(7)} ${p.message}\n`);
    }
  }
  const infos = result.problems.length - result.errors - result.warnings;
  process.stdout.write(`${result.errors ? "FAIL" : "OK"}: ${result.files} files, ${result.errors} errors, ${result.warnings} warnings${infos ? `, ${infos} notes` : ""}\n`);
  return result.errors ? 1 : 0;
}

function opts(rest: string[], known: string[]): { values: Map<string, string>; flags: Set<string>; positional: string[] } {
  const values = new Map<string, string>(); const flags = new Set<string>(); const positional: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (!a.startsWith("--")) { positional.push(a); continue; }
    if (!known.includes(a)) throw new Error(`unknown flag ${a}`);
    const next = rest[i + 1];
    if (["--force", "--json", "--apply"].includes(a) || next === undefined || next.startsWith("--")) flags.add(a); else { values.set(a, next); i++; }
  }
  return { values, flags, positional };
}

function runInit(rest: string[]): number {
  try {
    const { values, flags } = opts(rest, ["--dir", "--project", "--source", "--force"]);
    const r = initEvals({ dir: values.get("--dir"), project: values.get("--project"), source: values.get("--source"), force: flags.has("--force") });
    process.stdout.write(`created ${r.files.length} files under ${r.dir}\n`);
    for (const n of r.notes) process.stdout.write(`  ${n}\n`);
    return 0;
  } catch (e) { process.stderr.write(`init: ${(e as Error).message}\n`); return 1; }
}

function runIngest(rest: string[]): number {
  try {
    const { values, flags, positional } = opts(rest, ["--dir", "--size", "--clusters", "--seed", "--batch", "--json"]);
    const source = positional[0];
    if (!source) { process.stderr.write("ingest: a source file is required\n"); return 2; }
    const num = (k: string) => (values.has(k) ? Number(values.get(k)) : undefined);
    const r = ingest({ evalsDir: values.get("--dir") ?? "evals", source, size: num("--size"), clusters: num("--clusters"), seed: num("--seed"), batch: values.get("--batch") });
    if (flags.has("--json")) { process.stdout.write(JSON.stringify({ ...r, warnings: Object.fromEntries(r.warnings) }, null, 2) + "\n"); return r.invalid.length ? 1 : 0; }
    process.stdout.write(`${r.traces} traces normalized: ${r.written} written, ${r.skipped} unchanged, ${r.invalid.length} invalid\n`);
    for (const [w, n] of r.warnings) process.stdout.write(`  warning ${w} (${n})\n`);
    for (const inv of r.invalid.slice(0, 10)) process.stdout.write(`  invalid ${inv.id}: ${inv.errors.join("; ")}\n`);
    const cov = r.coverage as { total_traces: number; sampled: number; clusters: { id: number; size: number; sampled: number; terms: string[] }[] };
    process.stdout.write(`batch ${(r.batch as { name: string }).name}: ${cov.sampled} of ${cov.total_traces} traces, ${cov.clusters.length} clusters\n`);
    for (const c of cov.clusters) process.stdout.write(`  cluster ${String(c.id).padStart(2)}  ${String(c.size).padStart(4)} traces  ${String(c.sampled).padStart(3)} sampled  ${c.terms.join(", ")}\n`);
    process.stdout.write(`wrote ${r.batchFile}\n`);
    return r.invalid.length ? 1 : 0;
  } catch (e) { process.stderr.write(`ingest: ${(e as Error).message}\n`); return 1; }
}

function runDraft(cmd: string, rest: string[]): void {
  const { values, positional } = opts(rest, ["--dir"]);
  const mode = positional[0];
  if (!mode) { process.stderr.write(`${cmd}: a failure mode name is required\n`); process.exitCode = 2; return; }
  const evalsDir = resolve(values.get("--dir") ?? "evals");
  (cmd === "draft-judge" ? draftJudge({ evalsDir, failureMode: mode }) : draftCheck({ evalsDir, failureMode: mode }))
    .then((r) => {
      for (const f of r.files) process.stdout.write(`${f.action.padEnd(8)} ${f.path}\n`);
      for (const n of r.notes) process.stdout.write(`  ${n}\n`);
      if (r.agreement) process.stdout.write(`\n${r.agreement.output}\n`);
      process.stdout.write("Uncommitted on the branch: review with git diff or the Pending changes tray.\n");
    })
    .catch((e: Error) => { process.stderr.write(`${cmd}: ${e.message}\n`); process.exitCode = 1; });
}

function runCalibrate(rest: string[]): void {
  const { values, flags, positional } = opts(rest, ["--dir", "--split", "--force", "--json"]);
  const judge = positional[0];
  if (!judge) { process.stderr.write("calibrate: a judge name is required\n"); process.exitCode = 2; return; }
  const split = (values.get("--split") ?? "dev") as "dev" | "test" | "none";
  if (!["dev", "test", "none"].includes(split)) { process.stderr.write("calibrate: --split must be dev, test or none\n"); process.exitCode = 2; return; }
  calibrate({ evalsDir: resolve(values.get("--dir") ?? "evals"), judge, split, force: flags.has("--force"), onProgress: flags.has("--json") ? undefined : (d, t, v) => process.stderr.write(`\r  ${d}/${t} judged${v.result === "Unknown" ? " (unknown)" : ""}   `) })
    .then((r) => {
      if (!flags.has("--json")) process.stderr.write("\n");
      if (flags.has("--json")) { process.stdout.write(JSON.stringify(r, null, 2) + "\n"); return; }
      process.stdout.write(`${r.judge}: ${r.labels} labels -> train ${r.splits.train.length} / dev ${r.splits.dev.length} / test ${r.splits.test.length}\n`);
      for (const w of r.warnings) process.stdout.write(`  warning ${w}\n`);
      if (r.ran) {
        const m = r.ran.matrix;
        process.stdout.write(`${split}: TPR ${r.ran.tpr}% (${r.ran.tpr_ci.low}–${r.ran.tpr_ci.high}) · TNR ${r.ran.tnr}% (${r.ran.tnr_ci.low}–${r.ran.tnr_ci.high}) · unknown ${r.ran.unknown}\n`);
        process.stdout.write(`  matrix: tp ${m.tp}  fn ${m.fn}  fp ${m.fp}  tn ${m.tn}\n`);
        if (r.ran.disagreements.length) { process.stdout.write(`  ${r.ran.disagreements.length} disagreements:\n`); for (const d of r.ran.disagreements.slice(0, 15)) process.stdout.write(`    ${d.trace_id}  human ${d.human} / judge ${d.judge}  ${String(d.critique).slice(0, 100)}\n`); }
      }
      process.stdout.write(`status: ${r.status}  (wrote ${r.path})\n`);
    })
    .catch((e: Error) => { process.stderr.write(`calibrate: ${e.message}\n`); process.exitCode = 1; });
}

function runDiscover(rest: string[]): void {
  const { values, flags } = opts(rest, ["--dir", "--batch", "--apply", "--json"]);
  const dir = values.get("--dir") ?? "evals";
  discover({ evalsDir: resolve(dir), batch: values.get("--batch") }).then((r) => {
    if (flags.has("--json")) { process.stdout.write(JSON.stringify(r, null, 2) + "\n"); return; }
    process.stdout.write(`${r.proposals.length} proposed failure-mode files from ${r.notes_used} notes on ${r.traces_used} traces (model ${r.model}); ${r.unassigned.length} notes fit no mode\n\n`);
    for (const p of r.proposals) process.stdout.write(`== ${p.action} ${p.path}\n   ${p.rationale}\n${p.diff}\n`);
    if (!flags.has("--apply")) { process.stdout.write("Nothing written. Re-run with --apply to save these as pending changes, or accept them in the dashboard.\n"); return; }
    const app = new App(dir);
    for (const p of r.proposals) { const res = app.putFile(p.path, p.content); process.stdout.write(`${res.status === 200 ? "saved  " : "refused"} ${p.path}${res.status !== 200 ? `: ${(res.body as { message: string }).message}` : ""}\n`); }
    process.stdout.write(`Pending on branch ${app.git.branch()}. Review with git diff, then commit, or open the Pending changes tray.\n`);
  }).catch((e: Error) => { process.stderr.write(`discover: ${e.message}\n`); process.exitCode = 1; });
}

function runServe(rest: string[]): void {
  try {
    const { values } = opts(rest, ["--dir", "--port", "--host"]);
    serve({ evalsDir: values.get("--dir") ?? "evals", port: values.has("--port") ? Number(values.get("--port")) : undefined, host: values.get("--host") })
      .then((r) => process.stdout.write(`litmustest serving ${r.app.evalsDir} on ${r.url} (branch ${r.app.git.branch()})\n`))
      .catch((e: Error) => { process.stderr.write(`serve: ${e.message}\n`); process.exitCode = 1; });
  } catch (e) { process.stderr.write(`serve: ${(e as Error).message}\n`); process.exitCode = 1; }
}

process.exitCode = main(process.argv.slice(2));
