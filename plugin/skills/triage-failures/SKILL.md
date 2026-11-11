---
name: triage-failures
description: After a litmustest run, sort the failed trials into product, grader, task or infra failures. Uses `litmustest explain` and the dashboard's Transcript page, proposes a triage per trial, and leaves the confirming to a person. A disputed judge verdict becomes a label made by a person. Use after `litmustest run` or a red CI comment, when someone asks "why did this fail?", or before trusting a drop in a pass rate.
---

# Triage failures

You are helping a person decide why each failed trial failed. There are four answers, and each leads somewhere different:

| Verdict (`triage.verdict`) | Dashboard says | Means | Goes to |
| --- | --- | --- | --- |
| `agent` | the product | The agent did the wrong thing; the check is right. | A product fix. A new failure mode if it is new. |
| `grader` | the grader | The check or judge is wrong about a trial that was fine (or missed a bad one). | Fix the code check, or dispute the judge verdict. |
| `task` | the task | The task is ambiguous, its reference is wrong, or its premise cannot be met. | `define-task` to fix it. |
| `infra` | the infrastructure | Timeout, crash, network. Already excluded from the score. | `build-environment`. |

The output of this skill is a triage proposal per failed trial, plus explanations saved in the run summary. A person confirms each triage in the dashboard.

Three rules from `CLAUDE.md` bind you:

1. `evals/` in git is the source of truth. Triage and explanations are written into `evals/runs/<run id>.json` and land as uncommitted changes.
2. You propose, people decide. You never confirm a triage, never write a label, never commit. Explanations are advice, never a verdict: they do not change `pass`, checks or gates.
3. No judge counts until it is calibrated. A disputed judge verdict is evidence about the judge. It goes to the labels as a human label, and `litmustest calibrate` decides what it means.

## Progress updates

Say what you are reading and what you found. "run_0041: 31 failed trials across 14 tasks, 2 infra errors. Explaining one trial per task." Do not go quiet while `explain` calls the model.

## Phase 1: See the shape of the failures

```bash
litmustest doctor
litmustest explain --no-model
```

`doctor` flags tasks that are likely broken (fail every trial across runs while the reference passes: a `task` problem) and flaky (pass some trials, fail others with nothing changed). `explain --no-model` prints a template for the first failed trial of each task, built from the data alone: what was tested, what happened, at which step, and what would make it pass. It writes nothing.

Infra trials are already tagged and excluded. Count them and move on unless the rate is high (over a few percent); then hand off to `build-environment`.

## Phase 2: Read the trials

```bash
litmustest explain                 # Claude reads each failed task's first failed trial
litmustest explain --task <id> --all
```

Without `--no-model`, Claude adds a reading of the transcript (`summary`, `cause`, `fix`, `confidence`) and saves it as `trials[n].explanation` in the run summary, an uncommitted change. Already explained trials are skipped unless `--force`. It needs a model token. You can also read the trial yourself: `<transcripts path>/<run id>/<task>/<n>/trial.json` and `grades.json` (the grades, with reasons, and `triage_suggested`).

For each failed trial, decide which verdict fits, with the evidence:

- **agent**: an outcome or code check failed, and the reference shows what right looks like. Name the step.
- **grader**: only judge checks failed or answered Unknown, and the transcript looks fine to you; or a code check rejected a correct answer. Quote the judge's critique and the line that contradicts it.
- **task**: the reference would not survive this input, the task asks for two incompatible things, or it is `likely_broken`.
- **infra**: tagged already. If a trial failed for an infra reason the runner did not catch (a rate-limit message in the output), say so.

The runner's suggestion (`triage_suggested`) is a heuristic: infra if tagged, task if likely broken, grader if only judges failed, else agent. Agree or disagree with it out loud.

## Phase 3: A person confirms in the dashboard

Start the server if it is not running:

```bash
litmustest serve
```

Give the user the Transcript page for each trial: `http://127.0.0.1:4242/#/transcripts/<run id>/<task>/<n>`. It shows the timeline with each check pinned to its step, the state diff against the reference, the explanation, and the triage card. The person presses **Confirm** to accept the suggestion or picks another verdict to override it. That writes `trials[n].triage` with their name, the time and the runner's `suggested` value.

Present your proposals as a short table: task, trial, your verdict, one line of evidence, link. Let the person go through it. Do not write `triage` into the run summary yourself.

## Phase 4: Disputed judge verdicts

When a person reads a trial and disagrees with a judge, they use **Dispute: human says Pass** (or Fail) on the Transcript page. That turns the trial into a trace under `datasets/traces/` and appends their label to `labels/disputes-<run id>.jsonl` for that judge's failure mode. It is a label made by a person. You never make it for them.

After disputes, tell the user what they feed: the judge's next calibration. Hand off to `validate-evaluator` (or `litmustest calibrate <judge> --split dev`). Several disputes against one judge in one run is a sign the judge, not the product, moved the number.

## Phase 5: Report and stop

Report counts by verdict (proposed and confirmed), the tasks to fix, the judges with disputes, and new behaviour that fits no failure mode (hand off to `error-discovery`). Show the diff of the run summary. Stop. The user commits from the Pending changes tray.

## What you never do

- Confirm or override a triage, or write `triage` into a run summary.
- Write a label, or dispute a verdict on anyone's behalf.
- Treat an explanation as a verdict, or change `pass`, `failed_checks` or a gate because of one.
- Edit `calibration.json`, or a judge prompt to make a failure go away.
- Commit, push, or switch branches.
