#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateEvals, type Problem } from "./validate.ts";

const VERSION: string = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf8")).version;

const HELP = `litmustest ${VERSION}

Usage:
  litmustest validate [path] [--deep] [--json] [--quiet]
      Validate an evals/ directory (default: ./evals) against the schemas and
      the cross-file rules. --deep also runs each task's code, outcome and
      transcript checks against its reference solution. Exit 1 on any error.

  litmustest --version
  litmustest --help

Commands init, ingest, run, compare, calibrate, serve, ci and doctor arrive
in later phases; see docs/SPEC.md.
`;

function main(argv: string[]): number {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === "--help" || cmd === "-h" || cmd === "help") { process.stdout.write(HELP); return 0; }
  if (cmd === "--version" || cmd === "-v") { process.stdout.write(VERSION + "\n"); return 0; }
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

process.exitCode = main(process.argv.slice(2));
