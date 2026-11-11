#!/usr/bin/env node
import { alertTerm, meaningBlock, plainLines, termList, termText } from "./glossary_cli.ts";
import { readFileSync } from "node:fs";
import { explainRun, explainText } from "./explain_run.ts";
import { computeCoverage } from "./coverage.ts";
import { coverageText, underThresholds } from "./coverage_cli.ts";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
import { fileURLToPath } from "node:url";
import { validateEvals, type Problem } from "./validate.ts";
import { initEvals } from "./init.ts";
import { ingest } from "./ingest.ts";
import { serve } from "./serve.ts";
import { discover } from "./discover.ts";
import { App } from "./server/app.ts";
import { calibrate } from "./calibrate.ts";
import { draftCheck, draftJudge } from "./draft.ts";
import { run } from "./run.ts";
import { compareRuns, comparisonMarkdown, evaluateGates } from "./compare.ts";
import { ci, writeWorkflow } from "./ci.ts";
import { sample, SAMPLER_WORKFLOW } from "./sample.ts";
import { applyGraduations, doctor, graduationProposals } from "./graduate.ts";

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

  litmustest run [--dir evals] [--suite s]... [--task id]... [--trials k] [--concurrency n] [--id run_id] [--dry-run] [--explain] [--plain] [--json]
      Run each task k times in a fresh trial directory via agent.command
      from litmustest.yaml, grade every check (code, outcome, transcript,
      trusted judges), tag infra failures and exclude them, and write
      evals/runs/<run_id>.json with pass rates, intervals corrected for
      judge error, pass@1 and pass^k. Raw transcripts and grades go to the
      configured store. --dry-run grades the reference solutions instead
      of running the agent.
      --explain asks Claude to explain each failed task afterwards.
      --plain (also on compare, calibrate, doctor) prints what each number
      means here, in one sentence from the glossary, under its row.

  litmustest coverage [--dir evals] [--gaps N] [--fail-under map=pct]... [--json]
      How much of the application the evals cover. v1 measures three maps:
      spec (test-case ids in your docs, from coverage.spec), surface (API
      routes or tools, from coverage.surface, matched against the calls the
      latest run's trials made) and risk (failure modes by severity). Each
      item is guarded, checked, planned or none. It does not measure
      production traffic, code lines or the frontend. --fail-under spec=20
      exits 1 when less than 20% of spec items are checked or guarded.

  litmustest explain <term> [--dir evals] | explain --terms
      What a term means, why it matters and what good looks like, then what
      it means in this repo (every judge, suite or task it applies to) with
      the next step. Aliases work: \`explain recall\` finds tpr. The same words
      the dashboard's popovers and the PR comment show.

  litmustest explain [--dir evals] [--run id] [--task id]... [--all] [--force] [--no-model] [--json]
      Explain the failed trials of a run (the latest by default) in plain
      words: what was tested, what went wrong and at which step, what kind
      of failure it is, and what would make it pass. Claude adds its reading
      of the transcript and saves it in the run summary as an uncommitted
      change; --no-model prints the template only and writes nothing. One
      trial per task unless --all; --force re-explains. Needs a model token.

  litmustest compare <A> <B> [--dir evals] [--json] [--markdown] [--plain]
      Paired comparison of two run summaries over their common tasks: per-suite
      delta with a bootstrap interval, significant or within noise; the flip
      list (Broke, Fixed, Flaky); failed checks by failure mode; cost, tokens,
      latency and infra deltas; and the gate verdict for B.

  litmustest ci [--dir evals] [--suite s]... [--base run_id] [--base-branch main] [--comment] [--pr N] [--write-workflow]
      Run the gated suites, compare with the base run (the latest on the base
      branch, else the latest), print the markdown, post it as a PR comment
      with --comment (needs gh), and exit 1 when a gate is crossed. Suites
      marked report_only never fail the build. --write-workflow scaffolds
      .github/workflows/litmustest.yml.

  litmustest sample [--dir evals] [--if-due] [--size N] [--clusters K] [--since ISO] [--batch name] [--write-workflow]
      The production sampler: pull traces that arrived since the last batch
      from sources.traces (new lines in a JSONL source, or new traces from
      Langfuse or Braintrust) and ingest them as a dated review batch.
      --if-due only samples when sources.sampler.every says it is time.
      --write-workflow scaffolds a weekly GitHub Action that opens a PR.

  litmustest graduate [--dir evals] [--runs 3] [--apply] [--json]
      Capability tasks that passed every trial in the last 3 runs are
      proposed for the regression suite; --apply moves them (task file and
      suite lists) as pending changes. Reports capability saturation.

  litmustest doctor [--dir evals] [--json] [--plain]
      Eval health from the files: stale or untested judges, broken and
      flaky tasks, saturation, graduation candidates, unlabelled queue,
      and the next step.

  litmustest draft-judge <failure_mode> [--dir evals]
      Draft a judge from the labels: prompt.md with Fail/Pass criteria from
      the reviewers' notes, judge.yaml with three few-shot examples from the
      train split, and calibration.json with the splits (status untested).
      Lands uncommitted on the branch. Needs ANTHROPIC_API_KEY.

  litmustest draft-check <failure_mode> [--dir evals]
      Draft a Python code check for the failure mode plus a test, write a
      fixture of labelled trials under graders/code/fixtures/, run the test
      and report agreement with the labels. Needs ANTHROPIC_API_KEY.

  litmustest calibrate <judge> [--dir evals] [--split dev|test|none] [--force] [--plain] [--json]
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

See docs/SPEC.md for the method behind each command.
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
  if (cmd === "run") { runRun(rest); return 0; }
  if (cmd === "explain") return runExplain(rest);
  if (cmd === "coverage") return runCoverage(rest);
  if (cmd === "sample") { runSample(rest); return 0; }
  if (cmd === "graduate") return runGraduate(rest);
  if (cmd === "doctor") return runDoctor(rest);
  if (cmd === "compare") return runCompare(rest);
  if (cmd === "ci") { runCi(rest); return 0; }
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
    if (["--force", "--json", "--apply", "--if-due", "--write-workflow"].includes(a) || next === undefined || next.startsWith("--")) flags.add(a); else { values.set(a, next); i++; }
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

function runCompare(rest: string[]): number {
  try {
    const { values, flags, positional } = opts(rest, ["--dir", "--json", "--markdown", "--plain"]);
    const [a, b] = positional; if (!a || !b) { process.stderr.write("compare: two run ids are required\n"); return 2; }
    const dir = resolve(values.get("--dir") ?? "evals");
    const c = compareRuns(dir, a, b); const g = evaluateGates(c);
    if (flags.has("--json")) { process.stdout.write(JSON.stringify({ ...c, gates_passed: g.passed }, null, 2) + "\n"); return 0; }
    process.stdout.write(comparisonMarkdown(c) + "\n");
    if (flags.has("--plain")) process.stdout.write("\n" + meaningBlock(dir, c, { all: true, collapsed: false }));
    return g.passed ? 0 : 1;
  } catch (e) { process.stderr.write(`compare: ${(e as Error).message}\n`); return 1; }
}

function runCi(rest: string[]): void {
  const suites: string[] = []; const values = new Map<string, string>(); const flags = new Set<string>();
  for (let i = 0; i < rest.length; i++) { const a = rest[i]!; if (a === "--suite") suites.push(rest[++i]!); else if (["--comment", "--write-workflow", "--json"].includes(a)) flags.add(a); else if (a.startsWith("--")) { if (!["--dir", "--base", "--base-branch", "--pr", "--repo", "--trials"].includes(a)) { process.stderr.write(`unknown flag ${a}\n`); process.exitCode = 2; return; } values.set(a, rest[++i]!); } }
  const evalsDir = resolve(values.get("--dir") ?? "evals");
  if (flags.has("--write-workflow")) { try { const p = writeWorkflow(dirname(evalsDir)); process.stdout.write(`wrote ${p}\nAdd ANTHROPIC_API_KEY to the repository secrets; the workflow posts the comparison on every pull request.\n`); } catch (e) { process.stderr.write(`ci: ${(e as Error).message}\n`); process.exitCode = 1; } return; }
  ci({ evalsDir, suites, base: values.get("--base"), baseBranch: values.get("--base-branch"), comment: flags.has("--comment"), prNumber: values.get("--pr"), repo: values.get("--repo"), trials: values.has("--trials") ? Number(values.get("--trials")) : undefined, onProgress: (e) => process.stderr.write(`\r  ${e.done}/${e.total} trials   `) })
    .then((r) => {
      process.stderr.write("\n");
      if (flags.has("--json")) process.stdout.write(JSON.stringify(r, null, 2) + "\n"); else process.stdout.write(r.markdown + "\n");
      if (r.reason) process.stderr.write(`note: ${r.reason}\n`);
      if (r.posted) process.stderr.write("posted as a PR comment\n");
      process.exitCode = r.passed ? 0 : 1;
      if (!r.passed) process.stderr.write("a gate was crossed\n");
    })
    .catch((e: Error) => { process.stderr.write(`ci: ${e.message}\n`); process.exitCode = 1; });
}

function runSample(rest: string[]): void {
  try {
    const { values, flags } = opts(rest, ["--dir", "--if-due", "--size", "--clusters", "--since", "--batch", "--write-workflow", "--json"]);
    const evalsDir = resolve(values.get("--dir") ?? "evals");
    if (flags.has("--write-workflow")) { const p = join(dirname(evalsDir), ".github", "workflows", "litmustest-sampler.yml"); const { mkdirSync, writeFileSync, existsSync } = require("node:fs") as typeof import("node:fs"); if (existsSync(p)) throw new Error(`${p} already exists`); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, SAMPLER_WORKFLOW); process.stdout.write(`wrote ${p}\n`); return; }
    sample({ evalsDir, ifDue: flags.has("--if-due"), size: values.has("--size") ? Number(values.get("--size")) : undefined, clusters: values.has("--clusters") ? Number(values.get("--clusters")) : undefined, since: values.get("--since"), batch: values.get("--batch") })
      .then((r) => { if (flags.has("--json")) { process.stdout.write(JSON.stringify({ ...r, ingest: r.ingest ? { traces: r.ingest.traces, written: r.ingest.written, batchFile: r.ingest.batchFile } : undefined }, null, 2) + "\n"); return; } if (r.skipped) { process.stdout.write(`skipped: ${r.skipped}\n`); return; } process.stdout.write(`${r.fresh} new traces of ${r.pulled} from ${r.source} -> batch ${r.batch} (${r.ingest!.batch && (r.ingest!.coverage as { sampled: number }).sampled} sampled)\n`); for (const w of r.warnings) process.stdout.write(`  warning ${w}\n`); process.stdout.write(`wrote ${r.ingest!.batchFile}\n`); })
      .catch((e: Error) => { process.stderr.write(`sample: ${e.message}\n`); process.exitCode = 1; });
  } catch (e) { process.stderr.write(`sample: ${(e as Error).message}\n`); process.exitCode = 1; }
}

function runGraduate(rest: string[]): number {
  try {
    const { values, flags } = opts(rest, ["--dir", "--runs", "--apply", "--json"]);
    const dir = values.get("--dir") ?? "evals";
    const g = graduationProposals(resolve(dir), { runs: values.has("--runs") ? Number(values.get("--runs")) : undefined });
    if (flags.has("--json")) { process.stdout.write(JSON.stringify(g, null, 2) + "\n"); return 0; }
    process.stdout.write(`${g.proposals.length} task${g.proposals.length === 1 ? "" : "s"} ready to graduate (passed every trial in ${g.runs_considered.join(", ") || "no runs"})\n`);
    for (const p of g.proposals) process.stdout.write(`  ${p.task}  ${p.from} -> ${p.to}  ${p.trials} trials\n`);
    for (const s of g.saturation) process.stdout.write(`  saturation: ${s.suite} is at ${s.pass_rate}%; write harder tasks\n`);
    if (flags.has("--apply") && g.proposals.length) { const r = applyGraduations(new App(dir), g.proposals.map((p) => p.task)); process.stdout.write(`moved ${r.moved.length}: ${r.moved.join(", ")}\n`); for (const x of r.refused) process.stdout.write(`  refused ${x.task}: ${x.message}\n`); process.stdout.write("Pending on the branch; review with git diff or the tray.\n"); }
    return 0;
  } catch (e) { process.stderr.write(`graduate: ${(e as Error).message}\n`); return 1; }
}

function runDoctor(rest: string[]): number {
  try {
    const { values, flags } = opts(rest, ["--dir", "--json", "--plain"]);
    const dir = resolve(values.get("--dir") ?? "evals");
    const d = doctor(dir);
    if (flags.has("--json")) { process.stdout.write(JSON.stringify(d, null, 2) + "\n"); return 0; }
    if (!d.alerts.length) { process.stdout.write(`${d.next}\n`); return 0; }
    for (const a of d.alerts) {
      process.stdout.write(`${String(a.kind).padEnd(16)} ${a.title} ${a.body}\n${"".padEnd(17)}-> ${a.action} (${a.href})\n`);
      const t = flags.has("--plain") ? alertTerm(String(a.kind), String(a.href)) : null;
      const line = t ? plainLines(dir, [t], "".padEnd(17)) : ""; if (line) process.stdout.write(line + "\n");
    }
    process.stdout.write(`\nnext: ${d.next}\n`);
    return 0;
  } catch (e) { process.stderr.write(`doctor: ${(e as Error).message}\n`); return 1; }
}

function runRun(rest: string[]): void {
  const suites: string[] = []; const tasks: string[] = []; const values = new Map<string, string>(); const flags = new Set<string>();
  for (let i = 0; i < rest.length; i++) { const a = rest[i]!; if (a === "--suite") suites.push(rest[++i]!); else if (a === "--task") tasks.push(rest[++i]!); else if (["--dry-run", "--json", "--explain", "--plain"].includes(a)) flags.add(a); else if (a.startsWith("--")) { if (!["--dir", "--trials", "--concurrency", "--id"].includes(a)) { process.stderr.write(`unknown flag ${a}\n`); process.exitCode = 2; return; } values.set(a, rest[++i]!); } }
  const t0 = Date.now();
  run({ evalsDir: resolve(values.get("--dir") ?? "evals"), suites, tasks, trials: values.has("--trials") ? Number(values.get("--trials")) : undefined, concurrency: values.has("--concurrency") ? Number(values.get("--concurrency")) : undefined, runId: values.get("--id"), dryRun: flags.has("--dry-run"),
    onProgress: flags.has("--json") ? undefined : (e) => process.stderr.write(`\r  ${e.done}/${e.total} trials  ${e.task} #${e.n} ${e.result?.infra_error ? "infra:" + e.result.infra_error_kind : e.result?.pass ? "pass" : "fail " + e.result?.failed_checks.join(",")}        `) })
    .then((r) => {
      if (flags.has("--json")) { process.stdout.write(JSON.stringify({ run_id: r.run_id, path: r.path, summary: r.summary, warnings: r.warnings }, null, 2) + "\n"); return; }
      process.stderr.write("\n");
      const s = r.summary as { suites: Record<string, { pass_rate: number; ci: { low: number; high: number }; pass_at_1: number; pass_hat_k: number; k: number; n_tasks: number; infra_errors: number; excluded_judges: string[] }>; infra_error_rate: number; cost_usd: number };
      for (const [name, x] of Object.entries(s.suites)) { process.stdout.write(`${name.padEnd(12)} ${String(x.pass_rate).padStart(5)}%  (${x.ci.low}–${x.ci.high})  pass@1 ${x.pass_at_1}%  pass^${x.k} ${x.pass_hat_k}%  ${x.n_tasks} tasks  ${x.infra_errors} infra${x.excluded_judges.length ? `  excluded: ${x.excluded_judges.join(", ")}` : ""}\n`); if (flags.has("--plain")) { const p = plainLines(resolve(values.get("--dir") ?? "evals"), [{ id: "suite", source: "suite", ctx: { suite: name, run: r.run_id } }]); if (p) process.stdout.write(p + "\n"); } }
      for (const w of r.warnings) process.stdout.write(`  warning ${w}\n`);
      process.stdout.write(`infra errors ${s.infra_error_rate}% · cost $${s.cost_usd} · ${Math.round((Date.now() - t0) / 1000)}s\nwrote ${r.path}; transcripts under ${r.transcripts_dir}\n`);
      if (flags.has("--explain") && !flags.has("--dry-run")) return explainRun({ evalsDir: resolve(values.get("--dir") ?? "evals"), runId: r.run_id }).then((x) => { process.stdout.write("\n"); for (const i of x.items) process.stdout.write(explainText(i) + "\n\n"); if (x.written) process.stdout.write(`wrote ${x.written} explanation${x.written > 1 ? "s" : ""} to ${x.path}\n`); });
    })
    .catch((e: Error) => { process.stderr.write(`run: ${e.message}\n`); process.exitCode = 1; });
}

function runCoverage(rest: string[]): number {
  const values = new Map<string, string>(); const flags = new Set<string>(); const thresholds: string[] = [];
  for (let i = 0; i < rest.length; i++) { const a = rest[i]!; if (a === "--json") flags.add(a); else if (a === "--fail-under") thresholds.push(rest[++i]!); else if (["--dir", "--gaps"].includes(a)) values.set(a, rest[++i]!); else { process.stderr.write(`unknown argument ${a}\n`); return 2; } }
  const c = computeCoverage(resolve(values.get("--dir") ?? "evals"));
  if (flags.has("--json")) process.stdout.write(JSON.stringify(c, null, 2) + "\n");
  else process.stdout.write(coverageText(c, { gaps: values.has("--gaps") ? Number(values.get("--gaps")) : undefined }) + "\n");
  const under = underThresholds(c, thresholds);
  for (const u of under) process.stderr.write(`coverage: ${u}\n`);
  return under.length ? 1 : 0;
}

function runExplain(rest: string[]): number {
  if (rest[0] === "--terms" || (rest[0] && !rest[0].startsWith("--"))) {
    let dir = "evals"; const words: string[] = [];
    for (let i = 0; i < rest.length; i++) { const a = rest[i]!; if (a === "--dir") dir = rest[++i]!; else if (a !== "--terms") words.push(a); }
    if (rest[0] === "--terms") { process.stdout.write(termList(resolve(dir)) + "\n"); return 0; }
    const r = termText(words.join(" "), resolve(dir));
    process.stdout.write(r.text + "\n"); return r.found ? 0 : 1;
  }
  const tasks: string[] = []; const values = new Map<string, string>(); const flags = new Set<string>();
  for (let i = 0; i < rest.length; i++) { const a = rest[i]!; if (a === "--task") tasks.push(rest[++i]!); else if (["--all", "--force", "--no-model", "--json"].includes(a)) flags.add(a); else if (["--dir", "--run", "--concurrency"].includes(a)) values.set(a, rest[++i]!); else { process.stderr.write(`unknown argument ${a}\n`); return 2; } }
  explainRun({ evalsDir: resolve(values.get("--dir") ?? "evals"), runId: values.get("--run"), tasks, all: flags.has("--all"), force: flags.has("--force"), model: !flags.has("--no-model"), concurrency: values.has("--concurrency") ? Number(values.get("--concurrency")) : undefined, onItem: flags.has("--json") ? undefined : (i) => process.stdout.write(explainText(i) + "\n\n") })
    .then((r) => {
      if (flags.has("--json")) { process.stdout.write(JSON.stringify(r, null, 2) + "\n"); return; }
      if (!r.items.length) process.stdout.write(`${r.run_id}: no failed trials to explain.\n`);
      else if (r.written) process.stdout.write(`wrote ${r.written} explanation${r.written > 1 ? "s" : ""} to ${r.path}; review and commit it with the run.\n`);
      if (r.items.some((i) => i.error)) process.exitCode = 1;
    })
    .catch((e: Error) => { process.stderr.write(`explain: ${e.message}\n`); process.exitCode = 1; });
  return 0;
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
  const { values, flags, positional } = opts(rest, ["--dir", "--split", "--force", "--json", "--plain"]);
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
      if (flags.has("--plain")) { const p = plainLines(resolve(values.get("--dir") ?? "evals"), ["tpr", "tnr", r.status === "stale" ? "stale" : "calibration"].map((id) => ({ id, source: "judge", ctx: { judge } })), "  "); if (p) process.stdout.write(p + "\n"); }
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
