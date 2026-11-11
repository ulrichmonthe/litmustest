---
name: validate-evaluator
description: Calibrate a litmustest judge against human labels. Runs the judge on the dev split as often as needed, reads the disagreements, improves the prompt and examples, then runs the held-out test split once; the judge is trusted only when TPR and TNR both reach 90%. Use after write-judge-prompt, when a judge is untested or stale, or when a run's judge-corrected intervals look too wide. Not for code checks; test those with write-code-eval.
---

<!-- Modified from ai-evals-course/evals-skills (Apache 2.0): the split-measure-iterate-test method is the course's; the splits, the locked test set, the stale state and the correction in every run are litmustest's. -->

# Calibrate a judge

You are measuring how well a judge agrees with people, and improving it until it can be trusted. `litmustest calibrate` does the splitting, running and scoring and is the only writer of `calibration.json`. You read its output, edit `prompt.md` and `judge.yaml`, and stop. A person commits.

Three rules from `CLAUDE.md` bind you:

1. `evals/` in git is the source of truth. You write files there; nothing else.
2. You propose, people decide. Never commit, never push.
3. No judge counts until it is calibrated: TPR and TNR at or above 90% (`judges.trust_threshold`) on the held-out test split, run once. Editing the prompt or model marks it stale, and stale verdicts are excluded from scores and gates.

Labels are human. You never write, change or infer a label. The judge is measured against people, not against you.

## What the numbers mean here

Fail is the positive class: the judge is a failure detector.

- **TPR**: of the traces a person labelled Fail, the share the judge also called Fail. Low TPR means the judge misses failures.
- **TNR**: of the traces a person labelled Pass, the share the judge also called Pass. Low TNR means the judge cries wolf.
- **Unknown** verdicts are counted apart in the matrix, never as Pass.

Each comes with a 95% bootstrap interval over the labelled traces. Use TPR and TNR, not accuracy: with skewed labels, accuracy hides a judge that never says Fail.

## Phase 1: Check the labels

The judge's labels are lines in `evals/labels/*.jsonl` with `failure_mode: <judge's mode>`, Pass or Fail; the latest line per trace wins. Aim for about 100, roughly half Fail, from a domain expert. Under 60 the intervals are wide and `calibrate` warns; it also warns when the labels are imbalanced. If there are too few Fails, the reviewer should label more failing traces in the queue (`litmustest serve`), balanced even if production is not. Tell the user; do not label.

```bash
litmustest calibrate <judge> --split none
```

This writes or refreshes the splits and the status without calling the model. Splits are 15/45/40 train/dev/test, stratified, deterministic per trace id. The test split is locked once drawn: new labels go to train or dev. Few-shot examples must come from train; `calibrate` refuses a judge whose examples are in dev or test.

## Phase 2: Measure on dev, as often as you like

```bash
litmustest calibrate <judge> --split dev
```

It runs the judge on every dev trace and records TPR, TNR, intervals, the confusion matrix and the disagreements in `calibration.json`, with a run entry per prompt hash. Needs `ANTHROPIC_API_KEY`. Report the two rates with their intervals.

## Phase 3: Read every disagreement

`calibration.json` `disagreements` lists each dev trace where judge and human differ, with the judge's critique. Open each trace and decide:

| Judge | Human | Meaning | Usual fix |
| --- | --- | --- | --- |
| Pass | Fail | Too lenient; hurts TPR | Sharpen the Fail definition; add a Fail example from train |
| Fail | Pass | Too strict; hurts TNR | Clarify Pass, including "the situation never arose" |
| Unknown | either | Not enough to decide | Add the missing `inputs` (`tool_calls`, `state`, `reference`) |

Then choose one change: reword the definitions in `prompt.md`, swap or add few-shot ids from `splits.train` in `judge.yaml`, add an explicit rule for the edge case, or narrow `inputs`. If the label itself looks wrong, name the trace and say why; the reviewer decides and relabels in the queue.

After editing `prompt.md`, update `prompt_hash` in `judge.yaml` (`shasum -a 256 evals/graders/judges/<judge>/prompt.md`) and bump `version`. Run `litmustest validate`. Then re-run dev. Repeat until both rates are at or above the threshold and stable.

If it stalls:

| Problem | Try |
| --- | --- |
| Both rates low | A more capable model (one exact id, e.g. `claude-opus-5-5`) |
| One rate low | Work only on that side's disagreements |
| Both plateau under 90 | The mode is two modes; split it and write two judges |
| Wrong on one kind of input | A train example of that kind |
| Labels contradict each other | The definition is unclear; ask the reviewer to revisit it |

## Phase 4: Test, once

Only when dev is at or above the threshold on the current prompt:

```bash
litmustest calibrate <judge> --split test
```

It refuses if dev has not reached the threshold on this prompt, and refuses a second test run on the same prompt and model. Ask the user before running it. Never pass `--force` unless the user explicitly asks for it; it defeats the point of a held-out set.

If test reaches the threshold on both rates, `status` becomes `trusted`. If not, it stays `dev`: do not tune against the test results. Go back to Phase 3 with dev and new labels. Report test numbers as the judge's numbers; dev numbers are optimistic.

## After it is trusted

- Every `litmustest run` corrects judge-graded pass rates for the measured TPR and TNR (`judges.correct_for_judge_error`) and widens the intervals for judge error and sampling together. You do not apply a correction by hand.
- Editing `prompt.md` or changing `model` makes it stale: the dashboard marks it on save, and `litmustest calibrate <judge> --split none` records it from the CLI. Stale verdicts drop out of scores and gates until dev and test run again.
- Re-calibrate when intervals in a run widen unexpectedly or `litmustest doctor` reports the judge stale or untested.

## Report and stop

Tell the user: label counts (Pass and Fail), split sizes, dev TPR and TNR with intervals per iteration, what you changed and why, the test result if it ran, and the status. The edits to `prompt.md` and `judge.yaml`, and the `calibration.json` that `calibrate` wrote, are pending on the branch. Stop. Do not commit.

## What you never do

- Hand-edit `calibration.json`.
- Write or change a label, or label traces to "fill" a split.
- Use dev or test traces as few-shot examples.
- Run the test split more than once per prompt and model, or iterate on its results.
- Report accuracy, or a rate without its interval.
- Commit, push or switch branches.
