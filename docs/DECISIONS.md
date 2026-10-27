# Decision Memos

As of 2026-10-27. Six decisions block the build. Target: all decided by 2026-11-03. Record the outcome at the bottom of each memo.

| # | Decision | Recommendation | Blocks | Status |
| --- | --- | --- | --- | --- |
| 1 | The name | **Renamed to `litmustest`.** | Package/repo names, wordmark, CLAUDE.md | Decided 2026-10-27 |
| 2 | The runner | **Wrap, don't build.** Harbor for containers; pluggable storage. | Phase 3 architecture | Open |
| 3 | Trace format | **OpenTelemetry GenAI conventions** internally; JSONL adapter. | Phase 1 ingest | Open |
| 4 | License and credit | **Keep Apache 2.0**; credit the course. | Phase 1 release | Decided 2026-10-27 |
| 5 | Target agents | **Claude Code first**; Codex untested until Phase 2. | Test matrix | Open |
| 6 | Run storage | **Summaries in git, transcripts local**, optional object store. | Phase 3 runner, CI | Open |

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

**Outcome:** _pending_

## 3. Trace format

**Recommendation: OpenTelemetry GenAI semantic conventions as the internal shape**, one JSON object per trace, plus a JSONL adapter for plain logs.

| Option | For | Against |
| --- | --- | --- |
| Our own schema | Exact fit; small | Every platform needs a hand-written adapter |
| OTel GenAI conventions | Emitted/importable by Langfuse, Braintrust, LangSmith, Arize, most SDKs; tool calls, tokens, latency native | Verbose; turns are spread across spans |
| A platform's native export | Rich | Vendor-tied |

We add one derived, never-stored view: an ordered list of turns and tool calls, which the review queue and transcript page render and judges receive. Labels reference trace ids, so a change to the view never invalidates them.

JSONL adapter (Phase 1): each line has at least `id`, `input`, `output`; optionally `messages`, `tool_calls`. Warns about what it could not fill.

- [ ] Confirm the conventions cover tool results and multi-turn user simulation
- [ ] Write the JSONL adapter spec with the schemas

**Outcome:** _pending_

## 4. License and credit

**Recommendation: release under Apache 2.0 and credit the course plainly.**

Upstream ai-evals-course/evals-skills is Apache 2.0 (checked 27 Oct 2026). We may copy, modify and redistribute, including commercially, if we keep the license and notices, mark modified files, and carry any NOTICE file.

- Modified skill files carry: "Modified from ai-evals-course/evals-skills (Apache 2.0)".
- Keep upstream LICENSE; add our copyright line.
- Anthropic's guidance is cited prose, not copied code.

Positioning: "Built on the evals-skills course method and Anthropic's agent-eval guidance." True, free, and the course community is the first user base we want.

If the organization prefers a different license for the dashboard, the bundled skills stay Apache 2.0 and the README states the mix.

- [x] Confirm Apache 2.0 with whoever owns licensing
- [ ] Add headers to modified skills in Phase 1

**Outcome:** Apache 2.0 confirmed 2026-10-27. LICENSE file at the repo root.

## 5. Which coding agents to target

**Recommendation: Claude Code first. Keep the Codex manifest the fork ships, mark it "untested", test in Phase 2.**

The fork carries `.claude-plugin`, `.codex-plugin` and `.agents/plugins`. The skills are Markdown and run anywhere; what differs is invocation, shell execution and how a diff is proposed. Phase 1–2 change the skills weekly; testing two agents while they move is waste. By Phase 2 a second agent is a week, not a running cost.

- [ ] Decide
- [ ] Add "Codex: untested" to the README until Phase 2

**Outcome:** _pending_

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

**Outcome:** _pending_
