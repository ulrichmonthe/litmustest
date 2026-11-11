# Skill runs

Each of the fourteen skills was followed once, start to finish, on 2026-11-11, and what went wrong was logged and fixed. This page is that log.

## What these runs were, and were not

- **Agent runs, not a person's session.** Each skill was followed by a subagent (Claude Sonnet 5.5) acting as the coding agent a user had invoked the skill on. No human drove a live Claude Code session, and nothing was run on Codex. An agent following a document finds wrong commands, missing prerequisites and steps that leave it guessing. It does not find what a person would find confusing, and it does not test whether the skill triggers from a real request.
- **One request per skill**, listed in the table below, in a temporary copy of `examples/support-agent` with the built CLI on `PATH`. One run on one repository is a smoke test, not coverage: branches of a skill that this repository's state did not reach are listed as not exercised.
- **No model key.** Nothing that calls a model ran: `discover`, `draft-judge`, `draft-check`, `calibrate --split dev|test`, `explain` with the model, and every real agent trial. Each was attempted once where its skill asked for it, the error was recorded, and the step is marked **not run**. Runs used `--dry-run`, which grades the reference solutions. No model output was made up.
- **No labels written, nothing committed.** Labelling is human-only. No agent ran `litmustest label` or `litmustest dispute` or wrote under `evals/labels/`. Every run stopped before a commit.
- **One change to the copy.** The example's `agent.cwd` is wrong as checked in (see Findings in the example), so the temporary copies used `cwd: ../..`. The checked-in example was left alone; that fix belongs to the runner lane.
- **The fixes below were not re-run.** The skills and the CLI were changed after the runs. `npm test` covers the CLI changes and checks that every command a skill names exists; nobody has followed the edited skills again.

## Result per skill

"Validate" is `litmustest validate` on the evals directory at the end of the run. All fourteen ended with 0 errors; the 12 or 13 warnings are the example's stale `missed_refund` judge.

| Skill | Request | Reached | Files written | Not run or not reached |
| --- | --- | --- | --- | --- |
| `evals-start` | "Get me started: where are we and what next?" | Routing from `doctor` | none | Loading the routed skill |
| `eval-audit` | "Audit our evals and tell me what is weakest." | All six areas, a ranked report | none | The review-queue rendering check (needs a browser) |
| `error-discovery` | "Group the reviewers' notes into failure modes." | Ingest, then grouping | one extra batch file | `discover` (no key); the review loop (human) |
| `generate-synthetic-data` | "Cover frustrated customers asking for a late refund." | Dimensions, tuples, 20 inputs | a driver and inputs outside `evals/` | Running the product on the inputs (no key), so no traces and no ingest |
| `write-code-eval` | "Write a code check for `over_searching`." | A hand-written check, wired into 35 tasks | the check, 35 task files, a dry-run summary | `draft-check` (0 labels); agreement with labels (0 labels) |
| `write-judge-prompt` | "Write a judge for `ungrounded_policy`." | A hand-written prompt and `judge.yaml` | the judge directory | `draft-judge` (0 labels); few-shot selection (0 labels) |
| `validate-evaluator` | "The `missed_refund` judge is stale; calibrate it." | Splits refreshed | `calibration.json`, by `calibrate` | The dev and test runs (no key). **The judge was not calibrated.** |
| `evaluate-rag` | "Does the agent fetch the right policy and ground its answers?" | A failure mode, a check and one task | five files | Judges, calibration, the retrieval comparison |
| `build-review-interface` | "Tool-call JSON is hard to read; help reviewers label faster." | The queue served and checked over HTTP | none | A custom view (gated on a reviewer trying the queue) |
| `define-task` | "Turn trace `tr_0013` into a regression task." | Task, reference, suite entry, deep check, dry run | three files and a dry-run summary | Judges on the reference (no key) |
| `build-environment` | "Is the trial environment isolated, and is the end state graded?" | An audit of the existing wiring | two run summaries | A real trial (no key) |
| `triage-failures` | "Triage the failures in `run_0041`." | Every failed trial read and grouped | none | `explain` with the model (no key); confirming in the dashboard (human) |
| `analyze-run` | "Compare `run_0040` and `run_0041`; safe to ship?" | The full analysis with intervals | none | The dashboard view; posting a comment |
| `graduate-suite` | "Which capability tasks are ready to graduate? Move them." | Proposals (none were ready) | none | `--apply` (nothing to apply) |

## Findings and fixes

### In every skill

| Finding | Fix |
| --- | --- |
| Commands were written bare (`litmustest validate`, `litmustest doctor`) and assume `evals/` at the repository root. In the sample repo it is `examples/support-agent/evals`, and nine runs hit this first. | Every skill now opens with where the evals directory is and says to pass `--dir <evals dir>`. |
| `litmustest doctor` and `litmustest coverage` pointed at a directory that does not exist exited 0 and said nothing needed attention: a false all-clear. | CLI: `doctor`, `coverage`, `graduate` and `compare` now exit 1 and name the missing directory. |
| `litmustest <command> --help` failed with "unknown flag", sometimes with a stack trace. Eight runs tried it. | CLI: it prints that command's usage. |
| `validate` takes the directory as an argument while every other command takes `--dir`; `validate --dir` was an unknown flag. | CLI: `validate` accepts `--dir` as well. |
| Several skills cite `docs/SCHEMAS.md`, which is in the litmustest repository, not in a user's. | The skills now say so. The file is still not shipped with the plugin (`docs/CODEX.md` lists this gap). |

### One serious CLI finding

`litmustest calibrate <judge> --split dev` with no model key did not fail. Every verdict came back Unknown with a model error, and the command **recorded that as a dev run**: it overwrote the judge's dev numbers with TPR 0 and TNR 0 and moved its status from `stale` to `dev`. On the test split it would have spent the one test run on nothing.

Fixed in `packages/cli/src/calibrate.ts`: when the model was not reached for any trace, `calibrate` stops, says so, and writes nothing (`tests/calibrate.test.ts`). `validate-evaluator` now says to check the key first and that all-Unknown verdicts are not a measurement.

### Per skill

| Skill | Finding | Fix in the skill |
| --- | --- | --- |
| `evals-start` | `doctor` listed four findings; the table gave no order, and "load it" contradicted "ask the user". | An order of priority; several findings mean say all, recommend one, ask. A status-only request stops and asks. |
| `eval-audit` | "Is the test interval wide?" could not be answered as written; the trace-depth test named fields the stored traces do not have. | Count labels per class in `matrix`; look for chat and `execute_tool` spans. Silence from a rule means it passed. |
| `error-discovery` | No entry point for "notes already exist", so the run ingested again and wrote a second batch. | With labels present, skip to grouping; do not ingest again; say when there is nothing new to propose. |
| `generate-synthetic-data` | `agent.command` is bound to a task id, so it cannot run an arbitrary input; inputs must use the product's seed data; 100 inputs is too many for one gap. | Call the agent's own entry point; use fixture data; 20 to 30 for one gap; stop and hand over the inputs when the product cannot run. |
| `write-code-eval` | No path for a mode with no labels; no guidance when tasks already carry a check for the mode. | Stop and ask for labels; a hand-written check is reported as untested and gets no made-up fixture; keep the existing check and report the overlap. |
| `write-judge-prompt` | No path for a mode with no labels; "tool results" is not an input name. | An empty few-shot draft is allowed and reported as owing labels; grounding uses `tool_calls`. |
| `validate-evaluator` | See the CLI finding above; no guidance under 60 labels or for finding what made a judge stale. | Check the key; proceed on dev under 60 and say the intervals are wide; `git log -p` on the prompt. |
| `evaluate-rag` | Written for ranked retrieval; the example agent looks up a policy by key. Example check files do not exist. | A lookup by key is retrieval with the key as the id; reuse an existing failure mode; the example files are yours to write. |
| `build-review-interface` | Port 4242 was already serving something else; the API's reply shape was misdescribed. | Pass `--port` and check whose server it is; the reply's real keys; a stated complaint counts as reviewer feedback. |
| `define-task` | No check for a task with the same input (the new task was a near duplicate); a dry run's 0% headline reads as a failing reference; coverage after a one-task dry run shows nothing. | Search for the input first; read `failed_checks`, not the headline; take coverage before the dry run; untracked files need more than `git diff`. |
| `build-environment` | "Every task should pass" is false without a key; no path for auditing wiring that already exists. | What to read instead; an audit checklist; a missing key shows as an infra error tagged `network`. |
| `triage-failures` | No guidance for 56 failed trials; the transcript path's base was unstated. | Group by check and critique; a judge-only failure is not automatically the grader's; where the path is relative to. |
| `analyze-run` | A gate failing identically in both runs read as caused by the change; `compare` exiting 1 looked like an error; summaries had no coverage snapshot. | A standing failure is named as one; exit 1 is the verdict; say when no coverage change is available. |
| `graduate-suite` | No guidance for "0 tasks ready" or for fewer runs than the window. | Report it, name the runs considered, skip `--apply`. |

### Findings in the example, not fixed here

These are about `examples/support-agent` or the runner, which other work owns. They are recorded so they are not lost.

- **`agent.cwd` is wrong.** `evals/litmustest.yaml` has `cwd: .` with a command path that starts at the repository root, so the runner looks for the script under `examples/support-agent/examples/support-agent/` and every real trial is an infra error. Only `--dry-run` works as checked in. Being fixed in the runner lane.
- **The seeded transcripts carry `triage_suggested: agent` for every trial**, including judge-only failures that the runner itself would mark `grader`. The seed data and the runner's heuristic disagree.
- **A missing model key is tagged as an infra error of kind `network`.** It is not a network problem.
- **`seed.sqlite` is generated on first use and is not checked in.** With several trials starting at once, the first use can race.
- **The outcome checks read the script's own snapshot**, which records only the last refund row. A refund on the wrong invoice would pass. (Runner-read end state is planned separately.)
- **`missed_refund` is a judge for something objective** ("`process_refund` was never called"). A code or outcome check would carry it without calibration. Its few-shot notes are placeholders.
- **Two failure modes marked high severity have no check at all**: `ungrounded_policy` and `wrong_tool_args`. Five of seven modes have no labels.
- **`define-task` on `tr_0013` produced a near duplicate** of an existing task with the same input.

## What is still owed

- A person following each skill in a live Claude Code session.
- The model-backed steps of every skill, with a key: `discover`, `draft-judge`, `draft-check`, `calibrate` on dev and test, `explain`, and real trials.
- A second run of each edited skill.
- The branches this repository's state never reached: a first-time `init`, a custom review view, `graduate --apply`, a dispute, a ranked-retrieval product.
- Codex (`docs/CODEX.md`).
