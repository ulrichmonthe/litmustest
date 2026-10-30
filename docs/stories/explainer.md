# Explainer: user stories

As of 2026-10-30. Source: the "litmustest: Explainer PRD" doc. This file replaces the current hover "?" popover with a two-tier pattern: a peek tooltip on hover or focus, and an explain panel docked on the right, opened by click, tap, Enter or `?`.

Work one epic per PR, in order. Each story is done when every acceptance check passes against `examples/support-agent/`.

## Rules that apply to every story

- An explanation never creates a number. Every number shown in an explanation comes from a field in a file under `evals/`, read when the explanation is shown.
- One source. All explanation text comes from `glossary/terms.yaml` (plugin) plus optional `evals/glossary.yaml` (repo). No explanation strings hard-coded in UI or CLI code.
- Explain terms and numbers, not pages. Triggers sit on the term or number itself (dotted underline). No "?" icons after sentences or titles.
- Never cover the subject. The panel pushes content aside; it never overlays the thing being explained.
- Next steps are actions. A next step that can be done on the current page is a button that does it, never a link to the same page.
- Brand. Underline `line-strong` dotted, never blue. Controls ≥ 44px, visible focus ring, contrast ≥ 4.5:1 in both themes. Status words stay pills.

## Epic 1: Glossary source

### E1-S1 Glossary file and schema

As a maintainer, I want every explanation to live in one validated file so that the dashboard, CLI, PR comments and guide never disagree.

Acceptance:

- [ ] `glossary/terms.yaml` exists with a JSON Schema in `schemas/glossary.json`. Fields: `id`, `term`, `aliases[]`, `short`, `why`, `good`, `here {source, template}`, `next[] {when, say, action?, link?}`, `related[]`, `learn_more`, `audience[]`.
- [ ] `litmustest validate` checks the glossary: `short` is ≤ 20 words; every `{placeholder}` resolves to a field in the named source schema; no digits typed into `here` or `say` except thresholds that also appear in `good`; every `next` list ends with a rule that always matches.
- [ ] The 30 seed terms from the PRD's Seed glossary table are present and pass validation.
- [ ] A repo can add terms in `evals/glossary.yaml`. A repo entry with the same `id` as a plugin entry is a validation error (repos add terms, they do not override).

### E1-S2 Explanation resolver

As a developer, I want one function that turns a term and the current repo state into an explanation so that every surface renders the same thing.

Acceptance:

- [ ] `explain(termId, context) → {term, short, here?, next?, learnMore, related}` lives in `packages/cli/src/explain/` and is used by the server, the CLI and the PR comment.
- [ ] `here` is filled from the file named in `here.source`; if the file or field is missing, `here` is omitted, never shown with blanks.
- [ ] Rates use only the `pct` and `range` formatters; every rate in `here` carries its interval.
- [ ] Property test: for every seed term with a `here` template, every number in the output equals the value in the source file.

### E1-S3 Undefined-term lint

As a maintainer, I want CI to fail when the UI shows jargon with no glossary entry so that new terms can't ship unexplained.

Acceptance:

- [ ] `npm run lint:terms` scans rendered strings in `packages/cli/ui/` and CLI output templates for any `term` or `alias` in the glossary and for a deny-list of known jargon not yet in it.
- [ ] A rendered term with no entry fails the lint with file and line.
- [ ] The lint runs in CI.

## Epic 2: Peek (tier 1)

### E2-S1 Dotted-underline terms

As a new user, I want terms I might not know to be marked so that I can tell what I can ask about without a help icon.

Acceptance:

- [ ] Terms render with a dotted `line-strong` underline via a single `<Term id="…">` component (or equivalent helper in `app.js`).
- [ ] Only the first use of a term per screen is underlined.
- [ ] Every metric, delta and status pill is also a trigger (the number itself is underlined).
- [ ] The existing "?" icon after the Pending changes subtitle, and any other "?" after a sentence or title, is removed.

### E2-S2 Peek tooltip

As a user, I want a one-line definition when I pause on a term so that I get the gist without opening anything.

Acceptance:

- [ ] Hover for 400ms or keyboard focus shows a tooltip with `short` only, plus the hint "Click for more".
- [ ] The tooltip is one line where it fits, never more than two, and covers no more than the line below the term.
- [ ] It closes when the pointer leaves or focus moves. It contains no links or buttons.
- [ ] On touch devices there is no peek; a tap goes straight to the panel (E3).
- [ ] `aria-describedby` links the term to the tooltip text.

## Epic 3: Explain panel (tier 2)

### E3-S1 Open the panel

As a user, I want to open a full explanation of a term so that I can read it next to the thing it explains.

Acceptance:

- [ ] Click, tap or Enter on a term opens a 320px panel docked on the right. Page content reflows to make room; nothing is covered.
- [ ] Below 900px wide, the panel opens as a bottom sheet at most 60% of the viewport height.
- [ ] The panel shows: term name, `short`, "What it means here" (`here`), "Next step" (`next`), related terms as chips, and "Learn more" linking to the Master Class chapter.
- [ ] Clicking another term while the panel is open updates it in place; it does not open a second panel.
- [ ] The panel stays open until closed with its close button, Escape, or the `?` key. Closing returns focus to the term that opened it.
- [ ] The panel's state (open, current term) survives navigation between screens; the term clears if it does not exist on the new screen.

### E3-S2 Explain this page

As a user landing on an unfamiliar screen, I want one key that explains the page so that I know what matters here.

Acceptance:

- [ ] Pressing `?` (outside an input) or the "Explain this page" link in the verdict strip opens the panel in page mode.
- [ ] Page mode lists the three most important terms or numbers on the screen, each with its `here` sentence, as defined per screen in `glossary/pages.yaml`.
- [ ] Selecting one switches the panel to that term.

### E3-S3 Next steps are actions

As a user who is blocked, I want the explanation to give me the action that unblocks me so that I don't have to work out where to go.

Acceptance:

- [ ] A `next` rule may declare `action` (a dashboard command id, e.g. `pending.commit`, `judges.runTest`, `review.openBatch`). When present, the panel renders it as a primary button that runs the command.
- [ ] Buttons use the same command handlers as the page's own buttons; no duplicate logic.
- [ ] On Pending changes, the panel for "Pending changes" shows Commit 2 files to feat/age-levels-p0 and Open PR buttons, not a link to the same page.
- [ ] Every disabled button, stale judge and failed gate on the eight screens has a `next` rule that names what unblocks it.
- [ ] Actions that write go through the Pending changes tray as they do today.

### E3-S4 Pending changes page

As a user reviewing dashboard edits, I want explanations on the parts that are hard to read so that I can commit with confidence.

Acceptance:

- [ ] Dotted triggers on: the branch name, the changed-file count, and the diff markers `---`, `+++`, `@@`.
- [ ] The branch-name explanation says why edits go to a branch and how to change it.
- [ ] The diff-marker explanation says what each marker means in one line each.
- [ ] Opening the panel never covers the diff (verified at 1280px and 1440px widths).

## Epic 4: Plain language

### E4-S1 Per-person Plain language setting

As a user, I want to choose whether "what it means here" sentences show inline so that the dashboard fits how much I already know.

Acceptance:

- [ ] A Plain language toggle in Settings and in the panel header. When on, each card shows its `here` sentence inline under the number; when off, it shows only in the panel.
- [ ] The setting is stored per person in local user preferences (`~/.config/litmustest/prefs.json`, or browser storage in hosted mode), not in `evals/litmustest.yaml`.
- [ ] A repo may set the default for newcomers with `explain.plain_language_default` in `evals/litmustest.yaml`. Default when unset: on.
- [ ] The first panel a new user opens shows a one-time "Turn off Plain language" button.

## Epic 5: CLI and CI

### E5-S1 `litmustest explain`

As a CLI user, I want to look up a term from the terminal so that I get the same answer as the dashboard.

Acceptance:

- [ ] `litmustest explain <term|alias>` prints term, `short`, `why`, `good`, and `here` + `next` when run inside a repo with the source file.
- [ ] Unknown term: exit code 2 and up to three closest matches.
- [ ] `litmustest explain --list` lists all terms.
- [ ] Output text matches the panel's text for the same term and repo state (snapshot test).

### E5-S2 `--explain` flag

As a CLI user, I want plain sentences under results so that I can read a run without the dashboard.

Acceptance:

- [ ] `--explain` on `run`, `compare`, `calibrate` and `doctor` prints one `here` sentence under each table row, indented and in muted color.
- [ ] Without the flag, output is unchanged (snapshot test).

### E5-S3 PR comment block

As a reviewer, I want the PR comment to explain any gate that moved so that I can approve or block without asking.

Acceptance:

- [ ] When any gate's value changed, the comment ends with a collapsed `<details><summary>What these numbers mean</summary>` block containing the `here` sentence for each moved gate.
- [ ] When no gate moved, the block is absent.

## Epic 6: Ask why (tier 3, later; behind a setting)

Do not start until Epics 1–5 are merged.

### E6-S1 Ask why

As a user, I want to ask why a number changed so that I understand the cause, not just the result.

Acceptance:

- [ ] Hidden (not disabled) unless an API key is set and `explain.ask_why: true`.
- [ ] A "Why?" button in the panel for metrics and deltas. The request includes the resolver output as structured facts plus only the files behind that number; input capped at 4k tokens; counted in the run budget; cached by input hash.
- [ ] Output schema: `{answer, claims[{text, file, field?}], unknown: bool}`. Every claim cites a file.
- [ ] A post-check rejects any answer containing a number not present in the input facts; the panel then shows "Couldn't explain this reliably" and the files to look at.
- [ ] When the files don't show a cause, the answer says so (`unknown: true`) and names what to look at.
- [ ] The answer carries an "AI explanation" pill and a "Was this right?" control that appends to `labels/explainer.jsonl`.
- [ ] No Ask-why action writes to the repo outside the Pending changes tray.

### E6-S2 Explainer evals

As a maintainer, I want the explainer graded by litmustest itself so that we can prove explanations are honest.

Acceptance:

- [ ] `plugin/evals/explainer/` with failure modes `invented_number`, `uncited_claim`, `wrong_cause`, `jargon_leak`, `no_next_step`, `too_long`.
- [ ] Code checks for all but `wrong_cause`; `wrong_cause` uses a judge calibrated on 100 labeled answers.
- [ ] Tasks built from the sample repo's planted failures, each with a reference answer naming the planted cause.
- [ ] Plugin CI gate: `invented_number` and `uncited_claim` at zero; `wrong_cause` pass rate ≥ 90%.

## Out of scope

- A free-text chatbot. Questions start from something on screen.
- Translations.
- Animated or auto-opening explanations, beyond the one-time Plain language prompt.
