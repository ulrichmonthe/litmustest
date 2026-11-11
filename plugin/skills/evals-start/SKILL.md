---
name: evals-start
description: Entry point for litmustest. Looks at the state of the evals/ directory and routes to the one litmustest skill that fits. Use when the user asks for help with evals, does not know where to begin, or asks for something no other litmustest skill clearly matches. Do not use when a more specific skill already matches; load that one directly.
---

<!-- Modified from ai-evals-course/evals-skills (Apache 2.0): the routing idea is the course's; the table covers all fourteen litmustest skills and routes from `litmustest doctor`. -->

# Evals start

This skill only routes. Find where the team is, tell the user which skill you are loading and why, then load it and follow its workflow from start to finish. Do not improvise a shorter version of another skill here.

Three rules from `CLAUDE.md` bind every litmustest skill:

1. `evals/` in git is the source of truth. Skills write files there; nothing else.
2. You propose, people decide. Files you write stay uncommitted until a person commits them. Never commit, never push.
3. Reading traces and labeling are human work. No skill labels a trace or writes a reviewer's note.

## Step 1: Look before you route

If there is no `evals/litmustest.yaml`, the team is at the start. Ask whether they have traces or logs of the product. Then use the first two rows of the table.

If `evals/` exists, read its state:

```bash
litmustest validate
litmustest doctor
```

`doctor` prints findings and a `next:` line. Map them:

| `doctor` says | Load |
| --- | --- |
| Review queue has unlabelled traces, or there are no failure modes | `error-discovery` |
| Judge stale or untested | `validate-evaluator` |
| Broken task (fails every trial, reference passes) | `triage-failures`, then `define-task` if the premise is wrong |
| Flaky task | `triage-failures` |
| Graduation candidates, capability saturation | `graduate-suite` |
| `validate` errors | Fix them first; `eval-audit` if there are many |

## Step 2: Pick the skill

| Situation | Skill |
| --- | --- |
| No traces yet, or too few to review (under ~100 representative ones) | `generate-synthetic-data`, then `error-discovery` |
| Has traces or logs, no named failure modes | `error-discovery` |
| Inherited an eval setup, or unsure whether the numbers can be trusted | `eval-audit` |
| A failure mode a function can check (format, schema, a tool called, a value in the end state) | `write-code-eval` |
| A failure mode that needs judgement (tone, grounding, relevance) | `write-judge-prompt` |
| A judge exists and needs TPR/TNR on held-out labels, or it went stale | `validate-evaluator` |
| The product retrieves documents before answering | `evaluate-rag` |
| The review queue cannot show this trace shape well enough to judge it | `build-review-interface` |
| Turn a trace or a spec item into a task with a reference solution | `define-task` |
| The agent changes things and each trial needs a clean environment (`agent.command`, Harbor, docker) | `build-environment` |
| A run has failed trials and nobody knows why (agent, grader or infra) | `triage-failures` |
| Two runs to compare, or "did this change help?" | `analyze-run` |
| Capability tasks pass every trial and should guard against regressions | `graduate-suite` |
| None of the above, or the user is not sure | stay here and ask |

## The usual order

The skills form one loop. Most teams go through it in this order the first time:

1. `error-discovery` (or `generate-synthetic-data` first): name the failure modes.
2. `write-code-eval` for objective modes, `write-judge-prompt` for the rest. Code checks come before judges.
3. `validate-evaluator`: no judge counts until it is calibrated (TPR and TNR at or above 90% on the test split).
4. `define-task` and `build-environment`: tasks with reference solutions, run in clean trials.
5. `litmustest run`, then `triage-failures` and `analyze-run`.
6. `graduate-suite` when capability tasks saturate. New failures go back to `error-discovery`.

`eval-audit` fits anywhere; it is the right first step for an inherited setup.

## Rules for routing

- Most requests that mention traces and "what is going wrong" mean `error-discovery`.
- Do not route to a grader skill before failure modes exist. A judge or check without a named, observed failure mode measures nothing specific.
- When two rows fit, say both and ask the user which matters now. Do not guess.
- This file holds only routing. The workflow lives in the skill you load.
