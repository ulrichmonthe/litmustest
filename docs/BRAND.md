# Brand

As of 2026-10-27. Source of record: the "litmustest Brand" Design System artifact. `../brand/tokens.json` is the machine-readable token file (light and dark themes); `../brand/logos/` holds the five logo files. This file is the brand book.



## What the brand stands for

litmustest exists because two good sources of eval practice disagree about scoring and skip the tooling. The brand takes one position and holds it everywhere: **a number is only worth showing with its margin of error, and only worth trusting if a person has read the evidence behind it.**

That position shows up as three habits:

1. **Say the conclusion first.** Every page opens with one sentence in the slate strip that tells the reader what to do. The detail comes after.
2. **Every number carries its uncertainty.** A pass rate is never printed without a `±`. A difference is "within noise" or "significant", never just a delta.
3. **Status is a word, never only a colour.** Pills say Trusted, Stale, Broke. The colour confirms; the word informs.

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
- **`blue`** is the accent. It means *navigation and selection*: the primary button, the selected nav item, a link, the active half of a progress bar, the check in the logo. It never means success.
- **`slate`** is the one dark band on a page: the verdict strip on the Overview and the triage banner on a transcript. It is the place a page says its conclusion. Use it once per page or not at all.
- **The status set** (`good`, `warn`, `bad`, `neutral-tint`) is the only place meaning lives in colour, and every use is paired with a word. `good` and `bad` differ in lightness as well as hue so they survive colour-blindness. `warn` means "needs attention", not "error".
- **`planned`** (violet) appears only in roadmap and comparison material, to mark what is designed but not built. It never appears in the product.

Contrast: every text token meets 4.5:1 on the ground its usage note names, in both themes. `ink-faint` is the only token allowed below 7:1 and it is restricted to 12px and up.

## Typography

Three families. Two of them do almost all the work.

- **Geist** (text) for everything: body, page titles, section headings, big numbers, pills, nav, the verdict sentence. Weight 400 for reading, 500 for nav and labels, 600 for headings and the lead of a sentence; 700 only for eyebrows. Headings track slightly tight (−0.01em at 16px, −0.03em at 26px). Turn on `ss01` so the single-storey a and open digits match Geist Mono.
- **Geist Mono** (code) for anything that exists as a file or a key: task ids, failure modes, judge names, margins, timestamps, counts beside nav items, tool calls, YAML, diffs. Weight 500 for identifiers so they hold against body text; 400 in blocks. The rule is simple: if it is on disk, it is mono. A page about one such thing (a task, a judge, a failure mode) sets its title in mono.
- **Sora** (display) for the wordmark and nothing else. The product's face is in the mark and the word; the pages themselves stay in Geist.

Inter and JetBrains Mono are the fallbacks and are acceptable where Geist cannot load. Numbers that sit in columns use tabular numerals. Nothing readable goes below 12px; eyebrows at 11px are uppercase, 700, tracked +0.1em, and never carry the only copy of a fact.

## Links and focus

- A link is `blue-ink` at rest and `blue` on hover, weight 500, no underline inside the product (underline in long-form guides).
- Every button and link shows a 2px `blue` focus ring, 2px outside the element.
- Buttons and links inherit the page font; never let a control fall back to the browser's.

## Layout

- A 220px nav on the left with a `line-soft` right border, one page on the right. Page padding is `space-6` on desktop and `space-4` on phones, and the page content sits in a 1180px column centred in whatever is left. The nav stacks above the page below 900px.
- Nav items are `ink` at 500 with no icon. The current page is 600 in `blue-ink` on `blue-tint` and carries `aria-current="page"`. A count beside a nav item is the number alone, in mono on `neutral-tint`; the item's own label says what it counts.
- Every page opens with a breadcrumb (`Run #41 / regression / task / Trial 3 of 5`) above its title, so a deep link still tells the reader where they are.
- Cards are `surface` with a `line` border, `radius-lg` and `space-5` padding. No shadows anywhere; depth comes from the border and the ground. Rows inside a card divide with `line-soft`; a card's own sub-panel uses `radius-md` and a `line` border, dashed when its content is informational only (a stale judge's verdict, for example).
- Every control is at least 44px tall. Links in tables and lists get that height from padding, not from a wrapper. A selectable item that carries two facts (a trial number and its result) is a 64×52 card with a `line` border; the selected one takes a 1.5px `blue` border on `blue-tint`.
- Spacing comes from the scale. Gaps between cards are `space-3`; between sections `space-4`; between a heading and its content `space-3`.

## Components (reference, not a bundle)

This system ships tokens and rules, not a component bundle. The eight product screens in the Evals Dashboard Mockup are the component reference until the dashboard is built. The patterns an engineer should lift from them:

- **Verdict strip**: `slate` band, `radius-lg`, 14px padding with 20px on the leading edge. An 8px status dot in the status colour's *dark-theme* value (`#f08c84` for bad, `#6fcf97` for good) so it reads on slate. The sentence in `verdict` type: a two-word lead at 600 ("Agent error."), the rest at 400, identifiers in mono. On the right, a muted "Triage by Claude" label, a `surface` primary button and a ghost button (transparent, `ink-muted` border, `slate-ink` text).
- **Suite card**: big number, margin in mono, delta in `good` or `ink-muted` with "significant" or "within noise", a sparkline with a 12% `blue` band, three small stats.
- **Timeline**: a three-column grid (48px timestamp in mono, 16px rail, content). Each step has an 8px dot on the rail (`ink-faint`; `blue` for the agent's own turns; a hollow dot ringed in `bad` for a missing step) joined by a 1px `line-soft` connector. Above the content an eyebrow names the speaker (CUSTOMER, AGENT, TOOL) with the turn number or tool name beside it. Customer turns sit on `surface-sunken`, agent turns on `blue-tint`, tool calls as `code-block`. A check sits directly under the step it judged, in a `radius-md` bordered panel: pill, mono name, one-line reason, one text link.
- **Status pill**: `pill` type on a tint, 6px 10px padding, line-height 1, always a word, `radius-pill`.
- **Field save state**: a label on the left, a state on the right ("Saved", "Checked and saved to branch · 2s ago" in `good`, "Not saved · conflict" in `bad`), and the field's border taking the same colour.
- **Pending changes tray**: `blue-tint` card in the nav with a count, the branch name in mono, and a "Review and commit" link.
- **Failure-mode chip**: toggle, `radius-pill`, mono identifier, a check mark when on, blue border when on.

## Accessibility

- Text 4.5:1 or better on its ground in both themes; icons and borders 3:1.
- Colour never carries meaning alone.
- Every control is a real button, link or input, reachable by keyboard, with a visible focus ring in `blue`.
- Keyboard shortcuts are shown beside the control they trigger, not in a hidden help panel only.
- Reduced motion is respected; the product has almost no motion to begin with.
