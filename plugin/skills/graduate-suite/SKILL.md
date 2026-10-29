---
name: graduate-suite
description: Keep the litmustest suites healthy. Find capability tasks that are saturated, propose graduating them to regression with `litmustest graduate`, apply the move with `--apply` so it lands as pending changes, and read `litmustest doctor` for saturation, broken and flaky tasks and stale judges. Use after a few runs, when doctor reports saturation or graduation candidates, or when the capability suite is above 90% and no longer tells you anything.
---

# Graduate a suite

Capability tasks are the hill to climb. When the agent passes one every time, it stops measuring progress and starts guarding behaviour, which is the regression suite's job. This skill moves those tasks and says what to write next. The output is a set of uncommitted changes to task and suite files. A person commits them.

Three rules from `CLAUDE.md` bind you:

1. `evals/` in git is the source of truth. A graduation is a change to three files: the task and two suite lists.
2. You propose, people decide. `--apply` saves the move as pending changes on the branch. Never commit, never push.
3. No judge counts until it is calibrated. A task whose only passing evidence came from checks that were excluded (untrusted judges) has not earned graduation; check before you apply.

## Progress updates

Say what you are checking and what you found. "Reading the last 3 runs: 4 capability tasks passed every trial; capability is at 93%."

## Phase 1: Health first

```bash
litmustest doctor
```

`doctor` reads the files and prints alerts with a next step:

| Alert | Means | Do |
| --- | --- | --- |
| Judge stale / Untested judge / Below target | A judge's verdicts are not counting | `validate-evaluator` before trusting any suite that uses it |
| Broken task | Fails every trial across runs while its reference passes | Fix the task (`define-task`) before anything else |
| Flaky task | Passes some trials and fails others with nothing changed | Read its trials (`triage-failures`); never graduate it |
| Saturating | A capability suite is above 90% in the latest run | Graduate, then write harder tasks |
| Graduation | Capability tasks passed every trial for 3 runs | This skill |
| Review queue | Traces with no label | `error-discovery` |

Report the alerts before you move anything. A saturated suite with a stale judge may only look saturated.

## Phase 2: Find candidates

```bash
litmustest graduate                 # last 3 runs that include each task
litmustest graduate --runs 5 --json
```

A capability task is proposed when it passed every scored trial in each of the last N runs that included it (infra errors are left out). The output lists each task, `capability -> regression`, and the trial count, plus a saturation line per capability suite above 90%.

Check each candidate before applying:

- **Which runs counted.** `--json` lists `runs_considered`. Dry runs (`--dry-run` grades the reference, which always passes) and one-trial smoke runs count as runs if their summaries are still under `evals/runs/`. If one is in the window, say so; the evidence is weaker than it looks.
- **Excluded judges.** Read `excluded_checks` on the candidate's trials. If the task's judge checks were all excluded, it passed on its code and outcome checks only.
- **Path checks.** Capability suites usually have `path_checks: false`; regression has them on. A graduated task's `transcript` checks start counting. Look at its trials for those checks; a task that passes in capability can fail in regression on its path.
- **Flaky.** Never graduate a task `doctor` marks flaky.

Present the list with your view on each. The user picks.

## Phase 3: Apply

```bash
litmustest graduate --apply
```

`--apply` moves every proposed task in one validated change per task (`App.putFiles`): the task's `suite` becomes `regression` and it gets `graduated_from: capability`; the id leaves the capability suite's `tasks:` list and joins regression's. The files are validated together and revert together if any is refused. The task file stays at its path under `tasks/capability/`; only its `suite` changes. If a suite uses `include:` globs instead of a `tasks:` list, check that the moved task is matched by the right suite and not both.

`--apply` takes every proposal. If the user wants only some, do the same three edits by hand for those tasks (task `suite` and `graduated_from`, both suite lists), then:

```bash
litmustest validate --deep
```

Show the diff. The changes are in the Pending changes tray at `http://127.0.0.1:4242` if `litmustest serve` is running, or in `git diff`.

## Phase 4: Refill the hill

Graduation shrinks capability. If it drops below roughly 20 tasks, or what is left is all near 100%, the suite has stopped measuring anything. Say so, and propose harder tasks: from the spec items with no task (`litmustest coverage --gaps 10`), from failure modes with no capability task, or from flips in recent compares. Hand off to `define-task`. A capability task should be one the agent cannot pass yet.

## Phase 5: Report and stop

Report: the tasks moved, the ones held back and why, the capability suite's size and last pass rate after the move, and the next tasks to write. Then stop. The user commits.

## What you never do

- Graduate a flaky or likely broken task, or one whose only passing checks were excluded.
- Lower a gate or a threshold to make a suite look healthy.
- Delete a task to clear a saturation alert. Graduate it.
- Delete run summaries. If a dry run is skewing graduation, tell the user to discard it from the tray.
- Commit, push, or switch branches.
