# Acceptance criteria

As of 2026-10-27. Derived from the 25-chapter "litmustest Master Class" guide, which describes what a user can do at each step. Each phase is done when every line in its list is true against the sample repo, and the matching guide chapters are accurate without edits.

## Phase 1: Discover

- [x] `litmustest init` creates `evals/` with `litmustest.yaml`, empty folders and a README, and detects a JSONL trace source.
- [x] `litmustest ingest traces.jsonl` normalizes to the internal trace shape, clusters, and writes a review batch (cluster reps + random) with a coverage report. (Clustering is TF-IDF + k-means, offline; no model call.)
- [x] `litmustest serve` opens the dashboard; Review queue shows the batch.
- [x] In the Review queue: j/k move, p/f label, n focuses the note, Enter saves and advances. A label is appended to `labels/*.jsonl` with annotator and timestamp within one second. (Also `s` for Skip; Cmd/Ctrl+Enter saves from inside the note.)
- [x] Tool calls render between messages; an expected-but-missing tool call can be flagged by the renderer when a task specifies it. (A task whose `source` is `trace:<id>` lends its `required_tools`; the renderer shows a hollow red step marked Never called.)
- [x] "Ask Claude to regroup notes" runs `error-discovery` and returns proposed failure-mode files as a diff in the Pending changes tray; nothing is written until accepted. (`POST /api/discover` proposes; Accept writes through the validated save path; `litmustest discover [--apply]` is the same from the CLI and the skill.)
- [x] Failure modes view lists modes with count, severity, grader status; definition and severity edit and save to files. (Plus owner, merge into, retire and new mode; saves carry the loaded hash and show the per-field save state with Reload / Keep mine on a conflict.)
- [x] Overview (read-only) shows a failure-mode Pareto and the review coverage. (Also the verdict strip, suite scorecards with CI and paired deltas, needs-attention alerts, judge trust and the flip list, all from the files.)
- [x] Every file written validates against its JSON Schema; an invalid write is refused with the field named. (Server: 422 with the failing field; a write that breaks a cross-file rule is reverted and refused the same way; a stale base hash is a 409 with reload / keep mine.)
- [ ] A domain expert who has read guide chapters 3, 6 and 7 can label 50 traces in under an hour without asking an engineer anything.

## Phase 2: Grade and trust

- [x] "Draft code check" produces a function in `graders/code/` and a test against labeled traces; it lands as a diff. (`litmustest draft-check`, or the button on the Judges page; a fixture of labelled trials is written under `graders/code/fixtures/` and the test's agreement is reported.)
- [x] "Draft judge from labels" produces `prompt.md` and `judge.yaml` with one failure mode, Pass/Fail definitions, 3 examples from the train split, structured output with critique first and an Unknown option. (`litmustest draft-judge`; also writes `calibration.json` with the splits, status untested.)
- [x] The judge editor shows per-field save states (saved, saved to branch, conflict) and refuses to overwrite a file changed on disk.
- [x] `litmustest calibrate <judge>` splits labels 15/45/40, runs dev, writes TPR/TNR and the confusion matrix to `calibration.json`, and lists disagreements. (Stratified, deterministic splits; the test split is locked once drawn; bootstrap intervals on TPR and TNR.)
- [x] "Run test set once" is disabled until dev TPR and TNR ≥ 90%; after it runs, any prompt or model change marks the judge stale.
- [x] Stale judges are excluded from every score and gate, and shown with a stale pill. (Validator, Overview and Judges show it; the runner in Phase 3 enforces the exclusion when it scores.)
- [x] Reported pass rates for judge-scored checks are corrected for judge error with a bootstrap CI. (One bootstrap over tasks and the suite's main judge's confusion matrix.)
- [x] A task cannot join a suite without a reference solution that passes all its checks. (`validate --deep` for code, outcome and transcript checks; `run --dry-run` grades the references with the judges too.)
- [x] Commit to branch / Open PR / Discard work from the Pending changes tray; the branch name follows `evals/<slug>`. (API: `/api/pending`, `/commit`, `/pr`, `/discard`. The tray UI lands with the dashboard.)

## Phase 3: Run like an agent eval

- [x] `litmustest run --suite regression --trials 5` runs each task in a clean environment per trial, grades, and writes a run summary to `evals/runs/`; raw transcripts go to the configured store. (A fresh trial directory per trial; `agent.command` in the config is the contract; `runs.environment` other than inprocess waits on decision #2.)
- [x] Infra failures (timeouts, OOM, harness errors) are tagged and excluded from the agent's score; their rate is reported.
- [x] Outcome checks read real end state (SQL, filesystem, HTTP) and the Transcript view shows an expected-vs-actual diff. (The agent harness snapshots the end state into `trial.state`; the example reads its SQLite database. Direct SQL/HTTP readers from the runner are a later step.)
- [x] pass@1 and pass^k are reported per task and per suite; a flaky-task detector flags inconsistent tasks.
- [x] `litmustest compare A B` produces paired deltas with CIs per suite, a flip list, failure-mode deltas and cost deltas; Run compare renders them.
- [x] Transcript view shows the timeline with each check pinned to its step, a triage verdict (agent / grader / task / infra) to confirm or override, and the trial strip. (Triage is written into the run summary through the validated save path.)
- [x] Disputing a verdict writes a label for that judge. (The trial is written as a trace under `datasets/traces/` first, so the label resolves and feeds calibration.)
- [x] `litmustest ci` runs gated suites, posts the comparison as a PR comment, and exits non-zero on a crossed gate; capability is report-only. (`--write-workflow` scaffolds the GitHub Action.)
- [x] A task failing 0/15 across 3 runs is flagged "likely broken".

## Phase 4: Close the loop

- [x] A scheduled sampler pulls production traces into the review queue weekly. (`litmustest sample --if-due` honours `sources.sampler.every`; `--write-workflow` scaffolds a weekly GitHub Action that opens a PR with the batch.)
- [x] Capability tasks that pass every trial for 3 runs are proposed for graduation; a suite above 90% raises a saturation alert. (`litmustest graduate [--apply]`, the Tasks & suites page, and the Overview's needs-attention list; a graduation is one multi-file change: the task and both suite lists.)
- [x] At least two platform adapters (e.g. Langfuse, Braintrust) ingest traces without a manual export. (Pull adapters over their HTTP APIs with credentials from the environment, tested against recorded response shapes rather than live accounts.)
- [ ] Hosted mode: dashboard saves become commits on a PR branch via a GitHub App. (Not started: needs a GitHub App and a hosted deployment; the local write-back model it would mirror is in place.)

## Cross-cutting, every phase

- [ ] Every number in the dashboard links to the tasks behind it; every task to its transcript.
- [ ] No number is shown without its margin of error.
- [ ] Every control is a real button/link/input, ≥ 44px, keyboard reachable, with a visible focus ring.
- [ ] Text contrast ≥ 4.5:1 on its ground in both themes.
- [ ] The same action works from the CLI and the dashboard; the dashboard is a client of the files.
