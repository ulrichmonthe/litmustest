# Environments

Every trial starts from a clean copy of `seed.sqlite`: `freshDb(trialDir)` in `src/db.ts` copies the seed into the trial's directory and opens it. Nothing is shared between trials. The copy, `support.sqlite`, stays in the trial directory, which is how two tasks (`duplicate_charge_business`, `pro_refund_in_window_business`) have the runner read the end state itself with `read:` queries instead of trusting the snapshot in `trial.json`.

Where the trial's command runs is `runs.environment` in `evals/litmustest.yaml`:

- **`inprocess`** (the default, and what the example ships with): a child process on this machine.
- **`docker`**: a fresh container per trial, with the trial directory mounted at `/trial` and `evals/` at `/evals`.
- **`harbor`**: a one-trial [Harbor](https://harborframework.com) job per trial; Harbor's oracle agent runs the command, and the trial directory is `/logs/artifacts`.

`Dockerfile` here builds one image for both container environments:

```bash
docker build -f environments/Dockerfile -t support-agent:latest .
```

```yaml
runs:
  environment: docker        # or harbor
  resources: { cpus: 1, memory_mb: 1024, timeout_s: 180 }
  docker: { image: "support-agent:latest", workdir: /app, pass_env: [ANTHROPIC_API_KEY] }
  harbor: { image: "support-agent:latest", workdir: /app, pass_env: [ANTHROPIC_API_KEY] }
agent:
  command: node src/run_trial.ts --task {task} --trial-dir {trial_dir}
```

**Not run for real.** Neither `docker` nor `harbor` was installed where these environments were written. Both are tested against fake binaries that record their arguments (`tests/environments.test.ts`), and the Harbor wrapper follows Harbor's source as read on 2026-11-11 (`docs/DECISIONS.md` #2). The image above has not been built. The first real run is still owed.

Regenerate the seed with `npm run seed-db` after changing `src/catalog.ts`.
