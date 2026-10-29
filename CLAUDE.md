# litmustest

A plugin for coding agents that takes a team from raw AI-product traces to a trusted, CI-gated eval suite, with a local dashboard that edits the eval files in git.

It reconciles two sources: the evals-skills course method (error analysis → binary judges → calibration) and Anthropic's agent-eval guidance (tasks, outcomes, trials, suites, error bars). Read `docs/SPEC.md` first. Everything else in `docs/` supports it.

## The three rules everything depends on

1. **`evals/` in git is the source of truth.** The dashboard, the CLI and the skills all read and write the same files. No separate database. Nothing changes a grader, label, task or gate without a reviewable diff.
2. **Agents propose; people decide.** Every edit a skill makes arrives as a diff on a branch. A person commits it. Reading traces and labeling calibration data are human-only and are never automated.
3. **No judge counts until it is calibrated.** A judge needs TPR and TNR ≥ 90% on a held-out test set, run once. Editing its prompt or model marks it stale, and stale verdicts are excluded from scores and gates.

## Reconciled method (one line each)

- The unit of work is a **task**: input, checks, reference solution, suite. Failure modes are tags on checks.
- Every **check is binary**. A task reports both strict pass (all checks) and a weighted score.
- **Code checks before judges.** Outcome checks (real end state) for agents that change things.
- **Judges**: one failure mode each, Pass/Fail/Unknown, few-shot from the train split only, critique before verdict.
- **Trials**: 5 per task by default; report pass@1 and pass^k; tag infra failures separately.
- **Every number carries error bars**: bootstrap over tasks and judge confusion together; paired comparisons between runs.
- **Suites**: regression (near 100%), capability (hill to climb), quality (trusted judges only). Saturated capability tasks graduate to regression.

## Repo layout

```
.claude-plugin/marketplace.json  # the marketplace: points at plugin/
plugin/                   # the plugin: .claude-plugin/plugin.json (name litmustest), skills/<name>/SKILL.md; .codex-plugin ships untested
                          # modified upstream skills carry the Apache 2.0 attribution comment
schemas/                  # JSON Schema 2020-12 for every file under evals/; $id versioned under /v1/
packages/cli/             # the `litmustest` npm package (TypeScript, Node >= 22); schemas copied in at publish
examples/support-agent/   # the sample repo: agent, trace generator, seed evals, Harbor task (Part B)
tests/                    # vitest: schemas/examples/<schema>/{valid,invalid}.*, fixtures/{good,bad}/evals
scripts/gen-schema-docs.ts  # writes docs/SCHEMAS.md from the schema descriptions
scripts/gen-tokens-css.ts   # writes packages/cli/ui/tokens.css from brand/tokens.json
packages/cli/ui/          # the dashboard: static HTML, CSS and one ES module, no build step; served by `litmustest serve`
packages/cli/src/server/  # app (routes and validated writes), pending (the tray), overview (read models), judges, discover_route
packages/cli/src/{stats,judge_run,calibrate,draft}.ts  # error bars and judge-error correction; running a judge; the calibration workflow; drafting graders
packages/cli/src/{run,compare,ci}.ts  # the runner (agent.command per trial, grading, summaries); paired comparison and gates; the CI entry
packages/cli/src/{coverage,coverage_cli}.ts, server/coverage_route.ts  # coverage v1: spec, surface and risk maps with depth; docs/COVERAGE.md says what it does not measure
packages/cli/src/{explain,explain_run}.ts  # why a trial failed: a template from the data (no model) and Claude's reading, stored as trials[n].explanation; advice only, never a verdict
packages/cli/src/{sample,graduate}.ts, adapters/platforms.ts  # the production sampler; graduation, saturation and doctor; Langfuse and Braintrust pull adapters
docs/, brand/, design/    # spec, decisions, brand book, tokens, logos, mockups
```

A user's `evals/` directory (what the CLI, server and skills read and write):

```
evals/
  litmustest.yaml         # sources, runs, judges, gates, storage, ci
  failure_modes/*.yaml
  tasks/**/*.yaml
  refs/<task id>.json     # reference solution per task; must pass every check
  graders/code/*.py       # check(trial: dict, args: dict) -> bool
  graders/judges/<name>/{prompt.md,judge.yaml,calibration.json}
  labels/*.jsonl          # trace_id, label, note, annotator, timestamp; append-only
  datasets/{traces,synthetic}/
  batches/<name>.yaml      # review batches sampled by `litmustest ingest`
  suites/{regression,capability,quality}.yaml
  runs/                   # summaries committed; raw transcripts git-ignored
```

`npm test` runs everything; `npm run build` compiles the CLI; `npm run docs:schemas` regenerates `docs/SCHEMAS.md` and `npm run docs:tokens` regenerates `packages/cli/ui/tokens.css` (never edit either by hand); `npm run validate -- <evals dir> [--deep]` runs the validator from source; `node packages/cli/dist/main.js serve --dir <evals dir>` starts the local server and dashboard on http://127.0.0.1:4242.

## Conventions

- Plain text files, JSON Schema for every file type (`docs/SCHEMAS.md`). Validate on every write. Add a valid and an invalid example under `tests/schemas/examples/` with every schema change.
- Trace shape: OpenTelemetry GenAI conventions internally; a JSONL adapter for plain logs; Langfuse and Braintrust pull adapters map to the JSONL shape first. Labels reference trace ids, never positions.
- A change that spans files (a graduation moves a task and edits two suite lists) goes through `App.putFiles`, which validates once and reverts all together.
- Pin judge model ids to one exact id (`claude-opus-5-5`, or a dated snapshot where the provider issues them). Never a floating alias such as `-latest`; calibration records the id it measured and a change marks the judge stale.
- Identifiers are `snake_case` and are what the dashboard shows in mono.
- Target Claude Code first; keep the Codex manifest the fork ships, marked untested (DECISIONS.md #5).
- License: Apache 2.0. Modified upstream skills carry a "Modified from ai-evals-course/evals-skills (Apache 2.0)" header.

## Where things are

| Need | File |
| --- | --- |
| Full spec, architecture, build phases | `docs/SPEC.md` |
| The six decisions with recommendations | `docs/DECISIONS.md` |
| What each screen does and the write-back model | `docs/SCREENS.md`, `design/mockups/*.dc.html` |
| Colours, type, spacing, voice, component rules | `docs/BRAND.md`, `brand/tokens.json`, `brand/logos/` |
| What "done" means per phase | `docs/ACCEPTANCE.md` |
| What coverage measures, and what v1 does not | `docs/COVERAGE.md` |
| Phase 1 brief: schemas and sample repo | `docs/FIRST-BRIEF.md` |
| How we compare with the two sources | `docs/COMPARISON.md` |

## Working agreement for this repo

- One PR per phase milestone. Each PR is reviewed against `docs/ACCEPTANCE.md` before merge.
- A skill writes files under `evals/` and stops; the Pending changes tray shows every uncommitted change there, and a person commits. `litmustest discover` is the model-backed step of error discovery; it proposes and writes only with `--apply`.
- The runner's contract: `agent.command` runs once per trial in a fresh directory and must leave `trial.json` in the reference-solution shape, including the end state in `state` (the agent's own script snapshots it; the runner reads only `trial.json`). Only trusted judges count; infra failures are excluded and reported.
- Judges: one failure mode each, few-shot from the train split only, critique before verdict, Unknown allowed. `litmustest calibrate` is the only writer of `calibration.json`, with one exception below. A judge counts in gates only while `status: trusted`.
- Never hand-edit `calibration.json`; it is written by `litmustest calibrate` only. The one exception is the server marking a trusted calibration `stale` when the judge's prompt or model changes; the API refuses direct writes to it.
- The dashboard is a client of the CLI and the files. If something works in the dashboard but not the CLI, that is a bug.
- Mockups in `design/mockups/` are the UI reference. Replicate their values from inline styles and `brand/tokens.json`; do not copy the markup wholesale. In `packages/cli/ui/` every colour, radius and spacing is a `var(--token)` from the generated `tokens.css`; no hex values in `app.css`.
