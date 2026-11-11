# litmustest

A plugin for coding agents that takes a team from raw AI-product traces to a trusted, CI-gated eval suite, with a local dashboard that edits the eval files in git.

It reconciles two sources: the evals-skills course method (error analysis, binary judges, calibration) and Anthropic's agent-eval guidance (tasks, outcomes, trials, suites, error bars). Every number carries its margin of error. Every edit an agent makes lands as a reviewable diff. No judge counts until it is calibrated.

Install name is `litmustest`, no hyphen. The `litmus-test` packages on npm and PyPI are unrelated projects.

## Status

Pre-release. Phases 1 to 3 are complete and Phase 4 is in progress (hosted mode is not started). Nothing is published to npm yet.

## What is here

| Path | What |
| --- | --- |
| `CLAUDE.md` | Project rules and the map of this repo |
| `docs/SPEC.md` | What we are building, the reconciled method, architecture, phases |
| `docs/DECISIONS.md` | The six decisions and their outcomes |
| `docs/FIRST-BRIEF.md` | Phase 1 brief: schemas, validator, sample repo |
| `docs/ACCEPTANCE.md` | What "done" means per phase |
| `docs/SCREENS.md`, `design/mockups/` | The eight dashboard screens |
| `docs/BRAND.md`, `brand/` | Brand book, design tokens, logos |
| `schemas/` | JSON Schema (draft 2020-12) for every file under `evals/` |
| `packages/cli/` | The `litmustest` CLI, server and dashboard |
| `plugin/` | The Claude Code plugin: manifest and skills (`error-discovery` so far) |

## Install the plugin

```bash
claude plugin marketplace add ulrichmonthe/litmustest
claude plugin install litmustest
```

The skills call the `litmustest` CLI, installed separately: `npm install -g litmustest` once it is published. Codex manifests ship but are untested until Phase 2.

## Commands

| Command | Does |
| --- | --- |
| `litmustest init` | Scaffolds `evals/`, detects a JSONL trace source |
| `litmustest ingest <file>` | Normalizes traces, clusters, samples a review batch |
| `litmustest serve` | The dashboard: review queue, failure modes, judges, overview, run compare, transcripts |
| `litmustest discover` | Groups reviewers' notes into failure-mode files, as a diff |
| `litmustest draft-judge` / `draft-check` | Drafts a judge or a code check from labels |
| `litmustest calibrate <judge>` | Dev runs, then the held-out test once; TPR/TNR with intervals |
| `litmustest run` | k trials per task, graded, with error bars; infra failures excluded |
| `litmustest coverage` | How much of the application the evals cover: spec cases, API routes or tools, and failure modes, each guarded, checked, planned or none (v1 scope in docs/COVERAGE.md) |
| `litmustest explain` | Plain-language reasons for failed trials: what was tested, which step went wrong, what kind of failure, what would make it pass; Claude's reading is saved in the run summary |
| `litmustest compare A B` | Paired deltas, flips, failure-mode and cost deltas |
| `litmustest ci` | Gated suites, PR comment, non-zero on a crossed gate |
| `litmustest sample` | The production sampler: new traces since the last batch, on a schedule |
| `litmustest graduate` | Capability tasks that passed every trial for 3 runs move to regression |
| `litmustest doctor` | Eval health and the next step |
| `litmustest validate` | Every file against its schema and the cross-file rules |

## Development

```bash
npm install
npm test
npm run build
node packages/cli/dist/main.js validate examples/support-agent/evals
```

## License

Apache 2.0. Built on the evals-skills course method (ai-evals-course/evals-skills, Apache 2.0) and Anthropic's agent-eval guidance. Modified upstream skills carry a "Modified from ai-evals-course/evals-skills (Apache 2.0)" header.
