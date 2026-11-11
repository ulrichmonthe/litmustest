---
name: build-environment
description: Connect a product's agent to the litmustest runner. Set agent.command in evals/litmustest.yaml, write the small trial script that honours the trial-directory contract (runs once per trial in a fresh directory, leaves trial.json in the reference-solution shape with the end state in `state`), and verify it with `litmustest run --dry-run` and then a one-trial run. Use when tasks exist but `litmustest run` has nothing to call, or when trials come back as infra errors.
---

# Build the environment

You are wiring the team's agent into the runner so that `litmustest run` can call it once per trial and grade what it did. The output of this skill is an `agent:` block in `evals/litmustest.yaml` and, usually, a small trial script in the product repo. Both stay uncommitted. A person commits them.

**Where the evals directory is.** The commands here are written for `evals/` at the repository root. Find the directory that holds `litmustest.yaml` first. If it is somewhere else (the sample repo keeps it at `examples/support-agent/evals`), add `--dir <evals dir>` to every `litmustest` command and read the `evals/...` paths below as inside that directory. A command pointed at a directory that is not there fails; it never reports a clean result. `litmustest <command> --help` prints that command's flags.

Three rules from `CLAUDE.md` bind you:

1. `evals/` in git is the source of truth. The runner reads `agent.command` from `litmustest.yaml` and nothing else.
2. You propose, people decide. Never commit, never push. Credentials and sandboxes are human-only: ask the user to set keys in their environment; never write a key into a file.
3. No judge counts until it is calibrated. A clean environment does not change that; untrusted judges stay excluded.

## Progress updates

Say what you are about to change before each phase and what happened after it. "Writing scripts/run_trial.ts; it copies the seed database into the trial directory." "Dry run: 40 references graded, 0 infra errors."

## What exists today

- `runs.environment` picks where the trial's command runs. `inprocess` (the default) spawns `agent.command` as a child process on this machine. `docker` runs it in a fresh container per trial. `harbor` hands it to the Harbor CLI as a one-trial job.
- In process, isolation is your script's job: each trial gets a fresh directory, and the script must build its state (a database copy, a temp workspace) inside it. On timeout the runner kills the whole process group, so helpers the script started die with it.
- `docker` and `harbor` are tested against fake binaries only; neither had been run against the real tool when this skill was written. Say so when you set one up, and prove it with one smoke trial (Phase 3) before anything else.

## The trial contract

For each trial the runner:

1. Creates an empty directory `<transcripts path>/<run id>/<task id>/<n>/`.
2. Runs `agent.reset` if set (to reset external state), then `agent.command`. In process both are split on spaces (quotes respected) and run **without a shell**: no pipes, no `&&`, no `$VAR` expansion. Under `docker` and `harbor` the command line goes to `sh` inside the container.
3. Fills these placeholders in the command: `{task}`, `{task_file}`, `{trial_dir}`, `{trial}`, `{evals}`. It also sets `LITMUSTEST_TASK`, `LITMUSTEST_TASK_FILE`, `LITMUSTEST_TRIAL_DIR`, `LITMUSTEST_TRIAL`, `LITMUSTEST_INPUT` (the task's `input` as JSON), `LITMUSTEST_EVALS` and `LITMUSTEST_RUN`, plus anything in `agent.env`.
4. Waits up to `runs.resources.timeout_s`, then kills it (the process group in process, `docker kill` for a container).
5. Reads `<trial_dir>/trial.json` and grades it.

The script must leave `trial.json` in the `reference_solution` shape (`docs/SCHEMAS.md` in the litmustest repository): `output`, `state`, `tool_calls`, `transcript`, and ideally `usage` and `latency_ms`. `state` is the end-state snapshot, keyed the way `expect` paths address it (`refunds.status` reads `state.refunds.status`).

### Who reads the end state

An outcome check without `read` compares `expect` against `trial.state`: the script takes the snapshot after the agent finishes and the runner trusts it. An outcome check with `read` has the runner read the state itself after the trial, so a script cannot report a state that is not there:

```yaml
- id: end_state
  type: outcome
  backend: sql
  read:
    file: support.sqlite            # in the trial directory, opened read-only
    queries:                        # one SELECT per expect key; first column of the first row
      refunds.status: SELECT COALESCE((SELECT status FROM refunds ORDER BY id DESC LIMIT 1), 'none')
      confirmations.sent: SELECT COUNT(*) FROM confirmations
  expect: { refunds.status: processed, confirmations.sent: 1 }
```

- `backend: sql`: `read.file` and `read.queries`. Needs Node 22.13 or later (`node:sqlite`).
- `backend: fs`: `read: { file: out/result.json }` (the parsed JSON is the state) or `read: { exists: [out/report.md] }` (then `expect: { "exists[0]": true }`).
- `backend: http`: `read: { url, method, headers }`; the JSON response is the state. `{trial_dir}`, `{task}`, `{trial}` and `${ENV_NAME}` are filled. A service that cannot be reached is an infra error, not a failed check.
- `backend: page` has no reader; it always uses `trial.state`.

For sql and fs the script must leave the file in the trial directory. Keep writing `state` in `trial.json` as well: `validate --deep` and `run --dry-run` have no trial directory and compare the check against the reference solution's `state`. Prefer `read` wherever the state is a file or a service the runner can reach; propose it as a diff to the task, the same as any other check edit.

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
  concurrency: 4          # the default
  budget_usd: 10          # optional: stop starting trials once recorded cost reaches this
  resources: { timeout_s: 180 }
agent:
  command: node scripts/run_trial.ts --task {task} --trial-dir {trial_dir}
  cwd: .            # relative to the directory that holds evals/
  # reset: ./scripts/reset_sandbox.sh {trial_dir}
  # env: { AGENT_MODE: eval }
```

For a clean container per trial instead, the command runs inside the image, the trial directory is `/trial` and `evals/` is mounted read-only at `/evals` (the placeholders are filled with those paths):

```yaml
runs:
  environment: docker
  resources: { cpus: 1, memory_mb: 1024, timeout_s: 180 }   # --cpus and --memory; not enforced in process
  docker:
    image: my-agent:latest            # or build: { context: ., dockerfile: Dockerfile }
    workdir: /app
    pass_env: [ANTHROPIC_API_KEY]     # names only; the value comes from the environment at run time
```

`environment: harbor` takes `harbor: { image, workdir, pass_env }` the same way. There the trial directory is `/logs/artifacts`, the task file is `/solution/task.yaml`, and the rest of `evals/` is not mounted: bake what the command needs into the image. A missing `docker` or `harbor` binary stops the run with one error before any trial.

## Phase 3: Verify, cheapest first

```bash
litmustest validate --deep
litmustest run --dry-run --id dryrun_env
```

`--dry-run` grades every reference solution instead of calling the agent. It proves the checks, the refs and the grading path work before any model is called. Every code, outcome and transcript check should pass; one that fails is a task problem, not an environment problem (use `define-task`). The dry run still asks the judges: without a model key they answer Unknown and every task with a judge check shows strict pass 0%, so read `failed_checks` and `grades.json`, not the headline. The dry run writes `evals/runs/dryrun_env.json`; tell the user to discard it from the Pending changes tray.

A missing model key in a real trial shows up as an infra error tagged `network`; read `stderr.txt` before blaming the network. Transcripts live under `storage.transcripts.path`, which is relative to the parent of the evals directory.

**Auditing an environment that already exists.** Check three things. Each trial works on its own copy of the data under `{trial_dir}`. Anything the script generates on first use (a seed database) exists before trials run in parallel. And the `state` snapshot the script writes holds everything the outcome checks need to tell a right end state from a wrong one: which record changed, not only that one did.

Then one real trial on one task:

```bash
litmustest run --task <id> --trials 1 --id smoke_env
```

Open `<transcripts path>/smoke_env/<id>/1/` and check `trial.json` by hand: `state` has the keys the outcome checks read, `tool_calls` and `transcript` are filled, `usage` is there. If it is an infra error, read `stderr.txt` and fix the script. When it is clean, run one task per suite with `--trials 1`. Tell the user to discard the smoke runs too: they are not baselines, and a one-trial run can mislead `graduate`.

Only then hand off for a full run (`litmustest run`, 5 trials per task by default). If `runs.budget_usd` is set, say so: the runner stops starting trials once the cost recorded in `usage.cost_usd` reaches it, and the run summary lists what was skipped under `budget`. A script that does not report `usage.cost_usd` spends nothing as far as the budget can tell.

## Phase 4: Report and stop

Report what you changed (config, script), the dry-run result, the smoke-trial result, and any task whose reference failed. Show the diff and stop. The user commits.

## What you never do

- Commit, push, or switch branches.
- Write credentials into `litmustest.yaml`, the script, or anything in git.
- Mark a failure as infra to hide it, or make the script exit 0 when the harness broke.
- Point trials at shared or production state.
- Claim a container environment works before a smoke trial has run in it. `docker` and `harbor` were tested against fakes only.
