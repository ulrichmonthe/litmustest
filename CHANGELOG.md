# Changelog

The `litmustest` CLI (npm) and the plugin (Claude Code; the Codex manifest ships untested) share one version.

## 0.2.0 (2026-11-21)

The CLI is published on npm as **`@concertedlabs/litmustest`**: `npm install -g @concertedlabs/litmustest`. The command it installs is still `litmustest`, and so is the plugin's name. (The unscoped name `litmustest` was refused by npm as too close to an existing package.)

### The dashboard, redesigned around jobs
- One ranked **Home**: the verdict as a sentence built from the run files, every suite's gate as a margin bar, and an **Up next** list ranked by fixed rules (what blocks the merge, what keeps the numbers honest, what improves the evals).
- **Ship**: two runs compared on the same tasks, the tasks that changed as trial dots, the selected task's checks, and **Decide**, one reply at a time, for tasks that broke only on a judge.
- **Teach**: a four-step rail (label, group notes, failure modes, trust judges); group notes with Claude or by hand; a rebuilt judges list and a New judge screen.
- **Cover**: the high-severity gaps first, the coverage maps, a coverage setup screen, tasks and suites.
- **Library**: run history with a trend and two-run compare; every trial; settings.
- A new shell (sidebar, one sheet, a bottom bar on phones), routes by place with old links redirecting, ⌘K search, error states and a lost-connection banner.

### New behaviour
- Promote a trace to a task (now to the **capability** suite by default), mark a flip expected, post a comparison to the pull request.
- Every rate carries its interval and every number links to what it counts; coverage gains traffic, code and frontend maps.
- Runner environments (in-process, Docker, Harbor) and outcome readers (SQL, files, HTTP); transcript storage on local disk, S3, GCS, Braintrust or Langfuse; multi-turn traces.
- Every dashboard write has a CLI command, including the new `litmustest mode add-notes` and `litmustest dispute … skip`.
- Hosted mode: GitHub App sign-in, every save a commit on a pull-request branch (built, not deployed).

### Fixed
- `litmustest serve` no longer crashes in a repository with no commits yet (`git init`, `litmustest init`, `litmustest serve`). The dashboard opens on its first-run screen, and the first commit from Pending changes becomes the repository's first commit.

### Tested only against fakes
Docker, Harbor, S3, GCS, Braintrust, Langfuse, the GitHub App and hosted mode, Codex, and the model-backed steps.

## 0.1.0

The first version: schemas, the validator, the runner, judges and calibration, the dashboard, and the sample repository.
