# Screens

As of 2026-10-27. Source of record: the "Evals Dashboard Mockup" Design canvas. The eight artboards are in `../design/mockups/*.dc.html`; `Transcript.rework.dc.html` is the latest, brand-aligned version of the Transcript screen and is the reference for how the other seven should be brought in line.

Each `.dc.html` is a Design Component: an `<x-dc>` template plus a small logic class. The values to replicate live in inline `style` attributes and the `<helmet><style>` block. Replicate them in the real component system; do not copy the markup wholesale. All numbers are sample data.

## Shell shared by every screen

- 220px nav, `line-soft` right border, logo mark + wordmark at the top, items at 500 weight, current page 600 in `blue-ink` on `blue-tint` with `aria-current`. Counts beside items are the number alone in mono on `neutral-tint`.
- A **Pending changes** tray at the bottom of the nav: `blue-tint` card, count badge, branch name in mono, "Review and commit" link. Present on every screen.
- Page content in a centred 1180px column, `space-6` padding (16px on phones). Nav stacks above the page below 900px.
- Every page opens with a breadcrumb above its title. A "Sample data" pill marks mock numbers.
- Every control ≥ 44px tall. Status is always a word in a pill. Blue is navigation/selection only.

## The eight screens

| File | View | Job | Key interactions (working in Play) |
| --- | --- | --- | --- |
| `Main.dc.html` | Overview | One verdict sentence; three suite cards with CI; needs-attention list; flipped tasks | Verdict strip with one action; every number links down |
| `Compare.dc.html` | Run compare | Per-suite delta drawn as a CI on a shared −10…+10 axis; filterable flip list; failure-mode deltas; cost panel | Filter tabs All/Broke/Fixed/Flaky; run pickers |
| `Transcript.dc.html` (+ `.rework`) | Transcript | Triage verdict to confirm/override; timeline with each check pinned to its step; expected-vs-actual state diff; 5-trial strip | Trial selector; dispute a verdict |
| `Review.dc.html` | Review queue | Trace reader with tool calls inline and a missing call flagged; Pass/Fail; free-text note; suggested failure-mode chips; coverage by cluster | p/f toggles; chip toggles; Save and next |
| `Modes.dc.html` | Failure modes | Pareto with severity, grader status, sparkline; selected-mode editor with definition, severity, owner, linked labels/tasks/grader | Row select drives the editor |
| `Tasks.dc.html` | Tasks & suites | Suite cards that switch the table; suite-health strip; per-task pass@1, pass^5, 5-run history; broken/flaky flags | Suite select; filter |
| `Judges.dc.html` | Judge editor | 4-step stepper (edit → dev ≥90/90 → test once → trusted); form/files toggle; field save states incl. a disk conflict; few-shot picker; checks-on-save; confusion matrix; TPR/TNR by version; disagreements; Pending changes diff | Form/Files toggle; commit / PR / discard |
| `Settings.dc.html` | Settings | Gates per suite, runs, judges, sources/storage; form or `evalkit.yaml` | Form/YAML toggle |

## Write-back states (Judge editor)

Field label on the left, state on the right, border matches:
- `Saved · in sync with disk` (neutral)
- `Checked and saved to branch · 2s ago` (`good`, green border)
- `Not saved · conflict` (`bad`, red border) with "Reload file" / "Keep mine"

Checks on save: schema valid; one failure mode, Pass and Fail defined; a clear pass, a clear fail and a borderline example; no few-shot example in dev or test; calibration marked stale when the prompt hash changes.

## Known gaps in the mockups

- No empty, loading or error states drawn for any screen.
- No dark theme drawn; tokens exist for it in `../brand/tokens.json`.
- Seven of eight screens still use Inter/JetBrains Mono and the older nav; the rework uses Geist/Geist Mono and the current nav rules. Treat the rework as canonical.
- No mobile layout beyond "it wraps".
