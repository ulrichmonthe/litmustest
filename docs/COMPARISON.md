# Feature comparison: evals-skills vs Anthropic docs vs the plugin

As of 2026-10-27. ✓ you get it · ~ partly or advice only · – not covered · ◆ planned in the plugin (design target, not shipped). Totals count ✓ only: evals-skills 13/30, Anthropic docs 10/30, plugin 30/30 planned.

| Capability | evals-skills | Anthropic docs | Plugin |
| --- | --- | --- | --- |
| **Getting started** | | | |
| Something to install | ✓ npx skills add | – | ◆ skills + CLI + dashboard |
| Tells you where to start | ✓ evals-start router | ~ roadmap steps 0–1 | ◆ maturity ladder from symptoms |
| Audits an existing setup | ✓ eval-audit | ~ checklist | ◆ eval-audit + health checks per run |
| A shared file format | – | ~ illustrative YAML | ◆ versioned schemas in git |
| **Finding failures** | | | |
| Reads your traces | ✓ JSONL/CSV/JSON | – | ◆ files + OTel/Braintrust/Langfuse/LangSmith |
| Diverse sampling | ✓ clusters + random | ~ "sample weekly" | ◆ same, with coverage panel |
| Review interface | ✓ generated HTML app | – (internal only) | ◆ built-in keyboard-first queue |
| Notes → failure modes | ✓ | – | ◆ saved as files with severity, graders |
| Production failures in | – (paid course) | ~ mine bug tracker | ◆ scheduled sampler (phase 4) |
| Synthetic inputs | ✓ dimension tuples | – | ◆ kept |
| **Grading** | | | |
| Code checks | ✓ code before judges | ~ grader catalog | ◆ drafted by agent |
| Judge prompts | ✓ binary, one mode, few-shot, critique first | ~ rubrics, one dimension, Unknown | ◆ rules enforced on save + Unknown |
| Judge calibration | ✓ splits, ≥90/90, one-shot test | ~ "calibrate with experts" | ◆ guided stepper, locked test |
| Judge versioning / staleness | ~ advice | ~ advice | ◆ prompt hash + pin; stale excluded |
| Judge-error correction | ✓ Rogan-Gladen, bootstrap | – | ◆ automatic |
| Outcome (state) checks | – | ✓ | ◆ SQL/fs/HTTP/page + state diff |
| Partial credit | – (binary only) | ✓ | ◆ binary checks, weighted task score |
| RAG evaluation | ✓ | ~ | ◆ kept |
| **Tasks and suites** | | | |
| Reference solutions | – | ✓ | ◆ required before joining a suite |
| Capability vs regression, graduation | – | ✓ | ◆ three suites, auto-suggested graduation |
| Eval-driven development | – | ✓ | ◆ both doors into one format |
| Balanced problem sets | ~ labels only | ✓ | ◆ imbalance flagged |
| Broken/ambiguous task detection | – | ~ | ◆ automatic |
| **Running** | | | |
| Runner and harness | – | ~ (points to frameworks) | ◆ built-in or Harbor |
| Trials, pass@k, pass^k | – | ✓ | ◆ default 5; flaky detector |
| Clean environments, infra tagging | – | ✓ | ◆ reset per trial; infra excluded |
| Error bars | ~ corrected rate CI | ✓ Miller paper | ◆ both sources in one bootstrap |
| Cost/latency tracking | – | ~ | ◆ per task and run; budget cap |
| **Seeing and deciding** | | | |
| Dashboard | – | – | ◆ eight views |
| Transcript viewer | ~ raw | – | ◆ timeline, pinned checks, state diff, triage |
| Failure triage | – | ~ | ◆ proposed, human-confirmed |
| Edit from UI → repo | – | ~ "PMs can PR" | ◆ validated writes, tray, conflicts |
| CI integration | – | ~ | ◆ Action, gates, PR comment |
| Agent-type playbooks | – | ✓ | ◆ task templates (phase 3) |

The two rows neither source covers at all (dashboard; edit from UI back to the repo) are the reason to build the plugin.
