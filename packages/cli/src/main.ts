#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateEvals, type Problem } from "./validate.ts";
import { initEvals } from "./init.ts";
import { ingest } from "./ingest.ts";

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

  litmustest validate [path] [--deep] [--json] [--quiet]
      Validate an evals/ directory (default: ./evals) against the schemas and
      the cross-file rules. --deep also runs each task's code, outcome and
      transcript checks against its reference solution. Exit 1 on any error.

  litmustest --version
  litmustest --help

Commands run, compare, calibrate, serve, ci and doctor arrive in later
phases; see docs/SPEC.md.
`;

function main(argv: string[]): number {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === "--help" || cmd === "-h" || cmd === "help") { process.stdout.write(HELP); return 0; }
  if (cmd === "--version" || cmd === "-v") { process.stdout.write(VERSION + "\n"); return 0; }
  if (cmd === "init") return runInit(rest);
  if (cmd === "ingest") return runIngest(rest);
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
    if (["--force", "--json"].includes(a) || next === undefined || next.startsWith("--")) flags.add(a); else { values.set(a, next); i++; }
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

process.exitCode = main(process.argv.slice(2));
