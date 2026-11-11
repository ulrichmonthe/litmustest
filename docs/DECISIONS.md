# Decision Memos

As of 2026-11-11. All six are recorded. #2, #3, #5 and #6 were decided by what v0.1 ships, not by the evidence their checklists ask for; each outcome says what is still owed. Record the outcome at the bottom of each memo.

| # | Decision | Recommendation | Blocks | Status |
| --- | --- | --- | --- | --- |
| 1 | The name | **Renamed to `litmustest`.** | Package/repo names, wordmark, CLAUDE.md | Decided 2026-10-27 |
| 2 | The runner | **Wrap, don't build.** Harbor for containers; pluggable storage. | Phase 3 architecture | Decided 2026-11-11 on paper: inprocess, docker and a Harbor wrapper; a real container run is owed |
| 3 | Trace format | **OpenTelemetry GenAI conventions** internally; JSONL adapter. | Phase 1 ingest | Decided 2026-10-29 |
| 4 | License and credit | **Keep Apache 2.0**; credit the course. | Phase 1 release | Decided 2026-10-27 |
| 5 | Target agents | **Claude Code first**; Codex untested until Phase 2. | Test matrix | Decided 2026-10-29 |
| 6 | Run storage | **Summaries in git, transcripts local**, optional object store. | Phase 3 runner, CI | Decided 2026-11-11: five backends behind one interface; CI uploads a build artifact by default |

## 1. The name

**Recommendation: rename before publishing anything.**

The working name `evalkit` was checked 27 Oct 2026:
- npm `evalkit`: existing package by Walid Khori, MIT, keywords "ai, agent, evals, evaluation, testing". Same category as ours, which makes the collision worse.
- PyPI `evalkit`: "EVolutionary ALgorithms KITs", last released May 2021. Unrelated, dormant, blocks the Python name.
- GitHub: several repos use the name. Trademarks not checked.

| Option | For | Against |
| --- | --- | --- |
| Keep `evalkit`, scope the packages (`@org/evalkit`) | No rebrand | Bare npm name is a competitor; CLI command collides; confusing in search |
| Rename now | Clean namespace; logo wordmark is one word | A day of edits |
| Rename later | Nothing now | Every artifact, manifest and user's muscle memory changes |

Shortlist (each needs npm / PyPI / GitHub / domain checks): `verdict` (first pick), `passmark` (second), `trialrun`, `calibrate`, `errorbar`. All keep the logo as drawn.

Blocks: CLAUDE.md, package and repo names, plugin manifest, wordmark.

- [x] Run the four checks on the shortlist
- [x] Pick one
- [x] Update spec, guide, comparison, brand, logo canvas

**Outcome:** Renamed to **litmustest** on 2026-10-27. Checked that day: `litmustest` is free on npm and PyPI; GitHub has only empty hobby repos of that name. Adjacent `litmus-test` exists on both registries (unrelated: a dead 2022 Node CLI and a hardware test platform), so the README spells the install name without a hyphen. Trademarks not checked. Wordmark: `litmus` in ink, `test` in blue, lowercase. The Claude artifacts (spec doc, guide, comparison page, logo and brand canvases) still carry the old name and are updated separately.

## 2. The runner

**Recommendation: wrap, don't build.** Own schemas, graders, calibration, statistics, suites, dashboard and CLI. Delegate containerized execution to Harbor (https://harborframework.com/). Make run storage a pluggable backend (local, object store, Braintrust/Langfuse/LangSmith).

Context: Anthropic describes a harness and points to frameworks rather than building one. The course has no runner. A runner is the largest, least differentiated piece of engineering in the plan.

| Option | What we own | Time to Phase 3 | Risk |
| --- | --- | --- | --- |
| Build our own | Everything | 6–10 weeks before the first agent eval runs | Infra noise is hard (6-pt swing from resource limits in Anthropic's study) |
| Wrap Harbor, pluggable storage | Methodology layer + dashboard + CLI | Shortest | Young dependency; need a small in-process executor for API-call agents |
| Build on one platform end to end | Dashboard + methodology | Short, but vendor lock-in | Conflicts with files-in-git as source of truth |

Confirm before committing: Harbor's task format can carry our checks (or map at run time); its license allows embedding; it runs on a laptop without a cloud account.

- [ ] Lead engineer runs one sample task through Harbor (half a day)
- [ ] Decide on that evidence

**Outcome:** Decided 2026-11-11, on paper. The runner has an `Environment` seam (`packages/cli/src/environments.ts`) with three implementations. The earlier interim outcome (2026-10-29, in-process only) is replaced.

- `inprocess`: `agent.command` as a child process in its own process group, so a timeout kills the whole tree.
- `docker`: `docker run --rm` per trial, trial directory at `/trial`, `evals/` read-only at `/evals`, `--cpus` and `--memory` from `runs.resources`, `docker kill` on timeout. Config under `runs.docker`.
- `harbor`: a wrapper, not a rebuild. The spike was done by reading Harbor's source (`harbor-framework/harbor`, `main`, 2026-11-11), not by running it. What it found:
  - A Harbor task is a directory (`task.toml` with `schema_version = "1.4"`, `instruction.md`, `environment/`, `solution/solve.sh`, `tests/test.sh`). Its built-in `oracle` agent uploads `solution/` and runs `solve.sh` inside the task's container. `/logs/artifacts` in the container is mounted back to `<jobs dir>/<job>/<trial>/artifacts` on the host.
  - That is enough to carry our contract (run one command, leave `trial.json`): per trial the wrapper writes a task whose `solve.sh` is the agent command with `LITMUSTEST_TRIAL_DIR=/logs/artifacts`, runs `harbor run -p <task> -a oracle -n 1 -k 1`, and copies the artifacts back into the trial directory. The task's `[environment]` carries `docker_image`, `cpus` and `memory_mb`; `[agent] timeout_sec` carries the timeout. Harbor's verifier only records whether `trial.json` exists. Our checks stay ours and are graded by litmustest, so Harbor's task format does not need to express them.
  - Harbor has no generic "run this command" agent; anything other than `oracle` needs a Python `BaseAgent` class. Using `oracle` as the command runner avoids shipping Python, at the cost of using it for something other than its stated purpose (reference solutions).
  - Harbor does not mount host directories, so `evals/` is not visible in the container: the task file rides along as `/solution/task.yaml`, and anything else must be in the image.
  - `harbor run` appears to exit 0 even when a trial fails, so the wrapper reads the trial's `result.json` (`exception_info`) and `agent/exit-code.txt` rather than the exit code.
  - License and laptop use (the other two things to confirm) were not checked beyond the default backend being local Docker.
- The example's hand-written Harbor task (`examples/support-agent/environments/harbor/`) was removed: it used keys Harbor's `task.toml` does not have (`[agent] command`, `[verifier] command`), hard-coded one task, and its test read a different path than its instruction named. The wrapper generates the task per trial instead; `examples/support-agent/environments/Dockerfile` is the image for both container environments.

Not confirmed: `docker` and `harbor` are not installed where this was built. Both environments are tested against fake binaries that record their arguments and run the command locally (`tests/environments.test.ts`). Everything said about Harbor's runtime behaviour is inferred from its source. Owed: one real trial through each (the "half a day" in the first checkbox, still unticked), and Harbor's license.

## 3. Trace format

**Recommendation: OpenTelemetry GenAI semantic conventions as the internal shape**, one JSON object per trace, plus a JSONL adapter for plain logs.

| Option | For | Against |
| --- | --- | --- |
| Our own schema | Exact fit; small | Every platform needs a hand-written adapter |
| OTel GenAI conventions | Emitted/importable by Langfuse, Braintrust, LangSmith, Arize, most SDKs; tool calls, tokens, latency native | Verbose; turns are spread across spans |
| A platform's native export | Rich | Vendor-tied |

We add one derived, never-stored view: an ordered list of turns and tool calls, which the review queue and transcript page render and judges receive. Labels reference trace ids, so a change to the view never invalidates them.

JSONL adapter (Phase 1): each line has at least `id`, `input`, `output`; optionally `messages`, `tool_calls`. Warns about what it could not fill.

- [x] Confirm the conventions cover tool results and multi-turn user simulation
- [ ] Write the JSONL adapter spec with the schemas

**Outcome:** Decided 2026-10-29, as the recommendation. `ingest` reads OpenTelemetry GenAI spans (`gen_ai.*` attributes) and plain JSONL (`id`, `input`, `output`, optional `messages`, `tool_calls`); Langfuse and Braintrust pulls map to the JSONL shape first. The review queue, the transcript page and the judges read the derived turn view (`trace_view.ts`), and labels reference trace ids. Multi-turn checked 2026-11-11 (B3): the conventions carry it once every model call's `gen_ai.input.messages` holds the conversation so far, which is what they ask for. The JSONL adapter, the example's trace builder and the trace built from a disputed trial now do that. The turn view recovers user turns by their place in that history, never by matching text, so a customer who answers "yes" twice keeps both turns; a call that follows one ending in tool calls with no text adds no user turn. Langfuse and Braintrust generations that resend the history map the same way. The example has one two-round task (`vat_invoice_followup_business`), driven by `input.simulate` in the task file. Not yet tried: a live multi-turn run of the example, which needs a model key, and recorded multi-turn payloads from a real Langfuse or Braintrust account.

## 4. License and credit

**Recommendation: release under Apache 2.0 and credit the course plainly.**

Upstream ai-evals-course/evals-skills is Apache 2.0 (checked 27 Oct 2026). We may copy, modify and redistribute, including commercially, if we keep the license and notices, mark modified files, and carry any NOTICE file.

- Modified skill files carry: "Modified from ai-evals-course/evals-skills (Apache 2.0)".
- Keep upstream LICENSE; add our copyright line.
- Anthropic's guidance is cited prose, not copied code.

Positioning: "Built on the evals-skills course method and Anthropic's agent-eval guidance." True, free, and the course community is the first user base we want.

If the organization prefers a different license for the dashboard, the bundled skills stay Apache 2.0 and the README states the mix.

- [x] Confirm Apache 2.0 with whoever owns licensing
- [x] Add headers to modified skills

**Outcome:** Apache 2.0 confirmed 2026-10-27. LICENSE file at the repo root.

## 5. Which coding agents to target

**Recommendation: Claude Code first. Keep the Codex manifest the fork ships, mark it "untested", test in Phase 2.**

The fork carries `.claude-plugin`, `.codex-plugin` and `.agents/plugins`. The skills are Markdown and run anywhere; what differs is invocation, shell execution and how a diff is proposed. Phase 1–2 change the skills weekly; testing two agents while they move is waste. By Phase 2 a second agent is a week, not a running cost.

- [ ] Decide
- [ ] Add "Codex: untested" to the README until Phase 2

**Outcome:** Decided 2026-10-29, as the recommendation. The plugin targets Claude Code. `plugin/.codex-plugin/plugin.json` ships and is untested. Codex was not tested in Phase 2 as planned; it moves to after the first public release. The README says "untested" without a phase.

## 6. Where run transcripts are stored

**Recommendation: summaries in git, raw transcripts local by default, optional object-store backend.** Not Git LFS.

| Option | For | Against |
| --- | --- | --- |
| Local, git-ignored | Zero setup; offline; first-hour simplicity | Per machine; PR links can't open them |
| Git LFS | One repo | Slow clones, quotas, 50 MB JSON in PRs |
| Object store by run id | Shareable; CI writes, anyone reads | Needs a bucket and credentials |
| Logging platform | Free for teams already there | Vendor-tied viewing |

Summaries are small and diffable: git. Transcripts are evidence, not code: a stable address. Backend is one line in `litmustest.yaml`; the transcript page reads whichever is set.

- [ ] Confirm the storage interface (write run, read trial, list runs) supports three backends
- [ ] Decide the CI default (local is useless there)

**Outcome:** Decided 2026-11-11. The interim outcome (2026-10-29, local only) is replaced.

- Summaries go in git under `evals/runs/`. Each trial's `transcript_ref` is the address in the store it was written to; its last three segments are always run, task and trial.
- The interface (`packages/cli/src/storage/`, `TranscriptStore`: `put`, `get`, `has`, `ref`) has five backends, which answers the first checkbox: `local` (a git-ignored directory, the default), `s3` and `gcs` (one object per file, signed with a SigV4 signer over `fetch`, no SDK; `gcs` through its S3-compatible XML API with HMAC keys), and `braintrust` and `langfuse` (one trace per trial tagged with run, task and trial, each file a span). `langsmith` is refused with a "not written yet" error and waits on the LangSmith adapter.
- With a remote backend the runner works in a local cache (`.litmustest/cache/transcripts/`), uploads `trial.json`, `grades.json`, `stdout.txt` and `stderr.txt` after grading, and warns (without changing a score) when an upload fails. Readers fetch what is missing once and then read the cache. Listing does not ask the store anything: a trial counts as available when its ref names a remote store. Surface coverage counts calls from the transcripts that are on the machine.
- Credentials come from the environment only, never from `litmustest.yaml`.
- **CI default:** `litmustest ci --write-workflow` reads the backend. With `local` (the default) the workflow uploads the transcript directory as a build artifact, `litmustest-transcripts`, kept 14 days, and the PR comment lists each broken or newly flaky task with its path inside that artifact and a link to the run's artifacts. With a remote backend the workflow passes that backend's credentials from repository secrets and the comment links to the object or trace. A build artifact was chosen over requiring a bucket because it needs no setup and no secret; it expires, so a team that needs transcripts for longer sets a remote backend.

Not confirmed: there are no cloud credentials or CLIs where this was built. `s3`, `gcs`, `braintrust` and `langfuse` are tested against in-memory fakes of each service's HTTP surface. The SigV4 signer reproduces the three example signatures AWS publishes in the S3 API reference, which is real evidence for S3; the GCS, Braintrust (`/v1/project_logs/{id}/insert`, `/btql`) and Langfuse (`/api/public/ingestion`, `/api/public/traces/{id}`) request shapes follow their public documentation and have not met a live account. The generated workflow has not run in GitHub Actions. Owed: one real run against each remote backend, and one CI run of the workflow.
