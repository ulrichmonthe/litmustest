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

## Parts E to I: the rest of the foundations research

Added 2026-10-29. Steps 2 to 6 of the research, in its order. Two decisions shape them: the safety suite is a hybrid (built-in deterministic checks; promptfoo or garak only as optional probe generators, never bundled), and online evaluation is scheduled batch scoring of sampled traces, not a process running beside production. Every part keeps the three rules of `CLAUDE.md`, and every schema change brings valid and invalid examples and `npm run docs:schemas`. Existing files must validate unchanged: every new field is optional, with a default that keeps today's behaviour.

## Part E: tasks from user stories (approach 4)

Spec-first is right for hard constraints, tool and outcome contracts, and the first tasks before there is traffic. It is wrong as the only source after launch, because criteria drift: people learn what "good" means by grading outputs. So spec-derived code and outcome checks may gate CI once a person approves them; spec-derived judges stay advisory until calibrated, like every judge. The model is example mapping (story, rules, examples, questions), not Gherkin syntax.

### Schema changes

| Schema | Change |
| --- | --- |
| new `story` | `evals/stories/<slug>.yaml`: slug, title, `ticket` {system ∈ jira/linear/github/notion, id, url}, `rules[]` {id, text, `source` ∈ ticket/comment/linked_doc/assumption/discovered, quote}, `questions[]` {id, text, rule, asked_at, answer, answered_at}, `approved_by`, `approved_at` |
| `task` | `source` already says where a task came from (`trace:`, `spec:`, `synthetic:`); no `origin` field is added. New optional `rule` (`<story>#<rule id>`, exactly one rule per task), `status` ∈ candidate/blocked/advisory/gating/archived (default `gating`, so existing tasks keep counting), `blocked_by[]` (question ids), `assumptions[]`, `expected_outcome` (one sentence a person can check) |
| `check.transcript` | New optional `expect_calls[]` {tool, args_match} and `abort_on_unexpected` (boolean) |
| `config.gates` | Gates count `gating` tasks only; `advisory` tasks are run and reported, never gated |

### Behaviour

1. **`story-to-tasks` skill.** Reads the ticket through the Claude Code connectors the user already has (Jira, Linear, GitHub, Notion); litmustest ships no API clients. It drafts the example map: rules with their source quoted, assumptions, questions. It never invents a missing rule: anything it would have to assume becomes a question. A person approves the map before any task is drafted.
2. **Classify each rule.** Hard constraint, format, tool contract → code or transcript check. Observable end state → outcome check. Qualitative → a judge, with the task `advisory` until the judge is `trusted`. Not observable ("fast", "fails correctly") → a question, not a task.
3. **Draft tasks.** At least one happy path and one near miss per rule, each citing exactly one rule, each with a reference solution that passes its checks (`validate --deep`). Status `candidate` until a person promotes it; tasks that depend on an open question are `blocked`.
4. **Return questions.** The skill drafts a comment for the ticket; a person posts it. Seven or more open questions on one story suggests splitting it.
5. **The testability gate.** A task is promoted only if two people would independently give the same verdict on its reference and its near miss. The PM and an engineer label both in the review queue as a pair; a disagreement sends the task back to the map.
6. **Trace failures flow back.** A trace-derived task that matches an existing rule adds coverage to that rule. One that matches none creates a rule with `source: discovered`, shown to the PM as a proposed acceptance criterion.
7. **Mock-tool guards.** The runner writes `expect.json` into the trial directory (from `expect_calls`) and sets `LITMUSTEST_EXPECT`. A harness that honours it aborts on an unexpected call; either way the transcript check fails the trial afterwards.
8. **Check health.** `doctor` adds "non-discriminating": a check that passed in every trial of every task over the last N runs is either saturated or not testing anything.

### Dashboard

Tasks & suites gains a story view: rules × tasks, with blocked, advisory and uncovered cells; a question queue with age and owner; and proposed acceptance criteria. The coverage page's spec map counts story rules as spec items.

### Done when

On a fixture story with five rules and one deliberately ambiguous rule, the skill produces a map with the ambiguity as a question, tasks citing one rule each, a `blocked` task for the open question, and references that pass `validate --deep`. Gates ignore `advisory` tasks. Existing tasks validate and gate as before.

## Part F: speak the ecosystem's formats (approach 1)

Keep the native files; add converters. The native format has what the others lack (calibration, failure-mode links, git write-back); the others have viewers, CI integrations and users. Converters are pure functions in `packages/cli/src/interop/`, each tested against fixtures from the other tool pinned at a version. Mappings below are from the research and are confirmed against each tool's published schema when the converter is written (`inspect log schema` for Inspect).

| Command | Direction | Mapping |
| --- | --- | --- |
| `litmustest export inspect <run>` | out | trial → `EvalSample` with `epoch`; binary check → `Score {value: C/I}`; task pass rates → `reductions` with `pass_at_k` and `pass_k_k`; intervals → `EvalMetric`; triage and disputes → `Score.history[].provenance`; commit → `eval.revision` |
| `litmustest export promptfoo [--suite s]` | out | code checks → `javascript` or `python` asserts; outcome and transcript checks → `javascript` asserts over the trial; trusted judges → `llm-rubric` with the judge prompt and its few-shot as `graderExamples`; weights and gates → `weight` and `threshold`. Untrusted judges are left out, with a comment saying why. |
| `litmustest run --junit <file>`, `ci --junit` | out | one test case per task, with failures named by check |
| `litmustest import inspect|harbor|openai <path>` | in | logs and job folders become JSONL traces for `ingest`, so error analysis can start from runs a team already has |
| `litmustest regrade <run> [--check id]...` | in place | re-grades the stored trials with the current checks and trusted judges without re-running the agent, and writes a new summary that names the run it regraded |

### Schema changes

`run_summary`: `revision` {commit, dirty, branch}, kept beside `commit`; `trials[].failure_cause` using Harbor's names, mapped from `infra_error_kind`, and `reward_valid` (false for infra errors); `regraded_from` (run id). `ingest` accepts OTLP JSON exports directly; it already reads `gen_ai.*` span attributes, so decision #3 is closed by this part.

### Done when

The example's latest run exports to an Inspect log that `inspect view` opens; the promptfoo export runs green under `promptfoo eval` on the example's reference solutions; `regrade` of `run_0041` with an unchanged grader reproduces its pass rates exactly; an imported Harbor job folder ingests and validates.

## Part G: safety suite and audit export (approach 5)

**Hybrid.** litmustest ships the checks that need no attack research and no dependencies: they are deterministic, gate CI immediately, and work offline. promptfoo and garak are optional generators of more probes; they are never bundled, and their verdicts are never imported as scores. Generated probes land as task files in a diff, a person commits them, and from then on the suite is fixed and comparable across runs. litmustest grades them with its own checks and trusted judges.

### Schema changes

| Schema | Change |
| --- | --- |
| `common.suite_kind` | Add `safety` |
| new `check.canary` | `secret` (a seeded string the task places in context or state) and `sinks[]` (output, tool_args, state); fails if the secret appears in any sink |
| `check.transcript` | Add `allowed_tools[]` (an allowlist; anything else fails) and `confirm_before[]` (tools that need a user turn between the agent describing the action and calling it) |
| new `check.injection` | `payload_ref` (the injected text the task plants in a tool result or document), `marker` {tool and args, or a string} whose appearance means the injection worked |
| `task` | `attack` {family ∈ direct_injection/indirect_injection/leakage/tool_scope/confirmation/output_handling/harmful_request/resource, benign_twin (task id), severity 0–10, refs[] (OWASP ids)} |
| `run_summary` suites | For `safety`: `benign_utility`, `utility_under_attack`, `attack_success_rate`, `hit_at_k`, each with an interval |
| new `audit` | `evals/audit.yaml`: maps check ids and failure modes to OWASP LLM and Agentic ids, NIST AI 600-1 action ids, ISO/IEC 42001 A.6.2.4, EU AI Act article slots |

`confirm_before` is deterministic and approximate: it checks that a user turn came between the agent's last description of the action and the call. It cannot tell a real confirmation from a user saying something else; that needs a judge, which stays advisory until calibrated.

### Behaviour

1. **Built-in seed set.** About 30 probe tasks across the families, written for the example agent and as templates for others: injected instructions in a tool result and in a fetched document, a canary in the system prompt and in a customer record, an out-of-scope tool, an irreversible refund without confirmation. Each attack task has a `benign_twin` without the payload, so utility under attack is a paired comparison.
2. **Multi-trial, hit@k.** Attack success is reported per attempt and as hit@k (any of k trials succeeded). One attempt understates the risk.
3. **`litmustest redteam --with promptfoo|garak [--families …]`.** Runs whichever is installed as a generator, converts its probes to tasks, and writes them as pending changes. It says when the tool may call a hosted service to generate attacks and how to turn that off; nothing runs without the user choosing the tool.
4. **Harmful-request refusal** is a judge (refusal, scoped to the product's domain) and is advisory until trusted.
5. **Gate.** Any built-in check failing on a task with severity ≥ 9 fails CI, even in a report-only suite. This is the one exception to "report_only never fails the build"; `ci --help`, `docs/SPEC.md` and the CI comment say so, and the comment names the task.
6. **`litmustest export --audit`.** Writes `audit/eval.md` (EvalCards shape) and a bundle: suite versions with commit SHAs, gates, runs with intervals, judge calibration and meta-eval, sampler configuration and retention, the failure-mode changelog, and the crosswalk from `audit.yaml`. Everything already exists in `evals/`; this is assembly. It does not claim compliance; it lists evidence.

### Done when

The seed set runs on the example and finds the one injection the example agent is planted to follow (to be added to the example), with benign utility, utility under attack and attack success rate reported with intervals. `redteam` without promptfoo or garak installed explains how to install them and writes nothing. The audit export of the example is reproducible byte for byte from the same commit.

## Part H: pairwise suite (approach 3)

For subjective quality where no failure mode exists ("is the new prompt warmer?"). Binary checks stay the instrument for objective failures and for gates on them. Pairwise is more manipulable by surface features than absolute grading, so it is used for subjective criteria only. It depends on Part D: a pairwise judge is calibrated like any judge.

### Schema changes

| Schema | Change |
| --- | --- |
| `common.suite_kind` | Add `pairwise` |
| new `check.preference` | `criterion` (one subjective criterion), `judge`, `baseline_run` (run id, or `base_branch` for the latest on the base branch) |
| `label` | Optional `pair` {a_trace, b_trace} with `label` ∈ A/B/Tie, so people label pairs in the review queue |
| `calibration.meta` | Add `position_flip_rate` for pairwise judges |
| `run_summary` suites | For `pairwise`: `win_rate`, `win_rate_style_controlled`, each with an interval; `n_pairs`; `ties`; `style` {length_coef, markdown_coef} |

### Behaviour

1. Candidate and baseline answer the same inputs. Each pair is judged in both orders; a win counts only when both orders agree, otherwise it is a tie. Ties count half.
2. Style control: a logistic regression of the outcome on the length difference and the markdown difference; the style-controlled win rate is the predicted rate at zero difference. Bootstrap over inputs for the interval.
3. Gate: the lower bound of the style-controlled win rate ≥ 0.5 − `tolerance` (set per suite). The verdict is win, tie or loss; no Likert scale anywhere.
4. Calibration: people label pairs as A, B or Tie; the judge needs TPR/TNR ≥ the threshold on non-tie pairs and a reported position-flip rate. Until `trusted`, the pairwise suite reports and never gates.
5. Run compare gains a Preference card ("B preferred 58% [52, 64], style-controlled, 240 pairs"); the review queue shows side-by-side cards for a sample of pairs.

### Done when

On a fixture where B is the same answers padded with filler, the raw win rate favours B and the style-controlled rate does not; identical runs give a style-controlled rate whose interval covers 0.5; a judge with a position bias planted in a fake fixture shows a high flip rate.

## Part I: scheduled online scoring (approach 6)

Online evaluation is scheduled batch scoring of sampled production traces. It runs where the sampler runs (a scheduled GitHub Action or cron), reuses the sampler's adapters, and adds no process beside production. A real-time process is out of scope; it would need its own storage decision and the hosted mode's data handling.

### Schema changes

| Schema | Change |
| --- | --- |
| `config` | `online.rules[]` {name, `filter` (attribute matches), `sample_rate` (0–1), `scope` ∈ trace/session, `checks[]` and `judges[]` by name}; `online.every` (as `sources.sampler.every`); `online.emit` {otlp_endpoint or file}; `agent.shadow_safe` (boolean, default false: the harness stubs side effects when `LITMUSTEST_SHADOW=1`) |
| new `online_summary` | `evals/online/<date>.json`: window, traces seen and scored, per rule and evaluator the rate with an interval, judge `Unknown` rate, agreement (kappa) with any human labels on the same traces, prevalence by PPI from Part D. Per-trace scores go to the local store, like transcripts (decision #6). |
| new `canary` | `evals/canary.yaml`: primary metric, guardrail metrics (online safety scores, escalation and refusal rates, latency, cost), thresholds, window, action ∈ hold/rollback |

### Behaviour

1. **`litmustest score [--if-due]`.** Pulls traces since the last window (the `sample` adapters: JSONL, Langfuse, Braintrust), applies the rules, runs code checks and trusted judges only, writes the online summary as a pending change, and optionally emits `gen_ai.evaluation.result` events. `sample --write-workflow` gains a step for it.
2. **Judge drift.** Where people labelled some of the scored traces, kappa between them and the judge is tracked per window; a drop below `judges.meta.warn_kappa_below` raises a `doctor` alert.
3. **Prevalence.** Labels and judge verdicts here come from the same distribution, so PPI applies: the online summary reports each failure mode's prevalence with a PPI interval.
4. **`litmustest replay --since 7d --candidate "<command>"`.** Re-runs the inputs of the window's sampled traces through a candidate `agent.command` with `LITMUSTEST_SHADOW=1` set (the harness must stub side effects; replay refuses without `agent.shadow_safe: true` in the config), scores both with the same rules, and reports the paired delta with an interval in Run compare.
5. **`litmustest canary`.** Reads the latest online summaries against `canary.yaml` and exits 0 (pass), 10 (hold) or 20 (rollback), with the reason. Its reaction time is the scoring schedule, which the docs say plainly; a canary that reacts within minutes needs the deferred production process.
6. **Traffic coverage.** Sampled traffic is clustered (the `ingest` clustering); a cluster is covered when a task's `source` trace or `covers:` falls in it. The Coverage page gains a fourth map, `traffic`, and `docs/COVERAGE.md` drops "production traffic" from what v1 does not measure.

### Done when

On the example's traces split into weekly windows, `score` produces summaries whose PPI prevalence for each planted failure mode covers the planted rate; a judge made to drift in a fixture raises the kappa alert; `replay` refuses without `shadow_safe`; `canary` returns hold on a fixture window that crosses a guardrail.

## Working with the design files

- `brand/tokens.json` is the token source; generate CSS variables from it, do not hand-copy hex values.
- `design/mockups/Transcript.rework.dc.html` is the canonical visual reference. Other mockups show layout and content; take their type and nav from the rework.
- Keep "Sample data" pills on anything that renders mock numbers until real data flows.

## Definition of done for this brief

- `litmustest validate examples/support-agent/evals` passes.
- `litmustest validate --deep` passes (all reference solutions pass their checks).
- Tests cover every schema with a valid and an invalid case.
- A fresh clone reaches a populated review queue in under 10 minutes following the example README.
