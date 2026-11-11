# The explainer

Every term and number in litmustest answers three questions where it stands: what it means, what it means here, and what to do next. This page is the contract between the glossary file, the engine that renders it, and the surfaces that show it. The product requirements live in the Explainer PRD (2026-10-30); this page records how they are built and where the build departs from them.

## The one rule

An explanation never creates a number. Layer 2 computes every figure from the files, through a typed list of facts per source. Templates can only print those facts, through a formatter that matches their kind. The validator rejects a digit typed into a template.

## Layers in this build

| Layer | What | Built |
| --- | --- | --- |
| 1. What it means | `short`, `why`, `good` from the glossary | Yes |
| 2. What it means here | `here` templates rendered from facts, plus `next` steps | Yes |
| 3. Ask why | Claude explains the facts, cited, digit-checked | No. It needs its own calibrated `wrong_cause` judge (100 labelled answers), which only people can label. The PRD gates it on that. |

## Files

| File | Role |
| --- | --- |
| `plugin/glossary/terms.yaml` | The seed glossary. Ships with the plugin; copied into the npm package at pack time like `schemas/`. |
| `evals/glossary.yaml` | Optional repo terms. They add terms; they cannot reuse a plugin id or alias (a validation error). |
| `evals/failure_modes/*.yaml` | Each failure mode is a term automatically: `short` is its definition. |
| `schemas/glossary.json` | The schema for both glossary files. |
| `packages/cli/src/glossary.ts` | Loading, validation, the template language, rendering. |
| `packages/cli/src/glossary_facts.ts` | The sources: one facts builder and one field list per source. |

## An entry

```yaml
- id: tpr
  term: True positive rate
  aliases: [TPR, recall, sensitivity]
  short: Of the real failures, how many the judge caught.
  why: A judge that misses failures lets bad changes ship.
  good: 90% or higher on the dev set before the test set runs.
  here:
    - source: judge
      template: >-
        Your {judge} judge caught {dev.tp} of {dev.tp + dev.fn} real failures
        ({dev.tpr | pct}, could be {dev.tpr_ci | range}).
      next:
        - when: dev.ran and dev.tpr >= threshold and not test.ran
          say: Ready to run the test set once.
        - when: dev.ran and dev.tpr < threshold
          say: Label more failures. The {dev.fn} it missed are under Disagreements.
          link: "#/judges/{judge}"
        - say: Run the dev set to measure it.
  related: [tnr, calibration, stale]
  learn_more: master-class#ch-12
```

`here` is either one `{source, template}` with the entry's `next` (the shape in `docs/stories/explainer.md`), or a list of variants, each with its own `next`, when a term is explained from more than one place or state: a confidence interval on a suite and on a judge are different sentences. Both load as a list. The surface passes a source and a context; the engine picks the first variant for that source whose `when` holds and whose facts all resolve.

A next step may name an `action`, a dashboard command from `packages/cli/src/explain/actions.ts` (`pending.commit`, `judges.runTest`…). The panel renders it as a button that runs the page's own handler; `link` is for steps done on another screen.

`here.source` names a read model, not a single file: `judge` reads `calibration.json`, `judge.yaml`, the labels and the tasks. "Every placeholder resolves to a field in the named source schema" is checked against that read model's typed field list in `glossary_facts.ts`.

Every surface resolves a term through one function, `explain(termId, context)` in `packages/cli/src/explain/index.ts`.

## Template language

- `{expr}` or `{expr | formatter}`. An expression is a fact path (`dev.tpr`), a context name (`judge`), integer arithmetic on counts (`+ - *`), or parentheses.
- `when` is a boolean expression: comparisons (`< <= > >= == !=`), `and`, `or`, `not`, `null`, and literals. A `next` item without `when` always matches.
- Each fact has a kind, and the kind fixes the formatter:

| Kind | Formatter | Renders | Example |
| --- | --- | --- | --- |
| `rate` (an estimate, 0–100) | `pct` | `93%` | `dev.tpr` |
| `interval` | `range` | `82–98%` | `dev.tpr_ci` |
| `share` (an exact fraction, 0–100) | `share` | `9%` | coverage |
| `pts` (a difference in points) | `pts` | `+6 pts`, `−2.5 pts` | `delta` |
| `usd` | `usd` | `$0.42` | `cost_usd` |
| `count` | none | `42` | `dev.tp` |
| `text`, `enum`, `bool` | none | as is | `judge`, `status` |

## What the validator enforces

`litmustest validate` checks both glossary files; `npm test` checks the plugin's against the sample repo.

1. Schema shape; ids are `snake_case`; ids and aliases are unique across plugin, repo and failure-mode terms.
2. `short` is 20 words or fewer. It names no other term unless it links it as `[[id]]`.
3. Every path in a template or `when` is a fact of the variant's source. A typo fails here, not on a user's screen.
4. Each fact uses its kind's formatter, and only that one.
5. Every `rate` printed in a template is printed with its interval in the same template.
6. No digit appears in `template` or `say` outside a placeholder, except a number that also appears in `good`.
7. Every `next` list ends with an item that has no `when`.
8. `learn_more` names a Master Class chapter from 1 to 25.
9. An `action` is a known dashboard command.

`npm run lint:terms` (in CI) scans the text the dashboard and the CLI print for the jargon in `plugin/glossary/jargon.yaml` and fails, with file and line, on any word the glossary does not define.

## Sources

Defined in `glossary_facts.ts`, each with its context and its typed fields. The fields are the only thing a template can print.

| Source | Context | Built from |
| --- | --- | --- |
| `judge` | `judge` | `graders/judges/<judge>/{judge.yaml,calibration.json}`, labels, tasks |
| `suite` | `suite`, optional `run` (latest) | the run summary, its suite gate, and the paired delta against the previous run |
| `task` | `task`, optional `run` | the run summary's task entry; Wilson interval over its trials |
| `delta` | `a`, `b`, `suite` | `compareRuns(a, b)` |
| `failure_mode` | `mode` | the failure-mode file, its labels, judge and tasks |
| `run` | optional `run` | the run summary |
| `queue` | optional `batch` | the batch and its labels |
| `coverage` | `map` | `computeCoverage` |
| `pending` | none | the Pending changes tray |

pass@1 and pass^k are stored without an interval. The `suite` and `task` facts add a Wilson interval computed from the trial and task counts, so the "every rate carries its interval" rule holds.

## Surfaces

| Surface | How |
| --- | --- |
| Dashboard term | `term(id)`: a word with a dotted `line-strong` underline on its first use per screen, never blue |
| Dashboard number or pill | `num(id, source, ctx, value)`: the value itself is the trigger and its explanation reads this value's facts. Status pills placed without one are wrapped after each render by matching their word to the glossary |
| Peek (tier 1) | Hover for 400ms or keyboard focus shows `short` and "Click for more": one line where it fits, two at most, under the term, no controls. None on touch. Each trigger is `aria-describedby` its short definition |
| Explain panel (tier 2) | Click, tap or Enter opens a 320px panel docked on the right; the page reflows beside it. Below 900px it is a bottom sheet, at most 60% of the screen. It shows the term, what it means, what it means here, the next step, why it matters, related terms and Learn more (linked when `explain.learn_more_url` is set). Another term updates it in place; the close button, Escape or `?` close it and return focus; it follows you across screens and clears to page mode when the new screen lacks its term |
| Explain this page | `?` (outside a text field) or "Explain this page" opens the panel in page mode: the first three terms from `plugin/glossary/pages.yaml` that the screen shows, each with its sentence |
| Next steps as actions | A next step's `action` names dashboard commands. Screens register their own buttons' handlers as commands (`command(id, …)` in `app.js`), and the panel renders available ones as buttons that call the same handler; a step on another screen is a link, never a link to the screen you are on. Every disabled button has a trigger beside it whose next step says what unblocks it |
| Plain language | Each person's choice, in Settings and in the panel header. On, the "here" sentence sits under each card's number; off, it is only in the panel. Saved in `$XDG_CONFIG_HOME/litmustest/prefs.json` (else `~/.config/…`) through `/api/prefs`, falling back to browser storage where the server keeps none; never in `evals/`. A repo sets the default for newcomers with `explain.plain_language_default` (on when unset). The first panel a newcomer opens offers, once, "Turn off Plain language" |
| API | `GET /api/glossary` (layer 1, merged); `POST /api/glossary/here` with `[{id, source, ctx}]` returns the rendered sentences |
| CLI | `litmustest explain <term>` prints layer 1 and, when an `evals/` exists, the "here" sentence for every matching context. `explain` with no term keeps its old job (explaining failed trials). |
| CLI rows | `--plain` on `run`, `compare`, `calibrate` and `doctor` prints the "here" sentence under each row. Not `--explain`: on `run` that already means "ask Claude about the failed trials". |
| CI | The PR comment gains a collapsed "What these numbers mean" block when a gated suite's delta is significant or its gate failed, and has none otherwise |

## Decisions on the PRD's open questions

- Plain language is each person's choice, stored outside the repo; a repo may set the default for newcomers (`explain.plain_language_default`, on when unset).
- Repo glossary entries add terms and never override plugin terms. Failure modes are the way a repo defines its own words.
- "Why?" is not built yet (see Layers).
- Copy: written to the PRD's seed list; the five-person comprehension test decides rewrites.

## Where this build departs from the PRD

- **Tokens.** The PRD names `surface-raised` and `line-strong`; neither exists in `brand/tokens.json`, and the brand book forbids shadows. Popovers and the drawer are `surface` with a `line` border; the term underline is dotted `ink-faint`.
- **Rates on 0–100.** The PRD's example compares `dev.tpr >= 0.90`; files store percentages, so templates compare against the `threshold` fact.
- **Terms beyond the seed list.** `strict_pass`, `weighted_score`, `unknown`, `coverage`, and the words the screens show in headers and pills (`report_only`, `flip`, `grader`, `transcript_check`, `coverage_depth`, `coverage_map`). Kappa, PPI, MDE, win rate and attack success rate wait for the features that introduce them.
- **No reason strings.** A gate's reason text ("85.1% is below the 95% gate") carries numbers without intervals, so it is not a printable fact; the templates say why from structured facts (`below_min`, `prev.delta`).
- **The suite card** on the Overview is no longer one large link (a "?" cannot sit inside a link); its title links to the suite.

## Status against the PRD's checks

| Check | Status |
| --- | --- |
| Every term or alias rendered has an entry (UI lint) | Yes for table headers, stat labels, pills and eyebrows on every screen (`tests/ui_smoke.test.ts`, with an explicit list of plain words). Running text is not linted. |
| Hover, focus and tap open the popover; Escape closes it and returns focus | Click and focus open it and Escape returns focus, tested in Chrome. Hover is built, not tested. |
| Triggers ≥ 44px with a focus ring; contrast ≥ 4.5:1 | 44px tested on every route. Contrast not measured. |
| `litmustest explain <term>` prints the popover's text | Yes, tested; aliases work. |
| The linked Master Class chapter exists | Validated to be chapters 1–25. The mapping of terms to chapters has not been checked against the guide. |
| A "?" with a "here" sentence on every metric, delta and pill | On the main numbers of every screen (suite cards, deltas, pass@1, pass^k, TPR/TNR, gates, flaky and broken tasks, failure modes, coverage, pending). Not on every cell: rows that are themselves links or buttons (coverage tiles, failure-mode rows) carry the term, not a "?". |
| Every number equals the source file | Tested for judge, suite and task facts; every digit in a rendered sentence is traced to a placeholder. |
| Every rate shows its interval | Enforced by the validator and tested on the example. |
| Every blocked state shows a next step | Enforced (every `next` list ends with a fallback) and tested for stale, trusted, calibration, TPR/TNR, test set, flaky, broken and gate. |
| A "here" sentence updates within a second of its file changing | Not built. Popovers read fresh facts each time they open; plain-language lines refresh when the page renders, which the Overview and Pending pages do on file events and other pages do not. |
| The PR comment block appears only when a gate moved | Yes, tested. |
| Layer 3 checks | Not built (see Layers). |
