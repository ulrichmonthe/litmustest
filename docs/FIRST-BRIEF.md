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

## Part D: validate the validators

Added 2026-10-29. Step 1 of the foundations research ("litmustest: Foundations Research", approach 2 and the two cross-cutting changes). TPR and TNR ≥ 90% say a judge agrees with people; they do not say it is unbiased, stable or measured at the right size. Part D adds the checks that do, without changing what makes a judge trusted. One PR per numbered step below, each reviewed against `ACCEPTANCE.md`.

### Two rules Part D must not break

The research proposes two things that would break existing rules. They are adopted in a changed form:

1. **The test split is still run once per prompt and model.** The research says to re-run the held-out set on every judge edit and list the flips. Doing that on the test split turns it into a tuning set. Flips are computed on the **dev** split on every edit (`calibrate --split dev`, free to repeat); the test split shows its flips only when it is run, once, for the new version. `calibrate.ts` already refuses a second test run for the same prompt and model; that refusal stays.
2. **Run scores keep Rogan-Gladen.** The research proposes prediction-powered inference (PPI) as the default correction. PPI is only unbiased when the human labels and the judged items share a distribution. Calibration labels are on production traces; `litmustest run` judges task trials, which are a different distribution. That is the case where Rogan-Gladen stays unbiased and PPI may not. So `passRateWithJudgeError` keeps Rogan-Gladen, and PPI ships for the one place where the distributions match: estimating how often a failure mode occurs across ingested traces, where people labelled a sample of the same traces the judge scores.

Rule 3 of `CLAUDE.md` is unchanged: `status: trusted` still means TPR and TNR ≥ the threshold on a test split run once. The new measures are reported beside it and raise warnings; none of them makes an untrusted judge count. A per-judge threshold may be set higher than `judges.trust_threshold`, never lower.

### Schema changes

Each change needs a valid and an invalid example under `tests/schemas/examples/` and `npm run docs:schemas`.

| Schema | Change | Why |
| --- | --- | --- |
| `common.label_value` | Add `Ambiguous` beside `Pass`, `Fail`, `Skip` | `Skip` means "I could not judge this". `Ambiguous` means "reasonable people would disagree". Forcing one label picks worse judges (Guerdan et al.). Both leave the TPR/TNR counts; `Ambiguous` also counts toward the failure mode's ambiguity rate. |
| `failure_mode` | Add `version` (integer, starts at 1, bumped when `definition` changes) and `history[]` (version, definition, changed_at, changed_by) | `label.rubric_version` already records the definition version the reviewer was reading, but nothing defines that version today. |
| `task` | Add optional `cluster` (snake_case; defaults to the task id) | Tasks made from one scenario in three personas (`duplicate_charge_business`, `_first_time`, `_frustrated`) are not independent. Intervals resample clusters, not tasks. |
| `judge` | Add optional `trust_threshold` {tpr, tnr}, each ≥ the config threshold | Per-judge thresholds, as EvalGen recommends; never below the rule-3 floor. |
| `calibration.dev.runs[]` | Add `verdicts` {trace_id → Pass/Fail/Unknown} | Needed to list the flips between two dev runs. |
| `calibration` | Add `meta` {kappa, kappa_ci, retest {runs, self_agreement, flip_rate}, probes {verbosity, polished_wrong} each {n, flipped, examples[]}, same_family, coverage, ambiguity_rate, measured_at, prompt_hash} | The meta-eval panel. `prompt_hash` ties it to the version measured; a prompt change makes it stale like the rest. |
| `calibration.test` | Add `flips[]` (trace_id, before, after, critique_before, critique_after) against the previous test run, when there was one | The rubric diff for the one run that counts. |
| `run_summary` suites | Add `mde_pts` (minimum detectable drop at 80% power), `clusters` (n), `ci_method` (`bootstrap_tasks` or `bootstrap_clusters`) | Every delta says what size of change it could have seen. |
| `config.judges` | Add `meta` {retest_runs (default 3), probes (default true), warn_kappa_below (default 0.6)} | Cost control: each retest run is one more pass over the dev split. |

### Statistics (`stats.ts`)

- `cohenKappa(pairs)` with a bootstrap interval, using the same pairs as `matrixOf`. `Unknown`, `Skip` and `Ambiguous` are left out and counted.
- `ppiPrevalence({ judged, labelled })`: the PPI++ estimate of a failure rate from judge verdicts on all traces plus human labels on a sample, with its interval. First consumer: the failure-mode prevalence on the Failure modes page, which today counts human Fail labels only.
- `mdePairedPts(diffs, alpha = 0.05, power = 0.8)`: (z₁₋α/₂ + z_power) × sd(diffs) / √n, in points. Shown by `compare`, `ci` and Run compare next to every delta and gate: "this gate can see drops of 6 pts or more".
- `pairedDelta` and `passRateWithJudgeError` take an optional cluster key and resample clusters. With no `cluster` fields set, results are unchanged (each task is its own cluster), so existing summaries and tests stay valid.

### Calibration (`calibrate.ts`, `judge_run.ts`)

1. **Kappa** on every dev and test run.
2. **Test-retest**: `calibrate --split dev --retest N` runs the dev split N more times. `self_agreement` is the share of traces with the same verdict every time; `flip_rate` is its complement. Judges run at `temperature` 0 where the model allows; retest measures what remains.
3. **Probes**, built from human-labelled dev traces by transforms that keep the label by construction:
   - *verbosity*: pad the final answer with relevant-sounding but empty text. The verdict should not change.
   - *polished but wrong*: rewrite a human-Fail answer to read better while keeping the fault. Because the rewrite could remove the fault, every polished probe is shown to a person in the review queue as a probe card before it counts. People confirm; the agent only drafts. Probes are stored under `graders/judges/<name>/probes/` and never enter `few_shot` or the splits.
4. **Same-family warning**: when the judge model and the agent model (from the trace's `gen_ai.request.model`) come from one vendor family, the panel says so. A cross-family second judge is out of scope here.
5. **Calibrated Unknown**: `--variants K` asks the judge K prompt variants (few-shot order shuffled) and uses their agreement as confidence. `calibrate` picks the lowest abstain threshold at which judged dev traces still meet the trust threshold, and records `coverage`, the share not abstained. Below the threshold the verdict is `Unknown` and goes to the review queue, as today.
6. **Flips**: each dev run stores its verdicts; the Judges page lists traces whose verdict changed since the previous dev run, with both critiques. The test split's `flips[]` is written by the one test run.

### Judge prompt template (`draft.ts`, `write-judge-prompt` skill)

Critique is anchored, not free-form: for each criterion in the definition, quote the evidence from the trace, then say whether it is met, then give the verdict. Open-ended reasoning admires polish (LLMBar). One added rule for trajectory judges: the agent's own claim of success is never evidence. `parseVerdict` and the output schema (`critique`, `result`) do not change; the anchoring lives in the prompt.

### Review queue and failure modes

- **`Ambiguous`** gets its own key and button beside Pass, Fail and Skip, with a required note.
- **Editing a definition mid-session** bumps its `version`. Labels made under an older version are shown as "labelled under v2" and offered for re-review in the same batch, never relabelled automatically.
- **Drift flag**: a failure mode whose labels were revised (a later label for the same trace and mode, append-only) more than 15% of the time, or whose ambiguity rate is above 15%, is flagged on the Failure modes page and by `doctor` as "definition needs sharpening".

### Dashboard

- **Judges page**, a meta-eval panel beside the stepper: kappa with its interval, self-agreement, probe results with an example each, coverage, same-family warning. Each number links to the traces behind it.
- **Judge page**, a "Changed since last run" list of flips with the before and after critique.
- **Run compare and the CI comment**: the MDE next to each delta, and "intervals over 14 clusters" when clusters are in use.

### What Part D does not do

PPI for run scores (see above); a cross-family judge panel; pairwise judging (approach 3); online scoring of production (approach 6); any change that lets a judge count without `status: trusted`.

### Order

1. Schemas, `cohenKappa`, `mdePairedPts`, clustered bootstrap, `Ambiguous`, failure-mode versions. No model calls; everything testable offline.
2. Calibration: kappa, retest, verdicts per dev run, flips, `--variants` and coverage.
3. Probes, including the probe card in the review queue.
4. `ppiPrevalence` on the Failure modes page; drift flag in `doctor`.
5. Dashboard panels and the template change in `draft.ts` and the `write-judge-prompt` skill.

### Done when

- `npm test` passes with tests for every new statistic against known values (kappa on a textbook table; MDE against a closed form; PPI against a simulated population with a known rate, its interval covering the truth at about the nominal rate).
- On `examples/support-agent`, whose planted failure rates are known, `ppiPrevalence` for `tone_mismatch` lands within its interval of the planted ~12%, and with the same labels its interval is narrower than the one from counting human labels alone.
- A judge edit shows its dev flips on the Judge page and leaves the test split untouched until it is run once.
- Labels made before a definition change show their version, and `doctor` flags a drifting mode in a fixture built to drift.
- `validate --deep` passes on the example, and existing run summaries validate unchanged.

## Working with the design files

- `brand/tokens.json` is the token source; generate CSS variables from it, do not hand-copy hex values.
- `design/mockups/Transcript.rework.dc.html` is the canonical visual reference. Other mockups show layout and content; take their type and nav from the rework.
- Keep "Sample data" pills on anything that renders mock numbers until real data flows.

## Definition of done for this brief

- `litmustest validate examples/support-agent/evals` passes.
- `litmustest validate --deep` passes (all reference solutions pass their checks).
- Tests cover every schema with a valid and an invalid case.
- A fresh clone reaches a populated review queue in under 10 minutes following the example README.
