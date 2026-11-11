---
name: build-environment
description: Connect a product's agent to the litmustest runner. Set agent.command in evals/litmustest.yaml, write the small trial script that honours the trial-directory contract (runs once per trial in a fresh directory, leaves trial.json in the reference-solution shape with the end state in `state`), and verify it with `litmustest run --dry-run` and then a one-trial run. Use when tasks exist but `litmustest run` has nothing to call, or when trials come back as infra errors.
---

# Build the environment

You are wiring the team's agent into the runner so that `litmustest run` can call it once per trial and grade what it did. The output of this skill is an `agent:` block in `evals/litmustest.yaml` and, usually, a small trial script in the product repo. Both stay uncommitted. A person commits them.

Three rules from `CLAUDE.md` bind you:

1. `evals/` in git is the source of truth. The runner reads `agent.command` from `litmustest.yaml` and nothing else.
2. You propose, people decide. Never commit, never push. Credentials and sandboxes are human-only: ask the user to set keys in their environment; never write a key into a file.
3. No judge counts until it is calibrated. A clean environment does not change that; untrusted judges stay excluded.

## Progress updates

Say what you are about to change before each phase and what happened after it. "Writing scripts/run_trial.ts; it copies the seed database into the trial directory." "Dry run: 40 references graded, 0 infra errors."

## What exists today

- `runs.environment: inprocess` is the only environment implemented. The runner refuses `harbor` and `docker` with "not implemented yet (decision #2)". Say so if the user asks for containers. `examples/support-agent/environments/harbor/` is an untested Harbor task kept for when that lands.
- "In process" means the runner spawns `agent.command` as a child process on this machine, once per trial. Isolation is your script's job: each trial gets a fresh directory, and the script must build its state (a database copy, a temp workspace) inside it.

## The trial contract

For each trial the runner:

1. Creates an empty directory `<transcripts path>/<run id>/<task id>/<n>/`.
2. Runs `agent.reset` if set (to reset external state), then `agent.command`. Both are split on spaces (quotes respected) and run **without a shell**: no pipes, no `&&`, no `$VAR` expansion.
3. Fills these placeholders in the command: `{task}`, `{task_file}`, `{trial_dir}`, `{trial}`, `{evals}`. It also sets `LITMUSTEST_TASK`, `LITMUSTEST_TASK_FILE`, `LITMUSTEST_TRIAL_DIR`, `LITMUSTEST_TRIAL`, `LITMUSTEST_INPUT` (the task's `input` as JSON), `LITMUSTEST_EVALS` and `LITMUSTEST_RUN`, plus anything in `agent.env`.
4. Waits up to `runs.resources.timeout_s`, then kills it.
5. Reads `<trial_dir>/trial.json` and grades it.

The script must leave `trial.json` in the `reference_solution` shape (`docs/SCHEMAS.md`): `output`, `state`, `tool_calls`, `transcript`, and ideally `usage` and `latency_ms`. `state` is the end-state snapshot outcome checks read, keyed the way `expect` paths address it (`refunds.status` reads `state.refunds.status`). The runner does not read your database itself: the script takes the snapshot after the agent finishes and writes it into `state`. The outcome check's `backend` field does not change this today.

Any of these is an infra error, excluded from the agent's score and reported separately: a timeout, a non-zero exit (classified `oom`, `network` or `harness` from stderr), no `trial.json`, or a `trial.json` that does not validate. stdout and stderr are kept next to it as `stdout.txt` and `stderr.txt`.

## Phase 1: Read what is there

Read `evals/litmustest.yaml`, two tasks and their refs, and the product's entry point. Find out how the agent is called, what state it changes (a database, files, an HTTP service), and how to get a clean copy of that state. The reference implementation is `examples/support-agent/src/run_trial.ts`: it reads the task, copies `environments/seed.sqlite` into the trial directory, runs the agent, and writes `trial.json` with `state: snapshot(db)`.

## Phase 2: Write the trial script

Keep it small and in the product repo, not under `evals/`. It should:

- Take the task id and trial directory from `--task {task} --trial-dir {trial_dir}` or from the environment variables.
- Build fresh state inside the trial directory. Never point a trial at a shared or production database.
- Run the agent once on the task's `input`.
- Snapshot the end state into `state` with the same keys the tasks' `expect` blocks use. Read two tasks' `expect` to get them right.
- Write `trial.json` and exit 0. Exit non-zero only when the harness itself broke, so infra errors stay infra errors.

Then set the config:

```yaml
runs:
  environment: inprocess
  resources: { timeout_s: 180 }
agent:
  command: node scripts/run_trial.ts --task {task} --trial-dir {trial_dir}
  cwd: .            # relative to the directory that holds evals/
  # reset: ./scripts/reset_sandbox.sh {trial_dir}
  # env: { AGENT_MODE: eval }
```

## Phase 3: Verify, cheapest first

```bash
litmustest validate --deep
litmustest run --dry-run --id dryrun_env
```

`--dry-run` grades every reference solution instead of calling the agent. It proves the checks, the refs and the grading path work before any model is called. Every task should pass; one that fails is a task problem, not an environment problem (use `define-task`). The dry run writes `evals/runs/dryrun_env.json`; tell the user to discard it from the Pending changes tray.

Then one real trial on one task:

```bash
litmustest run --task <id> --trials 1 --id smoke_env
```

Open `<transcripts path>/smoke_env/<id>/1/` and check `trial.json` by hand: `state` has the keys the outcome checks read, `tool_calls` and `transcript` are filled, `usage` is there. If it is an infra error, read `stderr.txt` and fix the script. When it is clean, run one task per suite with `--trials 1`. Tell the user to discard the smoke runs too: they are not baselines, and a one-trial run can mislead `graduate`.

Only then hand off for a full run (`litmustest run`, 5 trials per task by default). Say what it will cost if `runs.budget_usd` is set.

## Phase 4: Report and stop

Report what you changed (config, script), the dry-run result, the smoke-trial result, and any task whose reference failed. Show the diff and stop. The user commits.

## What you never do

- Commit, push, or switch branches.
- Write credentials into `litmustest.yaml`, the script, or anything in git.
- Mark a failure as infra to hide it, or make the script exit 0 when the harness broke.
- Point trials at shared or production state.
- Claim containers work. `harbor` and `docker` are not implemented.
