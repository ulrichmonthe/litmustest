---
name: define-task
description: Turn a failure mode, a flipped or failing trace, or a spec item into a litmustest task with a reference solution, binary checks and a suite. Writes evals/tasks/<suite>/<id>.yaml and evals/refs/<id>.json, proves the reference passes every check with `litmustest validate --deep`, and adds the task to a suite list. Use when a failure mode has a grader but no task, when a trace should become a regression test, or when a spec item has no eval yet.
---

# Define a task

You are writing one task, or a small family of them. A task is the unit of work: an input, a reference solution, binary checks and a suite. The output of this skill is a set of uncommitted files under `evals/`. A person commits them.

Three rules from `CLAUDE.md` bind you:

1. `evals/` in git is the source of truth. You write files there; nothing else.
2. You propose, people decide. Every file you write stays uncommitted until the user commits it from the Pending changes tray. Never commit, never push.
3. No judge counts until it is calibrated. A judge check on an untrusted judge is excluded from scores and gates, so it cannot be the only check that catches the failure.

## Progress updates

Say what you are about to write and why before each phase. "Promoting tr_0033 to a regression task; three checks, one judge." After each phase, say what passed and what did not.

## Phase 1: Pick the door

There are three ways in. Each sets `source:` differently.

| Starting point | `source:` | Usual suite |
| --- | --- | --- |
| A trace that failed, or a task that flipped in `litmustest compare` | `trace:<trace id>` | `regression` |
| A spec item the agent cannot do yet | `spec:<slug>` | `capability` |
| A failure mode with a grader but no task | `trace:<an example trace id>` from the mode's `examples` | `regression`, or `quality` if only a judge can see it |
| Generated input (from `generate-synthetic-data`) | `synthetic:<slug>` | any |

Read the inputs first: the failure mode file under `evals/failure_modes/`, the trace under `evals/datasets/traces/`, the spec section, and two or three existing tasks in the same suite so the new one matches their shape. Ask the user which suite if it is not obvious. A capability task may be written before the agent can pass it; that is the point of capability.

## Phase 2: Write the task file

Path: `evals/tasks/<suite>/<id>.yaml`. The `id` is `snake_case` and must equal the file name. The schema is `task` in `docs/SCHEMAS.md`. A real one, trimmed, from `examples/support-agent`:

```yaml
id: duplicate_charge_frustrated
suite: regression
source: trace:tr_0033
description: frustrated customer, duplicate charge.
input: { persona: frustrated, from: maya@okafor.dev, message: "I was charged TWICE on October 1st..." }
reference_solution: refs/duplicate_charge_frustrated.json
checks:
  - { id: end_state, type: outcome, backend: sql, weight: 3,
      expect: { refunds.status: processed, refunds.amount_cents: 1999, confirmations.sent: 1 } }
  - { id: identity_first, type: code, fn: graders/code/identity_verified_first.py, weight: 2, failure_mode: identity_leak }
  - { id: bounded, type: transcript, path_check: true, max_toolcalls: 6, required_tools: [verify_identity], failure_mode: over_searching }
  - { id: tone, type: judge, failure_mode: tone_mismatch, weight: 1 }
covers: [process_refund, send_confirmation]
```

Rules for the checks:

- Every check is binary. The task reports strict pass (all checks) and a weighted score; `weight` sets the partial credit.
- Code and outcome checks first. If the agent changes things, an `outcome` check on the real end state is the main check. "It said it refunded" is not a refund.
- `code` checks point at `graders/code/<name>.py` exposing `check(trial: dict, args: dict) -> bool`. Reuse an existing one when it fits; otherwise use `write-code-eval` or `litmustest draft-check <failure_mode>`.
- `transcript` checks grade the path, not the result. They must say `path_check: true`, and they are off by default in capability suites.
- A `judge` check only for what code cannot see. One failure mode per judge. If the judge is not `trusted`, say so: its verdict will not count until `litmustest calibrate` trusts it.
- Failure modes are tags on checks: set `failure_mode:` on each check that catches one. The name must exist under `evals/failure_modes/`. This is what feeds the failure-mode deltas in `compare` and the risk map in coverage.
- `covers:` lists what the task covers for `litmustest coverage`: spec ids (`SYS-LOOP-03`), routes (`"POST /api/play/join"`) or tool names. `source: spec:<id>` already counts for its own id.

Leave `trials` out unless the task needs a different count from `runs.trials` in `litmustest.yaml`.

## Phase 3: Write the reference solution

Path: `evals/refs/<id>.json`. It is a known-good trial in exactly the shape the runner grades (`reference_solution` in `docs/SCHEMAS.md`): `task`, `output`, `state`, `tool_calls`, `transcript`, and a `note` saying why it is right.

- `state` is keyed the way `expect` paths address it: `refunds.status` reads `state.refunds.status`.
- For a promoted trace, start from what the agent should have done, not what it did. Keep real ids and amounts from the trace.
- If a real passing trial exists in the local store (`.litmustest/transcripts/<run>/<task>/<n>/trial.json`), it is a good starting point. Copy it, do not move it.
- Do not invent tool results the tool could not return. If you are unsure what the tool returns, read the agent's tool code or ask.

## Phase 4: Add it to a suite and validate

If the suite file under `evals/suites/` lists `tasks:`, add the id. If it uses `include:` globs, check the path matches. Then:

```bash
litmustest validate --deep
```

`--deep` runs every code, outcome and transcript check on the reference solution. It does not run judges. The reference must pass every check before the task can join a suite. If a check fails on the reference, either the reference is wrong or the check is; fix the one that is wrong and say which. Never weaken a check just to make the reference pass without telling the user.

Then a run on the reference only, which grades refs instead of calling the agent:

```bash
litmustest run --task <id> --dry-run --id dryrun_<id>
litmustest coverage --gaps 10
```

The dry run writes `evals/runs/dryrun_<id>.json`. Tell the user to discard it from the Pending changes tray; it is not a real run. Read the coverage output and say which items the new task moved.

## Phase 5: Present and stop

Show the diff of every file you wrote: the task, the ref, the suite list. Point out anything a person must confirm: that the task is unambiguous (two experts would agree on the reference), the suite choice, and any judge check that is not trusted yet. Then stop. The user commits from the tray or with git.

## What you never do

- Commit, push, or switch branches.
- Edit `calibration.json`, labels, or anything under `datasets/`.
- Put a task in a suite when its reference fails `validate --deep`.
- Copy few-shot or calibration traces into a task input. That leaks the test set into the suite.
