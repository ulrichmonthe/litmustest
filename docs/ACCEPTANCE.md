# Acceptance criteria

As of 2026-10-27. Derived from the 25-chapter "evalkit Master Class" guide, which describes what a user can do at each step. Each phase is done when every line in its list is true against the sample repo, and the matching guide chapters are accurate without edits.

## Phase 1: Discover

- [ ] `evalkit init` creates `evals/` with `evalkit.yaml`, empty folders and a README, and detects a JSONL trace source.
- [ ] `evalkit ingest traces.jsonl` normalizes to the internal trace shape, clusters, and writes a review batch (cluster reps + random) with a coverage report.
- [ ] `evalkit serve` opens the dashboard; Review queue shows the batch.
- [ ] In the Review queue: j/k move, p/f label, n focuses the note, Enter saves and advances. A label is appended to `labels/*.jsonl` with annotator and timestamp within one second.
- [ ] Tool calls render between messages; an expected-but-missing tool call can be flagged by the renderer when a task specifies it.
- [ ] "Ask Claude to regroup notes" runs `error-discovery` and returns proposed failure-mode files as a diff in the Pending changes tray; nothing is written until accepted.
- [ ] Failure modes view lists modes with count, severity, grader status; definition and severity edit and save to files.
- [ ] Overview (read-only) shows a failure-mode Pareto and the review coverage.
- [ ] Every file written validates against its JSON Schema; an invalid write is refused with the field named.
- [ ] A domain expert who has read guide chapters 3, 6 and 7 can label 50 traces in under an hour without asking an engineer anything.

## Phase 2: Grade and trust

- [ ] "Draft code check" produces a function in `graders/code/` and a test against labeled traces; it lands as a diff.
- [ ] "Draft judge from labels" produces `prompt.md` and `judge.yaml` with one failure mode, Pass/Fail definitions, 3 examples from the train split, structured output with critique first and an Unknown option.
- [ ] The judge editor shows per-field save states (saved, saved to branch, conflict) and refuses to overwrite a file changed on disk.
- [ ] `evalkit calibrate <judge>` splits labels 15/45/40, runs dev, writes TPR/TNR and the confusion matrix to `calibration.json`, and lists disagreements.
- [ ] "Run test set once" is disabled until dev TPR and TNR ≥ 90%; after it runs, any prompt or model change marks the judge stale.
- [ ] Stale judges are excluded from every score and gate, and shown with a stale pill.
- [ ] Reported pass rates for judge-scored checks are corrected for judge error with a bootstrap CI.
- [ ] A task cannot join a suite without a reference solution that passes all its checks.
- [ ] Commit to branch / Open PR / Discard work from the Pending changes tray; the branch name follows `evals/<slug>`.

## Phase 3: Run like an agent eval

- [ ] `evalkit run --suite regression --trials 5` runs each task in a clean environment per trial, grades, and writes a run summary to `evals/runs/`; raw transcripts go to the configured store.
- [ ] Infra failures (timeouts, OOM, harness errors) are tagged and excluded from the agent's score; their rate is reported.
- [ ] Outcome checks read real end state (SQL, filesystem, HTTP) and the Transcript view shows an expected-vs-actual diff.
- [ ] pass@1 and pass^k are reported per task and per suite; a flaky-task detector flags inconsistent tasks.
- [ ] `evalkit compare A B` produces paired deltas with CIs per suite, a flip list, failure-mode deltas and cost deltas; Run compare renders them.
- [ ] Transcript view shows the timeline with each check pinned to its step, a triage verdict (agent / grader / task / infra) to confirm or override, and the trial strip.
- [ ] Disputing a verdict writes a label for that judge.
- [ ] `evalkit ci` runs gated suites, posts the comparison as a PR comment, and exits non-zero on a crossed gate; capability is report-only.
- [ ] A task failing 0/15 across 3 runs is flagged "likely broken".

## Phase 4: Close the loop

- [ ] A scheduled sampler pulls production traces into the review queue weekly.
- [ ] Capability tasks that pass every trial for 3 runs are proposed for graduation; a suite above 90% raises a saturation alert.
- [ ] At least two platform adapters (e.g. Langfuse, Braintrust) ingest traces without a manual export.
- [ ] Hosted mode: dashboard saves become commits on a PR branch via a GitHub App.

## Cross-cutting, every phase

- [ ] Every number in the dashboard links to the tasks behind it; every task to its transcript.
- [ ] No number is shown without its margin of error.
- [ ] Every control is a real button/link/input, ≥ 44px, keyboard reachable, with a visible focus ring.
- [ ] Text contrast ≥ 4.5:1 on its ground in both themes.
- [ ] The same action works from the CLI and the dashboard; the dashboard is a client of the files.
