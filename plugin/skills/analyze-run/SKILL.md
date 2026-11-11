---
name: analyze-run
description: Read a litmustest run summary and `litmustest compare A B` honestly. Report every number with its error bar, separate significant changes from noise, read the flip list, pass@1 against pass^k, infra errors and stale or untrusted judges that were excluded, and the coverage change. Use after `litmustest run`, on a CI comment, or when someone asks "did this change help?" or "are we getting better?".
---

# Analyze a run

You are reading one run, or comparing two, and saying what the numbers support and what they do not. The output of this skill is a short written analysis in the conversation. It writes nothing under `evals/`.

Three rules from `CLAUDE.md` bind you:

1. `evals/` in git is the source of truth. Read `evals/runs/<run id>.json` and the task and suite files; do not trust numbers from anywhere else.
2. You propose, people decide. Deciding to ship, and setting thresholds, are human. You say what the evidence is.
3. No judge counts until it is calibrated. Stale and untrusted judges are excluded from scores and gates. Say which ones were, every time.

## Progress updates

Say which runs you are reading and on which commits before you start. "Comparing run_0040 (main @ a1c3f2e) with run_0041 (b7e04d5), 40 common tasks, 5 trials each."

## Phase 1: Read one run

```bash
litmustest doctor
```

Then read `evals/runs/<run id>.json`. Per suite:

| Field | What it is | How to say it |
| --- | --- | --- |
| `pass_rate`, `ci` | Strict pass rate, corrected for judge error when `judges.correct_for_judge_error` is on, with a bootstrap interval over tasks and judge confusion | "regression 85.1% (95% CI 79 to 91)". Never the number without the interval. |
| `pass_at_1` | Share of scored trials that passed, uncorrected | Typical single-shot success. |
| `pass_hat_k`, `k` | Share of tasks that passed every one of k trials | Reliability. A wide gap from pass@1 means flaky behaviour, not a bad agent. |
| `n_tasks`, `n_trials` | Sample size | Under about 20 tasks the interval is wide; say so. |
| `infra_errors` and top-level `infra_error_rate` | Trials excluded from the score | Report them. Above a few percent, the scores are suspect: hand off to `build-environment`. |
| `excluded_judges` | Judges whose verdicts did not count (stale, untested, below target) | Name them. The pass rate does not include what they would have caught. |
| `unknown_rate` | Judge verdicts that answered Unknown | Unknown counts as not passed and goes to the review queue. |

Per task, `flaky` and `likely_broken` come from the detectors. A likely broken task measures the task, not the agent. `coverage` in the summary is the snapshot `litmustest coverage` would print for this run.

## Phase 2: Compare two runs

```bash
litmustest compare <A> <B>
litmustest compare <A> <B> --json      # for exact numbers
```

A is the baseline, B the candidate. The dashboard shows the same thing at `http://127.0.0.1:4242/#/compare/<A>/<B>` (start it with `litmustest serve`).

Read it in this order:

1. **Suite deltas.** Each is a paired bootstrap over the tasks both runs share. "significant" means the interval excludes zero; "within noise" means it does not. A +9 point delta that is within noise is not an improvement. Say "no detectable change", not "slightly better".
2. **Gates.** The verdict for B per suite. `max_drop_pts` only fails on a significant drop. `report_only` suites (capability, usually) never fail the build.
3. **Flips.** Broke, Fixed, Flaky, by majority verdict across trials. One task going 2/4 to 1/5 is weak evidence on its own; many flips in one direction in one suite is the signal. Every Broke flip in a regression suite needs a reading: hand those to `triage-failures`.
4. **Failed checks by failure mode.** Which modes moved. Tie a suite drop to a mode when you can.
5. **Cost, tokens, latency, infra.** A pass-rate gain that doubled the cost is a trade-off, not a win.
6. **Coverage.** The change in each map's checked-or-guarded share, and items with no eval since A. Coverage is report only and never fails a gate.

## Phase 3: Check the comparison is fair

Before you draw a conclusion, check and say:

- Same trials per task (`trials` in both summaries). Different k makes pass^k incomparable.
- Same `excluded_judges` per suite. If a judge counted in A and was stale in B, the delta mixes a product change with a grader change. `compare` does not flag this; you must.
- Only common tasks are compared. Tasks added or removed between runs are outside the delta.
- `config_hash` and `agent_command`. If they differ, say what changed besides the product.
- Infra rates in both. A run with more infra errors scores fewer trials.

## Phase 4: Write the analysis

Keep it short. One line of verdict, then the evidence:

> No significant change on regression (-0.8 pts, CI -7.4 to +5.5) or capability (+9.4, CI -6.6 to +24.7). Quality dropped 24 pts (CI -44 to -4), significant, driven by `tone_mismatch` failures on 4 tasks. `missed_refund` is stale and excluded from both runs. Infra errors 4% → 1%.

Then what you would look at next, and which skill does it: `triage-failures` for the flips, `graduate-suite` if capability is saturating, `define-task` for coverage gaps. Stop there. The decision to ship is the user's.

## What you never do

- Report a pass rate without its interval, or call a within-noise change an improvement or a regression.
- Count an excluded judge's verdicts, or hide that a judge was excluded.
- Fold infra failures into the agent's score.
- Edit a run summary, a gate or a threshold to change the verdict.
- Commit, push, or post to a PR. `litmustest ci --comment` posts, and only when the user runs it.
