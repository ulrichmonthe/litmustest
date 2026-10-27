# litmustest

A plugin for coding agents that takes a team from raw AI-product traces to a trusted, CI-gated eval suite, with a local dashboard that edits the eval files in git.

It reconciles two sources: the evals-skills course method (error analysis, binary judges, calibration) and Anthropic's agent-eval guidance (tasks, outcomes, trials, suites, error bars). Every number carries its margin of error. Every edit an agent makes lands as a reviewable diff. No judge counts until it is calibrated.

Install name is `litmustest`, no hyphen. The `litmus-test` packages on npm and PyPI are unrelated projects.

## Status

Pre-release. Phase 1 (schemas and validator) is in progress. Nothing is published yet.

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
| `packages/cli/` | The `litmustest` CLI |

## Development

```bash
npm install
npm test
npm run build
node packages/cli/dist/main.js validate examples/support-agent/evals
```

## License

Apache 2.0. Built on the evals-skills course method (ai-evals-course/evals-skills, Apache 2.0) and Anthropic's agent-eval guidance. Modified upstream skills carry a "Modified from ai-evals-course/evals-skills (Apache 2.0)" header.
