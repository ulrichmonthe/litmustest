# First brief for Claude Code: schemas and the sample repo

As of 2026-10-27. These two pieces unblock everything else and depend on no open decision except #3 (trace format), where the recommendation is good enough to start with.

Work in phases, one PR each. Do not start the dashboard until the schemas and the sample repo exist; the review queue has nothing to show without them.

## Part A: the schemas

Write a JSON Schema (draft 2020-12) for each file type under `evals/`, plus a validator CLI (`litmustest validate [path]`) and a test suite that validates every example file. Keep the schemas in `schemas/` at the repo root and version them (`$id` with a version segment).

| Schema | File | Must capture |
| --- | --- | --- |
| `config` | `evals/litmustest.yaml` | sources (format, path, sampler), runs (trials, concurrency, budget_usd, environment, resources), judges (default_model, trust_threshold, stale_on_change, correct_for_judge_error), gates per suite (min_pass_rate, max_drop_pts, report_only, trusted_judges_only), storage (summaries, transcripts), ci (pr_comment) |
| `failure_mode` | `evals/failure_modes/<name>.yaml` | name (snake_case), definition, severity (high/med/low), owner, examples (trace ids), created, retired |
| `task` | `evals/tasks/**/<id>.yaml` | id, suite, source (`trace:<id>` or `spec:<slug>` or `synthetic:<slug>`), input (free object), reference_solution (path), trials, checks[] (id, type ∈ code/judge/outcome/transcript, weight, type-specific fields), report[] |
| `check.code` | inline in task | fn (path), args |
| `check.judge` | inline in task | failure_mode, judge (defaults to failure_mode name), inputs |
| `check.outcome` | inline in task | expect (dotted path → value), backend (sql/fs/http/page) |
| `check.transcript` | inline in task | max_turns, max_toolcalls, required_tools, forbidden_tools; flagged `path_check: true` |
| `judge` | `graders/judges/<name>/judge.yaml` | id, failure_mode, model (pinned id), inputs[], output schema (critique, result ∈ Pass/Fail/Unknown), few_shot[] (trace ids from train split), prompt (path), prompt_hash |
| `calibration` | `graders/judges/<name>/calibration.json` | prompt_hash, model, splits (train/dev/test trace-id lists + hashes), dev {tpr, tnr, matrix, runs[]}, test {tpr, tnr, matrix, ran_at} or null, status ∈ untested/dev/trusted/stale, stale_reason |
| `label` | `labels/<batch>.jsonl` (one object per line) | trace_id, failure_mode (or `overall`), label ∈ Pass/Fail/Skip, note, annotator, at, rubric_version; append-only |
| `suite` | `evals/suites/<name>.yaml` | name, kind ∈ regression/capability/quality, tasks[] or include globs, gate (optional override), graduated_from (optional) |
| `run_summary` | `evals/runs/<run-id>.json` | run_id, commit, started_at, config_hash, per suite {pass_rate, ci, pass_at_1, pass_hat_k, n_tasks}, per task {strict_pass, weighted, trials[] (pass, failed_checks, infra_error, tokens, latency_ms, cost_usd), transcript_ref}, infra_error_rate, cost_usd, judge_corrections[] |
| `trace` (internal) | `datasets/traces/<id>.json` | OpenTelemetry GenAI span shape, plus a derived `turns[]` view that is computed, not stored |
| `trace.jsonl_adapter` | input only | id, input, output, optional messages[], tool_calls[]; warnings for unfilled fields |

Rules the validator enforces beyond shape:
- Every `failure_mode` referenced by a check exists.
- Every judge check's judge has a `calibration.json`; status `trusted` is required for the check to count in a gate.
- No trace id in `judge.few_shot` appears in `calibration.splits.dev` or `.test` (leakage).
- A task's `reference_solution` exists; `litmustest validate --deep` runs the task's checks against it and fails if any fail.
- Names match `^[a-z][a-z0-9_]*$`.

Deliver: `schemas/*.json`, `litmustest validate`, `tests/schemas/` with one valid and one invalid example per schema, and `docs/SCHEMAS.md` generated from the schema descriptions.

## Part B: the sample repo

A small but real target to build and test against, at `examples/support-agent/`.

1. **The agent.** A support agent for a subscription product with five tools: `verify_identity`, `fetch_invoices`, `fetch_policy`, `process_refund`, `send_confirmation`. One prompt file. Backed by a SQLite database (`accounts`, `invoices`, `refunds`, `tickets`, `audit`) that is copied fresh per trial. A simulated-user mode that plays a persona (frustrated, business, first-time) for multi-turn tasks.
2. **Traces.** A generator that produces 300 traces in the internal shape, with planted failures at known rates: tone_mismatch ~12%, missed_refund ~8%, ungrounded_policy ~6%, over_searching ~4%, wrong_tool_args ~2%, identity_leak ~1%. Store the planted truth separately so calibration numbers can be checked against it.
3. **Seed evals.** Enough `evals/` content to exercise every schema: 7 failure modes, ~40 tasks across three suites (including one deliberately broken task and one deliberately flaky one), 2 code checks, 2 judges (one trusted, one stale), 100 labels, a reference solution per task, and two run summaries so `compare` has something to compare.
4. **Environments.** A per-trial reset for the SQLite database; a Harbor task definition for the same agent so the runner decision (#2) can be evaluated with a real example.

Deliver: `examples/support-agent/` with a README that gets a new user from clone to `litmustest serve` with the review queue populated in under 10 minutes.

## Part C (after A and B): Phase 1 proper

In this order, each as its own PR reviewed against `ACCEPTANCE.md`:
1. `litmustest init` and `ingest` (JSONL adapter, clustering, batch sampling).
2. Local server: file watcher, validation on write, branch write-back, Pending changes API.
3. Review queue (keyboard-first) and labels.
4. `error-discovery` skill rewritten to write failure-mode files as a proposed diff.
5. Failure modes view and read-only Overview.

## Working with the design files

- `brand/tokens.json` is the token source; generate CSS variables from it, do not hand-copy hex values.
- `design/mockups/Transcript.rework.dc.html` is the canonical visual reference. Other mockups show layout and content; take their type and nav from the rework.
- Keep "Sample data" pills on anything that renders mock numbers until real data flows.

## Definition of done for this brief

- `litmustest validate examples/support-agent/evals` passes.
- `litmustest validate --deep` passes (all reference solutions pass their checks).
- Tests cover every schema with a valid and an invalid case.
- A fresh clone reaches a populated review queue in under 10 minutes following the example README.
