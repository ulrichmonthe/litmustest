# evalkit handoff package

Everything decided and designed so far, packaged for Claude Code. Drop the contents of this folder into the root of a new repository. `CLAUDE.md` goes at the root as-is; keep `docs/`, `brand/` and `design/` where they are.

Start with `CLAUDE.md`, then `docs/FIRST-BRIEF.md`. Nothing here is code yet.

```
CLAUDE.md               project rules and the map of this package
docs/
  SPEC.md               what we are building, the reconciled method, architecture, phases
  DECISIONS.md          six open decisions with recommendations; record outcomes here
  FIRST-BRIEF.md        the first Claude Code task: schemas + sample repo, then Phase 1
  ACCEPTANCE.md         what "done" means per phase; review every PR against it
  SCREENS.md            the eight dashboard screens and the write-back states
  BRAND.md              voice, colour, type, layout, component rules
  COMPARISON.md         the 30-capability matrix vs the two sources
brand/
  tokens.json           design tokens, light and dark (the source for CSS variables)
  logos/*.svg           mark, mono marks, favicon, horizontal lockup
design/mockups/
  *.dc.html             eight screens as design components; Transcript.rework is canonical
```

Three things to do before the first PR:

1. Decide the name (`docs/DECISIONS.md` #1). `evalkit` is taken on npm and PyPI. Everything in this package uses it as a placeholder.
2. Confirm the license position (#4). It can be decided in a minute.
3. Read the sample-repo section of `FIRST-BRIEF.md` and agree the five tools; they shape every seed task.

Suggested first prompt for Claude Code, once the repo exists:

> Read CLAUDE.md and docs/FIRST-BRIEF.md. Do Part A (schemas and validator) as one PR. Do not start Part B until Part A's tests pass. Review your own PR against docs/ACCEPTANCE.md before telling me it's ready.

Live sources of record (private artifacts; share from each page's menu if others need them): Evals Plugin: Reconciled Spec (doc), Evals Plugin: Decision Memos (doc), evalkit Master Class (guide), Evals Feature Comparison (page), Evals Dashboard Mockup (design canvas), evalkit Logo (design canvas), evalkit Brand (design system).
