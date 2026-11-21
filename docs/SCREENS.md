# Screens

As of 2026-11-21. Source of record: the "litmustest: Job-first redesign" Design canvas, Page 2, sections E and F. The 43 artboards are in `../design/mockups/v2/*.dc.html`; the build plan that turns them into the dashboard is `stories/redesign.md`. The eight v1 artboards in `../design/mockups/*.dc.html` describe the dashboard as it is until the redesign lands.

Each `.dc.html` is a Design Component: an `<x-dc>` template plus a small logic class, rendered by the canvas (the `support.js` it loads is the canvas's, not in this repo). The values to replicate live in inline `style` attributes and the `<helmet><style>` block. Replicate them through the tokens in `../brand/tokens.json` (every hex on the canvas maps to a token; `BRAND.md` names them); do not copy the markup wholesale. All numbers are sample data.

## The shape

One ranked **Home**, three places that each answer one question, and a **Library**:

- **Ship**: is this change safe? Compare two runs, every trial, one trial in full.
- **Teach**: what does good look like? A four-step rail: label, group notes, failure modes, trust judges.
- **Cover**: what isn't tested? Gaps and coverage maps, tasks and suites, the task editor.
- **Library**: runs and trials, settings.

The shell (sidebar, sheet, top bar, phone bottom bar) is specified in `BRAND.md`, Layout.

## Every v2 screen

Status: **built** means the feature exists today and the screen is a new layout over it; **new** means the redesign adds behaviour (see `stories/redesign.md`); **planned** means the canvas marks it "Planned" and neither track builds it yet.

| File | Canvas | Screen | Route | Status |
| --- | --- | --- | --- | --- |
| `HomeP` | E1 | Home: verdict, gates, Up next | `#/home` | new (ranked list) |
| `HomeExplainP` | E4 | Home with the explain panel open | every screen | built |
| `HomeSafeP` | F15 | Home: safe to merge, nothing to do | `#/home` | new |
| `HomeNoKeyP` | F17 | Home without a model key | `#/home` | new (the default verdict) |
| `HomeDarkP` | F25 | Home, dark theme | every screen | built (tokens) |
| `FirstRunP` | E14 | Home on first run | `#/home` | built |
| `TracesSourceP` | F8 | No traces found: drop a file, connect, pick a batch | `#/home/traces` | new; LangSmith and the collector planned |
| `CommandP` | F24 | ⌘K search | everywhere | new |
| `ShipP` | E3 | Ship: gates, what changed, failure modes | `#/ship` | built |
| `ShipSafeP` | F16 | Ship: safe | `#/ship` | built |
| `RunPickerP` | F13 | Choosing runs to compare | `#/ship` | new |
| `DecideP` | E2 | Decide who's right, one reply at a time | `#/ship/decide` | built (labels, expected flips) |
| `TranscriptsP` | E5 | All trials in a run | `#/library/runs/<run>` | built |
| `TrialP` | E6 | One trial: timeline, checks, end state, triage | `#/library/runs/<run>/<task>/<n>` | built |
| `RunsP` | F12 | Run history and trend | `#/library/runs` | new |
| `RunningP` | F19 | Run in progress | `#/library/runs/<run>` | planned (N1) |
| `RunStoppedP` | F20 | Run stopped at budget | `#/library/runs/<run>` | planned (N1) |
| `TeachP` | E7 | Step 1: label | `#/teach/label` | built |
| `PromoteP` | F4 | Turn a conversation into a task | `#/teach/label/<trace>/promote` | built (default suite changes) |
| `DiscoverP` | E8 | Step 2: group notes, Claude proposes | `#/teach/group` | built |
| `DiscoverNoKeyP` | F18 | Group notes by hand | `#/teach/group` | new |
| `ModesP` | E9 | Step 3: failure modes | `#/teach/modes` | built |
| `JudgesP` | F11 | All judges | `#/teach/judges` | built |
| `JudgeP` | E10 | Step 4: one judge, calibration | `#/teach/judges/<name>` | built |
| `NewJudgeP` | F5 | New judge for a mode with no check | `#/teach/judges/new` | built (`draftJudge`) |
| `JudgeTestP` | F6 | Run the test set once | `#/teach/judges/<name>` | new (server route over calibrate) |
| `JudgeTrustedP` | F7 | Judge trusted | `#/teach/judges/<name>` | built |
| `RecheckP` | F3 | Claude re-checks a stale judge | `#/teach/judges/<name>/recheck` | planned (N2) |
| `CoverP` | E11 | Cover: gaps and coverage maps | `#/cover` | built |
| `CoverageDetailP` | F14 | Coverage drill-down: real traffic | `#/cover/<map>` | built |
| `CoverageSetupP` | F9 | Set up spec and code coverage | `#/cover/setup` | built (spec file, code report); connectors planned |
| `ImportStoriesP` | F10 | Import stories from Linear | none | planned |
| `TasksP` | E12 | Tasks and suites, graduation | `#/cover/tasks` | built |
| `GraduateP` | F2 | Confirm graduation | `#/cover/tasks` | built |
| `TaskEditorP` | E13 | Task editor | `#/cover/tasks/<suite>/<id>` | built |
| `DraftTasksP` | F1 | Review Claude's drafted tasks | `#/cover/drafts` | planned (N3) |
| `PendingP` | E15 | Pending changes sheet | sheet | built |
| `CommittedP` | F22 | After commit | sheet | built |
| `HostedPendingP` | F23 | Hosted mode: the pull request | sheet | parked (hosted mode is not in the plugin) |
| `SettingsP` | E16 | Settings | `#/library/settings` | built; three sections not drawn |
| `ErrorStatesP` | F21 | Error states | everywhere | built (one component) |
| `PhoneHomeP` | F26 | Home on a phone | every screen | new (bottom bar) |
| `PhoneExplainP` | F27 | Explain sheet on a phone | every screen | built |

## Rules every screen follows

- Every control ≥ 44px tall (compact toolbar controls inside a 44px row excepted). Status is a dot and a word. One solid primary button per screen. Blue is for links, focus and handing work to Claude.
- Every rate prints its interval; every delta prints its paired interval and whether it is real or noise. Counts and costs carry none.
- A screen that writes says where: "Lands in Pending changes", the file path in mono, and nothing reaches git until a person commits.
- Labels are only ever written by a person. Claude's work arrives as a proposal with Accept, Edit and Reject.

## Write-back states

Field label on the left, state on the right, border matches:
- `Saved · in sync with disk` (neutral)
- `Checked and saved to branch · 2s ago` (`good`)
- `Not saved · the file changed on disk` (`bad`) with "See their change", "Reload file" and "Keep mine"

Checks on save: schema valid; one failure mode, Pass and Fail defined; a clear pass, a clear fail and a borderline example; no few-shot example in dev or test; calibration marked stale when the prompt hash changes.

## Known gaps in the v2 mockups

- Settings draws Gates, Runs and budget, and Explainer; its Judges, Trace sources and Storage sections are listed but not drawn.
- Not drawn: changing a trial's triage, merging or retiring a failure mode outside Group notes, disputing a single check's verdict. All exist today and need a place in the new layout (R3, R4).
- Home's briefing paragraph is Claude's summary (explainer layer 3, gated). Until that ships, Home uses the fact sentence from `HomeNoKeyP`.
- The sidebar shows the git user's name; there is no sign-in in the plugin.
