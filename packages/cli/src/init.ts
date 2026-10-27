// litmustest init: scaffold evals/ and detect a JSONL trace source.
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import { stringify as yaml } from "yaml";
import { SchemaSet } from "./schemas.ts";

export interface InitOptions { cwd?: string; dir?: string; project?: string; source?: string; force?: boolean }
export interface InitResult { dir: string; config: string; source?: string; files: string[]; notes: string[] }

export const EVALS_DIRS = ["failure_modes", "tasks", "refs", "graders/code", "graders/judges", "labels", "datasets/traces", "datasets/synthetic", "suites", "runs", "batches"];

/** Look for a *.jsonl file whose first line has id, input and output. */
export function detectJsonlSource(cwd: string): string | undefined {
  const candidates: string[] = [];
  const dirs = [".", "logs", "traces", "data", "logs/traces", "data/traces"];
  for (const d of dirs) {
    const full = join(cwd, d);
    if (!existsSync(full) || !statSync(full).isDirectory()) continue;
    for (const f of readdirSync(full)) if (f.endsWith(".jsonl")) candidates.push(join(full, f));
  }
  for (const f of candidates.sort()) {
    try {
      const first = readFileSync(f, "utf8").split("\n").find((l) => l.trim());
      if (!first) continue;
      const o = JSON.parse(first);
      if (o && typeof o === "object" && "id" in o && "input" in o && "output" in o) return relative(cwd, f).split("\\").join("/");
    } catch { /* not ours */ }
  }
  return undefined;
}

export function initEvals(o: InitOptions = {}): InitResult {
  const cwd = resolve(o.cwd ?? process.cwd());
  const dir = resolve(cwd, o.dir ?? "evals");
  const notes: string[] = []; const files: string[] = [];
  if (existsSync(join(dir, "litmustest.yaml")) && !o.force) throw new Error(`${relative(cwd, dir) || "."}/litmustest.yaml already exists; pass --force to overwrite the config (other files are left alone)`);
  const source = o.source ?? detectJsonlSource(cwd);
  if (source) notes.push(`trace source: ${source} (jsonl)`); else notes.push("no JSONL trace source found; set sources.traces.path in litmustest.yaml, then run litmustest ingest <file>");
  const project = (o.project ?? basename(cwd)).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^[^a-z]+/, "").replace(/_+$/, "") || "project";

  const config = {
    version: 1, project,
    sources: { traces: { format: "jsonl", path: source ?? "logs/traces/*.jsonl" }, sampler: { every: "manual", size: 60, clusters: 8 } },
    runs: { trials: 5, concurrency: 4, environment: "inprocess", resources: { timeout_s: 300 } },
    judges: { default_model: "claude-sonnet-5-5", trust_threshold: 90, stale_on_change: true, correct_for_judge_error: true },
    gates: { regression: { min_pass_rate: 95, max_drop_pts: 2, trusted_judges_only: true }, capability: { report_only: true }, quality: { min_pass_rate: 80, trusted_judges_only: true } },
    storage: { summaries: `${relative(cwd, dir).split("\\").join("/") || "evals"}/runs`, transcripts: { backend: "local", path: ".litmustest/transcripts" } },
    ci: { pr_comment: true },
  };
  const errs = new SchemaSet().check("config", config);
  if (errs.length) throw new Error(`generated config does not validate: ${errs.join("; ")}`);

  mkdirSync(dir, { recursive: true });
  for (const d of EVALS_DIRS) { const p = join(dir, d); mkdirSync(p, { recursive: true }); const keep = join(p, ".gitkeep"); if (!existsSync(keep)) { writeFileSync(keep, ""); files.push(relative(cwd, keep)); } }
  const configPath = join(dir, "litmustest.yaml");
  writeFileSync(configPath, `# litmustest configuration. Schema: docs/SCHEMAS.md#config\n${yaml(config)}`); files.push(relative(cwd, configPath));
  const readme = join(dir, "README.md");
  if (!existsSync(readme)) { writeFileSync(readme, EVALS_README(project)); files.push(relative(cwd, readme)); }
  for (const s of ["regression", "capability", "quality"]) {
    const p = join(dir, "suites", `${s}.yaml`);
    if (!existsSync(p)) { writeFileSync(p, yaml({ name: s, kind: s, description: SUITE_DESC[s], tasks: [] })); files.push(relative(cwd, p)); }
  }
  notes.push("add .litmustest/ to .gitignore: raw transcripts live there, summaries live in git");
  return { dir, config: configPath, source, files: files.map((f) => f.split("\\").join("/")), notes };
}

const SUITE_DESC: Record<string, string> = {
  regression: "Tasks promoted from real failures. Must stay near 100%.",
  capability: "Tasks written from the spec before the agent can pass them. The hill to climb.",
  quality: "Judge-scored tasks. Trusted judges only.",
};

const EVALS_README = (project: string) => `# evals/ for ${project}

This directory is the source of truth for ${project}'s evals. The litmustest CLI, the dashboard and the skills all read and write these files; nothing changes without a reviewable diff.

| Path | What |
| --- | --- |
| \`litmustest.yaml\` | Sources, runs, judges, gates, storage, CI |
| \`failure_modes/\` | One YAML per named way the product goes wrong |
| \`tasks/\` | One YAML per task: input, reference solution, binary checks |
| \`refs/\` | A reference solution per task; it must pass every check |
| \`graders/code/\` | Python functions \`check(trial, args) -> bool\` |
| \`graders/judges/<name>/\` | A judge: prompt.md, judge.yaml, calibration.json (written by \`litmustest calibrate\` only) |
| \`labels/\` | Human labels, append-only JSONL |
| \`datasets/traces/\` | Ingested traces in the internal shape |
| \`batches/\` | Review batches sampled by \`litmustest ingest\` |
| \`suites/\` | regression, capability, quality |
| \`runs/\` | Run summaries, committed; raw transcripts are git-ignored |

Next: \`litmustest ingest <traces.jsonl>\` to normalize traces and sample a review batch, then \`litmustest validate\` after any edit.
`;
