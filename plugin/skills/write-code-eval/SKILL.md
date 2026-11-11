---
name: write-code-eval
description: Write a deterministic code check for one failure mode with litmustest. Drafts graders/code/<name>.py with check(trial, args) -> bool, tests it against the human labels, wires it into tasks with the failure_mode tag, and verifies every reference solution still passes. Use when a failure mode is objective enough for code to decide from the trial (tool calls, order, arguments, end state, output structure). Use write-judge-prompt when the rule needs interpretation.
---

<!-- Modified from ai-evals-course/evals-skills (Apache 2.0): the method is the course's; the check signature, the draft-and-test loop and the task wiring are litmustest's. -->

# Write a code check

You are turning one failure mode into a code check. The failure mode already exists under `evals/failure_modes/<name>.yaml`, found by error analysis. The output of this skill is a Python check under `evals/graders/code/`, its test, and the task files that use it, all uncommitted on the branch. A person commits them.

Three rules from `CLAUDE.md` bind you:

1. `evals/` in git is the source of truth. You write files there; nothing else.
2. You propose, people decide. Never commit, never push. The Pending changes tray shows what you wrote.
3. Labels are human. You read `evals/labels/*.jsonl`; you never write or change a label.

Code checks come before judges. A check is cheap, fast, deterministic and needs no calibration. Reach for a judge only when code cannot decide.

## Phase 1: State the rule

Read the failure mode's `definition`. Write the rule as one sentence that says what Pass and Fail look like in terms of fields of a trial. A trial has the reference-solution shape (`docs/SCHEMAS.md`, `reference_solution`):

- `output`: the final response
- `tool_calls`: `[{name, args, result}]`, in order
- `transcript`: `[{role, content, tool?}]`
- `state`: the end-state snapshot the harness took
- `input`: what the agent received

If the rule needs interpretation (tone, faithfulness, whether an answer is complete), stop and use `write-judge-prompt`. If it has an objective part and an interpretive part, check the objective part here and judge the rest.

Before writing a Python check, see whether a built-in check type already fits:

| Failure | Use |
| --- | --- |
| Wrong end state (refund not processed, row missing) | `type: outcome` with `expect` |
| Too many tool calls or turns, a tool never or wrongly called | `type: transcript` with `max_toolcalls`, `required_tools`, `forbidden_tools` |
| Order, arguments, output structure, cited ids, values vs. a reference | `type: code` |

Outcome checks read the real end state and are the strongest signal for an agent that changes things. Prefer them when the state shows the failure.

## Phase 2: Draft the check

You need labels for this failure mode: at least 4 traces labelled Pass or Fail on the mode's own chip in the review queue. Labels for `overall` do not count.

```bash
litmustest draft-check <failure_mode>
```

It writes three files and runs the test:

- `graders/code/<failure_mode>.py` exposing `check(trial: dict, args: dict) -> bool`. True means Pass (the failure is absent).
- `graders/code/test_<failure_mode>.py`
- `graders/code/fixtures/<failure_mode>.jsonl`: the labelled trials, one per line with `label` and `trace_id`

It prints `AGREEMENT <agree>/<n>` and one `DISAGREE` line per mismatch. Needs `ANTHROPIC_API_KEY`.

You can write the check yourself instead; you are the same model. Keep the same file names and the same signature. Rules for the function:

- Standard library only. No model calls, no network, no randomness, no clock.
- A docstring that says the rule in one or two sentences, like `examples/support-agent/evals/graders/code/confirmation_sent.py`.
- Prefer structure (which tools ran, in what order, with what results) over keywords. When text matching is unavoidable, keep it narrow and case-insensitive and say why in a comment.
- Put anything a task might vary (tool names, thresholds, expected ids) in `args`, with a default, as `identity_verified_first.py` does with `gated`.
- Handle missing fields: `trial.get("tool_calls", [])`, `call.get("result") or {}`.

## Phase 3: Test against the labels

Re-run the test after every edit:

```bash
python3 -I evals/graders/code/test_<failure_mode>.py evals/graders/code/fixtures/<failure_mode>.jsonl evals/graders/code/<failure_mode>.py
```

Read every disagreement. For each, open the trace and decide:

- The check is wrong: fix the check.
- The rule is ambiguous: say so and ask the user whether to sharpen the failure-mode definition. Do not change it yourself without asking.
- The label looks wrong: tell the user which trace and why. Do not touch the label. The reviewer relabels in the queue if they agree.

Add borderline cases to your reasoning, not to the fixture: the fixture is the labelled data, nothing else. Report the final agreement as `agree/n` with the remaining disagreements and one sentence on what the check cannot see. A check that is a proxy for human judgment and still disagrees with several labels belongs in a judge.

## Phase 4: Wire it into tasks

Add the check to every task where the failure can happen, in `evals/tasks/**/<id>.yaml`:

```yaml
checks:
  - id: identity_first
    type: code
    fn: graders/code/identity_verified_first.py
    args: { gated: [fetch_invoices, process_refund] }   # optional
    weight: 2
    failure_mode: identity_leak
```

- `id` is `snake_case` and unique within the task.
- `failure_mode` names the existing mode. A retired mode cannot be referenced.
- `weight` reflects how much the check matters in the weighted score; the strict pass needs every check regardless.
- If no task covers the failure yet, say so and suggest `define-task` rather than inventing one silently.

## Phase 5: Verify

```bash
litmustest validate --deep
```

`--deep` runs every code, outcome and transcript check against each task's reference solution in `evals/refs/<task id>.json`. Every reference must pass every check. If one fails, the check is wrong or the reference is; find out which and say so. Do not edit a reference solution to make a check pass without asking.

Optionally confirm on real trials:

```bash
litmustest run --task <id> --dry-run
```

## Report and stop

Tell the user: the rule, the agreement with labels, the remaining disagreements, the tasks you wired it into, and the `validate --deep` result. The files are pending on the branch. Stop. Do not commit.

## What you never do

- Write, change or delete a label.
- Call a model or the network from inside a check.
- Edit `calibration.json`, `datasets/`, or a reference solution without asking.
- Commit, push or switch branches.
