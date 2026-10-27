# Evals Plugin: Reconciled Spec

As of 2026-10-27. Source of record: the Claude doc "Evals Plugin: Reconciled Spec"; this file is its export for the repo.

## Summary

Build one plugin that takes a team from raw traces to a CI-gated eval suite. It comes with a local dashboard where every eval asset (failure modes, labels, judge prompts, tasks, thresholds) can be viewed and edited. Every edit lands in the repo as a reviewable diff.

The two approaches split the work cleanly. The course loop from evals-skills builds the graders: error analysis, then binary single-failure-mode judges, then TPR/TNR validation. Anthropic's structure from *Demystifying evals for AI agents* runs them: tasks with reference solutions, outcome and transcript grading, multiple trials, capability vs. regression suites, and an isolated harness.

Each check stays binary and calibrated, and each task adds its checks up into partial credit. Every reported number carries two error terms: judge error and sampling error.

Four design principles:

- **The repo is the source of truth.** Plain files under git; the dashboard is an editor over those files.
- **Agents assist, people decide.** Skills propose diffs. A person accepts or rejects them.
- **Every number has an error bar and a path to transcripts.**
- **Calibration is a tracked state.** When a judge's prompt or model changes, its trust badge goes stale until re-validated.

## Implementation gaps (what a team has to build today)

| Gap | evals-skills today | Anthropic guidance today | What the plugin adds |
| --- | --- | --- | --- |
| Eval spec format | None; each skill writes its own scripts | Illustrative YAML, not a schema | Versioned schema for failure modes, tasks, graders, suites |
| Runner and harness | None | Describes one; points to Harbor, Braintrust, LangSmith | Runner with trials, concurrency, clean environments, caching, cost |
| Trace ingestion | A JSONL/CSV/JSON file | Not covered | Adapters (OTel, Braintrust, Langfuse, LangSmith, JSONL) to one schema |
| Label storage | Per-session review app | Not covered | Labels as versioned files with annotator, timestamp, rubric version |
| Traceability | Implicit | Implicit | failure mode → check → task → run → transcript |
| Judge versioning | Advice to pin ids, re-validate | Advice to calibrate periodically | Registry: prompt hash, model id, TPR/TNR, splits, stale badge |
| Non-determinism | Not covered | pass@k, pass^k | Trials per task; both metrics; flaky-task detector |
| Comparing runs | CI on corrected pass rate | Error-bar statistics (Miller) | Paired differences with CIs, clustered errors, MDE |
| Suite lifecycle | Not covered | Capability vs regression; graduation | Suite types; graduation rule; saturation alerts |
| Stateful outcomes | Not covered | state_check examples | Outcome-check interface (SQL, files, HTTP, page state) |
| Infra noise | Not covered | Infra errors move scores | Infra failures tagged and excluded from agent scores |
| CI | Not covered | "Run on every commit" | GitHub Action, PR comment, gates per suite |
| Production loop | Paid course | Monitoring/A-B as complementary | Sampler pulling production traces into the queue |

## Output and visualization gaps

| Question | What answers it | Missing today |
| --- | --- | --- |
| Are we getting better, and is it real? | Pass rate per suite with CI over time; paired delta | No CI in default output anywhere |
| What breaks most? | Failure-mode Pareto with trend and severity | Taxonomy lives in notes |
| Which tasks changed between A and B? | Flip list with transcript links | Not available |
| Can I trust this judge? | Confusion matrix, TPR/TNR by version, disagreements | Printed once, not tracked |
| Why did this task fail? | Transcript timeline with checks pinned to steps; state diff | No published viewer |
| Reliable or lucky? | pass@1, pass@k, pass^k; flaky tasks | Not in the skills |
| Is the eval itself healthy? | Saturation, 0%-everywhere tasks, imbalance, infra rate, leakage | Scattered advice |
| What does it cost? | Tokens, latency, dollars per task and run | Not covered |

## Reconciled methodology

Unit of work: Anthropic's **task**. The course's **failure modes** become tags on the checks inside tasks.

Lifecycle, seven stages that loop:

1. **Observe.** Ingest production or dogfood traces; sample a diverse set (clusters + random).
2. **Discover.** Annotate with free-text notes; the agent groups notes into failure modes.
3. **Specify.** Promote traces to tasks with a reference solution. Write capability tasks from the spec before the agent can pass them.
4. **Grade.** Code check per objective failure mode; binary judge per subjective one; outcome checks for stateful agents.
5. **Validate.** Calibrate each judge on train/dev/test splits until TPR and TNR clear 90%.
6. **Run.** k trials per task in clean environments. Tag infra failures separately.
7. **Decide.** Paired CIs, CI gates, graduate saturated tasks. New failures go back to Observe.

Where the sources conflict:

| Question | evals-skills | Anthropic | Plugin rule |
| --- | --- | --- | --- |
| Scoring | Binary only | Partial credit | Binary checks; task reports strict pass and weighted score |
| When to write evals | After error analysis | Also before the capability exists | Two doors into one task format |
| Process vs outcome | — | Grade what was produced | Path checks allowed, marked, off by default in capability suites |
| Judge calibration | Splits, ≥90/90, bias correction, bootstrap | Calibrate with experts; allow "Unknown" | Course procedure + "Unknown" counted separately and routed to humans |
| Statistics | Judge-error correction | Sampling error | One bootstrap over tasks and judge confusion |
| Who labels | One trusted expert | Product people contribute tasks | Expert role; agreement tracked with a second annotator |
| Unambiguous tasks | — | Two experts agree; reference solution | Reference solution must pass all checks before a task joins a suite |
| Balance | Balanced labels for calibration | Test should and shouldn't | Suites flag class imbalance |

## Plugin architecture

Four parts that read and write the same `evals/` folder: **skills** for the coding agent, a **CLI and runner**, a **local server** that watches the folder and validates writes, and the **dashboard** it serves. The agent, the dashboard and CI never talk directly; they meet at the files.

```
coding agent + skills ──edits files──▶ evals/ (git) ◀──validated writes── local server ◀──HTTP── dashboard
                                          ▲                                   │
CI (GitHub Action) ──invokes──▶ CLI + runner ──runs trials──▶ clean environments
                                          └── run summaries written back to evals/runs/
```

### Task spec

```yaml
id: refund_frustrated_001
suite: regression
source: trace:tr_8812          # or spec:refunds-v2 for capability tasks
input: { persona: frustrated, message: "I was charged twice..." }
reference_solution: refs/refund_frustrated_001.json
trials: 5
checks:
  - id: refund_processed
    type: outcome
    expect: { refunds.status: processed }
    weight: 3
  - id: tone_mismatch
    type: judge
    failure_mode: tone_mismatch
    weight: 1
  - id: identity_verified
    type: code
    fn: graders/code/identity_verified.py
    weight: 2
report: [strict_pass, weighted_score, pass_at_k, pass_hat_k]
```

### Skills

Keep the nine course skills (evals-start, eval-audit, error-discovery, generate-synthetic-data, write-code-eval, write-judge-prompt, validate-evaluator, evaluate-rag, build-review-interface), rewritten to write into the schema. Add five: **define-task**, **build-environment**, **triage-failures**, **analyze-run**, **graduate-suite**.

### CLI

| Command | Does |
| --- | --- |
| `litmustest init` | Scaffolds `evals/`, detects trace sources, writes config |
| `litmustest ingest <source>` | Normalizes traces; samples a review batch |
| `litmustest run --suite <s> --trials <k>` | Runs tasks in clean environments, grades, writes a run summary |
| `litmustest compare <A> <B>` | Paired deltas with CIs; flip list |
| `litmustest calibrate <judge>` | Dev run, or the one-time test pass; writes calibration.json |
| `litmustest serve` | Local server + dashboard |
| `litmustest ci` | Gated suites, PR comment, non-zero on a gate failure |
| `litmustest doctor` | Health checks; the maturity-ladder symptoms |

## Dashboard

| View | Answers | Main visuals | Editable there |
| --- | --- | --- | --- |
| Overview | Are we improving, can I trust it? | Verdict strip, suite scorecards with CI, needs-attention list, flip list | Nothing; every tile links |
| Review queue | What is going wrong? | Trace reader, keyboard Pass/Fail, note, suggested failure-mode chips, coverage | Labels, notes, promote to task, new failure mode |
| Failure modes | What breaks most? | Pareto with severity, grader status, trend; selected-mode editor | Definition, severity, owner, merge/split/retire |
| Tasks & suites | What is tested, how reliably? | Suite cards, health strip, table with pass@1, pass^5, 5-run history | Task spec, reference solution, suite membership, graduate |
| Run compare | Did this change help? | Per-suite delta as CI on an axis, flip list, failure-mode deltas, cost | Mark flip as expected; post to PR |
| Transcript | Why did this trial fail? | Triage verdict, timeline with checks pinned to steps, state diff, trial strip | Confirm/override triage; dispute a verdict (becomes a label) |
| Judges | Can I trust this judge? | Stepper (edit → dev ≥90/90 → test once → trusted), confusion matrix, TPR/TNR by version, disagreements, few-shot picker | Prompt, examples, model pin; run dev; lock and run test |
| Settings | What does CI enforce? | Gates, runs, judges, sources/storage, form or `litmustest.yaml` | All config |

Interactions that matter most: keyboard-first labeling (j/k/p/f/n/Enter), drill-down from any number, and "Ask Claude" actions that return a proposed diff, never an automatic change.

## Editing from the dashboard

1. Edit in a form or the file; both views stay in sync.
2. On save, the server validates (schema, judge lint, leakage, reference check, test-set lock) and writes to a branch. Refuses if the file changed on disk since loaded (content hash); offers Reload or Keep mine.
3. The change appears in a **Pending changes** tray as a diff, with affected views marked.
4. From the tray: commit to branch, open PR, or discard.
5. Downstream state updates (a judge edit → stale badge → "Run dev").

Agent-assisted edits use the same path. Hosted mode (later) applies the same model via a GitHub App: every save is a commit on a PR branch.

## When to adopt, and when to go further

Start the first time a user says the product "feels worse" and nobody can check, or a prompt change cannot be judged. After that, `litmustest doctor` watches for symptoms after every run and shows a "next step" card.

| You are at | Symptom | Move to |
| --- | --- | --- |
| No evals | Bugs return; "feels worse" with no way to check | Error analysis, a few code checks |
| Code checks only | Judgment failure modes have no grader | Calibrated binary judges |
| Uncalibrated judges | Judge in a gate with no test TPR/TNR, or < ~60 labels | Validation workflow |
| Single-run scores | Tasks flip with nothing changed | Trials; pass@k and pass^k |
| Agent changes state | "Done" but nothing checks the database | Outcome checks, clean environments |
| Noisy comparisons | Every change inside the error bars | More tasks; paired comparisons |
| Infra noise | Several % of failures are timeouts/crashes | Isolated environments; infra tagged |
| Saturated suite | Capability > 90% for several runs | Graduate; write harder tasks |
| New model release | No quick answer on switching | Rerun capability suite |
| Production | Failures arrive only as complaints | Production sampler |

Thresholds from the sources: 20–50 tasks to start; 0% across many trials means a broken task; judges need TPR and TNR ≥ 90%; under 60 labels gives wide intervals.

## What is automated, and what is not

| Stage | Automated | Claude proposes, a person accepts | Human only |
| --- | --- | --- | --- |
| Setup | Detect trace format; write config | Scaffold; connect sources | Credentials; sandbox; enabling CI |
| Discovery | Scheduled ingest; diverse sampling | Group notes into failure modes; pick next traces | Reading traces and writing notes; naming modes and severity |
| Grading | Run checks and trusted judges; validate saves; flag stale | Draft checks and judges; pick examples; explain disagreements | Labeling calibration data; approving the single test run |
| Tasks | Flag broken, flaky, imbalanced | Promote traces; draft references; synthetic inputs | Confirming a task is unambiguous |
| Runs | Trials, error bars, correction, flips, cost, PR comment, gates | Triage failures; suggest graduations | Thresholds; deciding to ship |
| Changes | Write diffs to a branch | Every agent edit is a proposed diff | Commit, merge, discard |

## Build plan

| Phase | Scope | Done when |
| --- | --- | --- |
| 1. Discover | Schemas, `init`, `ingest`, Review queue, Failure modes view, read-only Overview | A team goes from a traces file to a named, counted failure-mode list |
| 2. Grade and trust | Code checks, judges, calibration workflow, Judges view, write-back with Pending changes | A judge is drafted, calibrated and edited entirely from the dashboard |
| 3. Run like an agent eval | Runner with trials and clean environments, outcome checks, pass@k/pass^k, Run compare, Transcript view, CI action | A PR shows a paired delta with CIs and blocks on a regression gate |
| 4. Close the loop | Production sampler, graduation, saturation alerts, hosted mode, platform adapters | New production failures reach the queue without manual export |

Open questions: see `DECISIONS.md`.

## Sources

- evals-skills: https://github.com/ulrichmonthe/evals-skills (upstream https://github.com/ai-evals-course/evals-skills, Apache 2.0)
- Anthropic, Demystifying evals for AI agents: https://www.anthropic.com/research/demystifying-evals-for-ai-agents
- Anthropic, Infrastructure noise in agentic coding evals: https://www.anthropic.com/research/infrastructure-noise
- Evan Miller, Adding Error Bars to Evals: https://arxiv.org/pdf/2411.00640
