# The job-first redesign: build plan

Source of record: the "litmustest: Job-first redesign" Design canvas (Page 2, sections E and F, 43 artboards). Sections A to D on Page 1 are explorations and are not built. All numbers on the canvas are sample data.

The redesign replaces nine pages with one ranked **Home**, three spaces (**Ship**: is this change safe? **Teach**: what does good look like? **Cover**: what isn't tested?) and a **Library** (runs, trials, settings). It is mostly a new shell and new screens over features that already exist. The work splits into two tracks, planned and shipped separately so the redesign never waits on a new feature:

- **Track R, the redesign**: tokens, shell, and every screen, on features the CLI and server already have. Six PRs.
- **Track N, new features the canvas introduces**: each its own PR, after R2. The canvas marks these screens "Planned · not built".

## Status (2026-11-21)

Track R is built, R0 to R5, one commit each on `feat/r5-search` (stacked on `integration/roadmap`). Left over from Track R, each small and none blocking:

- The judge editor and the task editor keep their v1 bodies under the new shell and headings.
- Running a judge's test set has no separate confirmation screen (F6); "Turn into a task" is one click, not the preview form (F4); graduation has no separate confirm sheet (F2).
- Settings' Judges, Trace sources and Storage sections are not drawn or built.
- Bringing traces in from the dashboard (F8) is not built: running ingest from the server writes several files outside `App.putFiles`. First run shows `litmustest ingest`.
- Home has no "D" shortcut; Pending changes keeps its v1 after-commit message.

Track N (N1 to N4) has not started.

## Decisions to make before R0

1. **Status as a dot and a word, not a pill.** The canvas reverses `docs/BRAND.md` rule 3 ("Pills say Trusted, Stale, Broke"). The word stays, so the rule's intent (never colour alone) holds. Recommendation: accept; rewrite the rule as "a dot and a word".
2. **Blue for handing work to Claude.** The canvas uses blue for "Claude can re-check / group / draft". BRAND.md says blue means navigation and selection only. Recommendation: accept, because a Claude action does navigate to a proposal you review; add it to the rule explicitly.
3. **Old routes.** Recommendation: redirect every old hash route to its new home (table below) so links in PR comments, docs and the CI artifact keep working.
4. **The name in the sidebar.** Local mode shows `git config user.name`. No avatar service, no sign-in (hosted mode is parked).

## What maps to what

| Canvas | Route | Built from today | New in this plan |
| --- | --- | --- | --- |
| E1 Home, F15 safe, F17 no key | `#/home` | `/api/overview`, verdict facts, gates | `server/home.ts`: the ranked "Up next" list |
| E4 explain panel, F27 phone sheet | every screen | explainer (`explain()`, `/api/glossary/here`) | restyle only |
| E2 Decide | `#/ship/decide` | labels, disputes (`/api/labels`), expected flips (`/api/compare/expected`) | one screen over existing writes; "Can't tell" writes `Skip` |
| E3 Ship, F16 safe, F13 run picker | `#/ship` | `/api/compare`, flips, gates, Post to PR | trial dots; run picker over `/api/runs` |
| E5 All trials, E6 Trial | `#/library/runs/<run>`, `…/<task>/<n>` | `/api/transcripts`, triage, end state | triage proposal from the template explanation (`explain.ts`, no model) |
| F12 Run history | `#/library/runs` | run summaries | read model with Wilson intervals per suite per run, trend line |
| E7 Label | `#/teach/label` | review queue, batches, coverage by group | "why this conversation" text from batch facts |
| F4 Promote | `#/teach/label/<trace>/promote` | `App.promote` (A1) | default suite becomes **capability** (the reference can't pass yet) |
| E8 Group notes, F18 by hand | `#/teach/group` | `/api/discover` (with a key) | by-hand grouping: select notes, add to a mode or create one, via `App.putFiles` |
| E9 Failure modes | `#/teach/modes` | modes view and editor | restyle |
| F11 All judges, E10 judge, F5 new judge | `#/teach/judges…` | `/api/judges`, `draftJudge` | F11 is new layout over existing data |
| F6 test set once, F7 trusted | `#/teach/judges/<name>` states | `litmustest calibrate` | a server route that runs calibrate's test step and streams it |
| E11 Cover, F14 traffic drill-down | `#/cover`, `#/cover/<map>` | `computeCoverage` (six maps) | restyle; drill-down per map |
| F9 coverage setup | `#/cover/setup` | `coverage.spec`, `coverage.code.report` config | form over config; story connectors stay planned |
| E12 Tasks, F2 graduate, E13 editor | `#/cover/tasks…` | tasks view, `/api/graduate`, task editor | F2 confirm sheet |
| E14 first run, F8 traces | `#/home` empty state, `#/home/traces` | init, ingest, Langfuse/Braintrust config | drop a `.jsonl` file into `datasets/traces/`; batch picker writes a batch file |
| E15 Pending, F22 after commit | sidebar sheet | `/api/pending*` | restyle; committed state |
| E16 Settings | `#/library/settings` | config form | draw and build the Judges, Trace sources and Storage sections |
| F21 errors | everywhere | existing error replies | one error component: what happened, nothing lost, one next step |
| F24 ⌘K | everywhere | none | client-side index over routes, tasks, modes, judges, runs |
| F25 dark, F26 phone | everywhere | dark tokens, phone layout (A2) | phone gets a bottom bar: Home, Ship, Teach, Cover |

Old route redirects: `#/overview` → `#/home`, `#/compare` → `#/ship`, `#/review` → `#/teach/label`, `#/discover` → `#/teach/group`, `#/modes` → `#/teach/modes`, `#/judges` → `#/teach/judges`, `#/coverage` → `#/cover`, `#/tasks` → `#/cover/tasks`, `#/transcripts` → `#/library/runs`, `#/settings` → `#/library/settings`, `#/pending` opens the sheet.

## Track R: the redesign

### R0. Tokens, brand book, design source

- `brand/tokens.json`: most of the canvas palette already exists (`ground`, `ink`, `ink-muted`, `blue`, `blue-ink`, `good`, `bad`, `neutral-tint`). Add what the canvas uses and the tokens lack, in both themes: two border weights (`#e4e2dc`, `#efede8`), a row divider (`#f3f2ee`), hover and selected grounds (`#fafaf8`, `#ecebe6`), `ink-soft` (`#44403c`), `ink-faint` reconciled with `#a8a29e`, and solid status dots (`#16a34a`, `#dc2626`, `#d97706`). Take dark values from F25. Regenerate with `npm run docs:tokens`; `tests/contrast.test.ts` must pass in both themes.
- `docs/BRAND.md`: the two rule changes above, the margin bar, trial dots, the status dot, the sidebar.
- Export the E and F artboards to `design/mockups/v2/` and rewrite `docs/SCREENS.md` against them. The v1 mockups stay for history.
- Glossary: terms for every new header and label (Ship, Teach, Cover, Up next, margin bar, …) so `npm run lint:terms` passes from R1 on.

### R1. Shell, routing, shared components

- **Split `packages/cli/ui/app.js`** (980 lines) into ES modules, still with no build step: `ui/shell.js`, `ui/components/*.js` (margin bar, trial dots, status dot, explain panel, error), `ui/screens/<space>/*.js`. One file cannot carry 40 screens.
- The sidebar (Home with its count, Ship with its verdict, Teach with "n of 4", Cover with gap count, Library, Pending at the bottom), the top bar (run context, Explain this page), the white sheet, the phone bottom bar, the redirects.
- Each existing screen moves into the new shell unchanged, so nothing is lost while R2 to R4 restyle them.
- Tests: `ui_smoke` routes renamed, every old route redirects, 390px and dark passes still green.

### R2. Home and Ship

- `server/home.ts`: the "Up next" list, ranked by fixed rules and computed from the files: (1) what blocks the merge (failed gates, broken regression tasks), (2) what keeps numbers honest (stale judges, flaky tasks, likely-broken tasks), (3) what makes evals better (labels to do, notes to group, high-severity gaps). Each item carries its space, one action and a next step from the glossary.
- The verdict sentence is the **fact sentence** from F17 ("Hold. 2 of 3 gates crossed: …"), with or without a key. Claude's written briefing is N4.
- Ship: gates table with margin bars, flips with trial dots, selected-task panel, failure-mode deltas, cost/tokens/latency, the run picker, the safe state. Decide (E2) as a focused flow over existing writes.
- Every rate and every delta prints its interval (`compareRuns` already returns paired intervals).

### R3. Teach

- The four-step rail with live counts.
- Label (E7), Promote (F4, default suite capability), Group notes with a key (E8) and by hand (F18), Failure modes (E9).
- Judges: all judges (F11), one judge (E10), new judge (F5, via `draftJudge`), test set once (F6), trusted (F7). The test-set route calls the same code as `litmustest calibrate` and refuses a second run per version.
- CLI parity: by-hand grouping is the one new write; add `litmustest mode add-notes <mode> <trace…>` and a parity-table entry.

### R4. Cover, Library, everywhere

- Cover (E11), coverage setup (F9, spec file and code report only), drill-downs (F14), tasks (E12), graduate (F2), task editor (E13).
- Library: run history (F12), all trials (E5), trial (E6), Settings (E16) with its missing sections.
- First run (E14), bringing traces in (F8: drop a `.jsonl`, Langfuse and Braintrust), Pending and after commit (E15, F22), error states (F21).

### R5. ⌘K search

Client-side: the shell loads ids and titles for routes, tasks, failure modes, judges and recent runs, and fuzzy-matches them. No server change.

## Track N: new features

Each is its own PR, behind the same rules: proposals arrive as diffs, people commit, labels stay human.

- **N1. Runs started from the dashboard** (F19, F20, "Run this task"). `POST /api/runs` spawns the runner; progress streams over `/api/events`; cancel; the budget stop already exists in the runner (B1); resume continues the missing trials and writes one summary. CLI parity: none needed (`litmustest run` is the source).
- **N2. Claude re-checks a stale judge** (F3). Runs the judge on dev, reads disagreements, proposes a prompt diff and its dev rates. Never reads the test split; the proposal goes to Pending changes. Test with a fake model.
- **N3. Claude drafts tasks for gaps** (F1). Extends `draft.ts` from graders to tasks: checks from the mode's graders, a drafted reference, deep-checked before it is offered. Drafts land in capability.
- **N4. Claude's briefing and "Ask about this run"** (E1). Explainer layer 3. Gated, as `docs/EXPLAINER.md` says, on a calibrated `wrong_cause` judge (100 answers labelled by people). Until then Home shows the fact sentence.

## Parked

Marked "Planned" on the canvas and not in either track: the LangSmith adapter and storage backend, an OpenTelemetry collector, CSV traces, Linear / Jira / GitHub Issues spec connectors and story import (F10), and hosted mode's pull-request view (F23; hosted mode is not part of the plugin).

## Every PR

- Colours, radii and spacing only through `var(--token)`; no hex in `app.css` or the screen modules.
- New words get a glossary term; `npm run lint:terms` passes.
- Every rate prints its interval; counts and costs link to what they count.
- Controls ≥ 44px; contrast 4.5:1 in both themes; works at 390px.
- Anything the dashboard writes, the CLI can write (`tests/parity.test.ts`).
- `npm run build`, `npm test`, `validate --deep` on the example. Screenshots of each changed screen in light, dark and phone in the PR.
