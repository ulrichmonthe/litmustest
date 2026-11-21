# Brand

As of 2026-11-21. Sources of record: the "litmustest Brand" Design System artifact for the mark, type and tokens, and the "litmustest: Job-first redesign" canvas (mockups in `../design/mockups/v2/`) for the product screens. `../brand/tokens.json` is the machine-readable token file (light and dark themes); `../brand/logos/` holds the five logo files. This file is the brand book.



## What the brand stands for

litmustest exists because two good sources of eval practice disagree about scoring and skip the tooling. The brand takes one position and holds it everywhere: **a number is only worth showing with its margin of error, and only worth trusting if a person has read the evidence behind it.**

That position shows up as three habits:

1. **Say the conclusion first.** Home and Ship open with a status dot and word, then one heading sentence that tells the reader what to do. The detail comes after.
2. **Every number carries its uncertainty.** A pass rate is never printed without a `±`. A difference is "within noise" or "significant", never just a delta.
3. **Status is a word, never only a colour.** A status is a small dot and a word: Trusted, Stale, Hold. The dot confirms; the word informs. Pills are kept for the few places a status sits inside running text or a dense cell.

## Voice

Plain, direct, specific. Written the way a careful senior engineer explains something to a colleague who is busy.

- Short sentences. One idea each.
- Name the thing: "tone_mismatch is stale" not "a judge needs attention".
- Say what to do, not what went wrong in the abstract: "Run on dev set" not "Calibration required".
- No exclamation marks, no emoji, no "oops", no apologies.
- Jargon is allowed once it has been defined in plain words. The guide defines every term the first time it appears; the product assumes the guide.

Words we use and words we avoid:

| Use | Avoid |
| --- | --- |
| trace, conversation | log, span, trajectory |
| failure mode | bug category, issue type |
| judge | evaluator, LLM-as-a-judge, grader (for model-based) |
| check | assertion, scorer |
| margin of error, within noise | confidence interval (in product UI), p-value |
| trial | run (a run is the whole suite) |
| stale | outdated, invalid |

## Logo

The mark is a **check above an error bar**. The check says "it passed". The bar says "and here is how sure we are". Together they are the product's one idea.

Files in `assets/Logos/`:

| File | Use |
| --- | --- |
| `mark.svg` | Two-colour mark on light grounds. Check in `blue`, bar in `ink`. |
| `mark-mono-ink.svg` | One-colour mark for print, stamps, and anywhere colour is unavailable. |
| `mark-mono-white.svg` | On `slate`, on `blue`, and on photography. |
| `favicon.svg` | The check alone on a blue rounded square. Used at 16 and 24px. |
| `lockup-horizontal.svg` | Mark plus wordmark, 64px tall. The default lockup. |

Rules:

- Clear space around the mark equals the height of the error bar's caps (one eighth of the mark's height) on every side.
- Minimum size with the bar: 24px. Below that, use the favicon.
- The check is always `blue` and the bar always `ink` on light grounds. In dark mode both use their dark theme values. On a coloured ground, both are white.
- Never rotate, outline, add a shadow, or put the mark inside a circle.
- The wordmark is `litmustest` in Sora 600, tracked at −0.04em, lowercase, with `test` in `blue`. In the mono lockup the whole word is one colour.
- Mark and wordmark sit on a shared baseline with a gap equal to the mark's cap height.

## Colour

A warm neutral ground, one accent, a status set, and one dark band.

- **`ground` and `surface`** are warm greys, not pure white, so cards read as objects on a page.
- **`blue`** is the accent. It means *go somewhere or hand something over*: a link, the focus ring, the range band on a margin bar, the check in the logo, and an action that hands work to Claude ("Claude can draft"), which opens a proposal you review. It never means success, and it is not the primary button: the one primary action on a screen is solid `ink`.
- **`slate`** is the dark band the v1 screens use for the verdict strip and the triage banner. The v2 screens state the conclusion as a heading under a status dot instead, so `slate` stays in the tokens only until those screens are replaced.
- **The status set** (`good`, `warn`, `bad`, `neutral-tint`, and the dots `dot-good`, `dot-warn`, `dot-bad`) is the only place meaning lives in colour, and every use is paired with a word. Words take `good`, `warn` or `bad`; the 6–7px dot beside them takes the matching `dot-` token. `good` and `bad` differ in lightness as well as hue so they survive colour-blindness. `warn` means "needs attention", not "error".
- **`planned`** (violet) appears only in roadmap and comparison material, to mark what is designed but not built. It never appears in the product.

Contrast: every text token meets 4.5:1 on the ground its usage note names, in both themes. `ink-faint` is the only token allowed below 7:1 and it is restricted to 12px and up. The verdict-strip dot uses `slate-good`, `slate-bad` or `slate-neutral`, which hold 3:1 on `slate` in both themes. The `dot-` tokens hold 3:1 on every ground, a hovered row and a selected item. `tests/contrast.test.ts` enforces all of this.

## Typography

Three families. Two of them do almost all the work.

- **Geist** (text) for everything: body, page titles, section headings, big numbers, pills, nav, the verdict sentence. Weight 400 for reading, 500 for nav and labels, 600 for headings and the lead of a sentence; 700 only for eyebrows. Headings track slightly tight (−0.01em at 16px, −0.03em at 26px). Turn on `ss01` so the single-storey a and open digits match Geist Mono.
- **Geist Mono** (code) for anything that exists as a file or a key: task ids, failure modes, judge names, margins, timestamps, counts beside nav items, tool calls, YAML, diffs. Weight 500 for identifiers so they hold against body text; 400 in blocks. The rule is simple: if it is on disk, it is mono. A page about one such thing (a task, a judge, a failure mode) sets its title in mono.
- **Sora** (display) for the wordmark and nothing else. The product's face is in the mark and the word; the pages themselves stay in Geist.

Inter and JetBrains Mono are the fallbacks and are acceptable where Geist cannot load. The product body is 13px at 1.5 line height (app density); reading paragraphs are 15px in `ink-soft`. All numbers use tabular numerals (`tnum`). Nothing readable goes below 12px; eyebrows at 11px are uppercase, 700, tracked +0.1em, and never carry the only copy of a fact.

## Links and focus

- A link is `blue-ink` at rest and `blue` on hover, weight 500, no underline inside the product (underline in long-form guides).
- Every button and link shows a 2px `blue` focus ring, 2px outside the element.
- Buttons and links inherit the page font; never let a control fall back to the browser's.

## Layout

- **Sidebar**, 232px, on `ground`, no border. From the top: the project switcher (mark and repo name), "Search or jump to" with ⌘K, the four places (Home, Ship, Teach, Cover), a "Library" label over Runs and trials and Settings, and at the bottom Pending changes and the git user's name. Items are 44px, `radius-md`, a 16px stroke icon in `ink-muted` and the label in `ink` at 500. The current item is 600 on `selected` with `aria-current="page"`. A status beside an item is plain 12px text (`8`, `1 of 4`, `3 gaps`) or a dot and a word (Hold); the item's label says what it counts.
- **Sheet**: everything right of the sidebar is one `surface` sheet with a `line` border and `radius-lg`, inset 8px from the window. It opens with a 56px top bar (page name or breadcrumb on the left; run context, Explain this page and the page's own secondary action on the right) over a `line-soft` divider. Content sits in a 1100px column with 40px side padding. No cards inside the sheet unless the content is a separate object (a selected task, the explain panel); sections divide with `line-soft`, rows with `line-faint`.
- **Phone**, below 900px: no sidebar. A top bar with the project name and pending count, the page, and a bottom bar with Home, Ship, Teach and Cover. The explain panel becomes a bottom sheet of at most 60% of the screen.
- Every deep page opens with a breadcrumb in the top bar (`Teach / Trust judges / missed_refund`), so a deep link still tells the reader where they are.
- Every control is at least 44px tall; compact controls inside a toolbar (segmented filters, the run picker) may be 32–36px as long as the row they sit in is 44px. Links in tables and lists get that height from padding, not from a wrapper.
- One solid primary button per screen (`ink` ground, `ground` text, 9px radius). Every other action is quiet: transparent with a `hover` ground, or a `line` border when it needs to read as a button at rest.
- No shadows anywhere; depth comes from the border and the ground.
- Spacing comes from the scale. Rows are 52px in lists a reader scans and 44px in dense tables.

## Components (reference, not a bundle)

This system ships tokens and rules, not a component bundle. The v2 mockups in `../design/mockups/v2/` are the component reference. The patterns to lift from them:

- **Status dot**: a 6–7px circle in a `dot-` token beside its word in the matching status colour, 600 weight in a heading eyebrow and 500 in a list. A hollow ring in `ink-faint` means "not started" or "no judgement" (an infra error, a report-only suite, a step not yet reached).
- **Margin bar**: the product's signature. A 6px `neutral-tint` track; the likely range as a band of `blue` at 22% opacity; the measured rate as a 2×12px `ink` tick; the gate as a dashed 1.5px `bad` line, absent when the suite has no gate. It echoes the logo's error bar. It always has an `aria-label` that says the rate, the range and the gate in words, and the number with its range is printed beside it.
- **Trial dots**: one 8px dot per trial, in order: `dot-good` passed, `dot-bad` failed, a hollow `line-strong` ring for an infra error, which is not counted. The group carries an `aria-label` ("After: 4 of 5 passed").
- **Up next row**: 52px, a status dot, a bold title and a muted reason that truncates, the space it belongs to (Ship, Teach, Cover) in muted text, and one action on the right. An action that hands work to Claude is `blue-ink` with the check mark before it.
- **Keyboard hints**: a `kbd` in Geist Mono 11px with a `line` border beside the control it triggers (D, J/K, ↵, ?, ⌘K).

- **Verdict strip** (v1 screens only): `slate` band, `radius-lg`, 14px padding with 20px on the leading edge. An 8px status dot in the status colour's *dark-theme* value (`#f08c84` for bad, `#6fcf97` for good) so it reads on slate. The sentence in `verdict` type: a two-word lead at 600 ("Agent error."), the rest at 400, identifiers in mono. On the right, a muted "Triage by Claude" label, a `surface` primary button and a ghost button (transparent, `ink-muted` border, `slate-ink` text).
- **Suite card** (v1 screens only): big number, margin in mono, delta in `good` or `ink-muted` with "significant" or "within noise", a sparkline with a 12% `blue` band, three small stats.
- **Timeline**: a three-column grid (48px timestamp in mono, 16px rail, content). Each step has an 8px dot on the rail (`ink-faint`; `blue` for the agent's own turns; a hollow dot ringed in `bad` for a missing step) joined by a 1px `line-soft` connector. Above the content an eyebrow names the speaker (CUSTOMER, AGENT, TOOL) with the turn number or tool name beside it. Customer turns sit on `surface-sunken`, agent turns on `blue-tint`, tool calls as `code-block`. A check sits directly under the step it judged, in a `radius-md` bordered panel: pill, mono name, one-line reason, one text link.
- **Status pill**: for a status inside running text or a dense cell; elsewhere use the status dot. `pill` type on a tint, 6px 10px padding, line-height 1, always a word, `radius-pill`.
- **Field save state**: a label on the left, a state on the right ("Saved", "Checked and saved to branch · 2s ago" in `good`, "Not saved · conflict" in `bad`), and the field's border taking the same colour.
- **Pending changes**: an item at the bottom of the sidebar: a branch icon in `blue`, "2 pending changes" over the branch name in mono, and "Review" in `blue-ink`. It opens the Pending changes sheet.
- **Failure-mode chip**: toggle, `radius-pill`, mono identifier, a check mark when on, blue border when on.

## Accessibility

- Text 4.5:1 or better on its ground in both themes; icons and borders 3:1.
- Colour never carries meaning alone.
- Every control is a real button, link or input, reachable by keyboard, with a visible focus ring in `blue`.
- Keyboard shortcuts are shown beside the control they trigger, not in a hidden help panel only.
- Reduced motion is respected; the product has almost no motion to begin with.
