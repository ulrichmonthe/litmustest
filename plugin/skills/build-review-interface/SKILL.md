---
name: build-review-interface
description: Make sure reviewers can read and label traces well. litmustest already ships a review queue in `litmustest serve`; this skill starts there and builds a custom view only when the trace shape truly needs rendering the queue lacks. A custom view is a client of the litmustest server and writes labels only through its API. Use when reviewers struggle to judge traces in the queue, or when someone asks for an annotation tool.
---

<!-- Modified from ai-evals-course/evals-skills (Apache 2.0): the display and feedback guidance is the course's; the default is the litmustest review queue, and a custom view reads and writes through the litmustest server. -->

# Build a review interface

Reviewers judge better and faster when a trace looks like what it is. litmustest already has a review queue. Your first job is to get the team using it; your second, only if needed, is a custom view for a trace shape the queue cannot show well.

Three rules from `CLAUDE.md` bind you:

1. `evals/` in git is the source of truth. Labels live in `evals/labels/*.jsonl` and nowhere else: no CSV, no SQLite, no browser storage of labels.
2. You propose, people decide. Code you write stays uncommitted. Never commit, never push.
3. Reading traces and labeling are human work. You build the view; you never label through it, not even to try it out on real data.

## Phase 1: Use the review queue

```bash
litmustest serve
```

The queue is at http://127.0.0.1:4242. It works through review batches written by `litmustest ingest` and already does what the course asks of an annotation tool:

- One trace at a time with the full path: user turns, agent turns, and each tool call with its arguments, result and errors.
- A header from trace metadata (scenario, persona, turn and tool-call counts, model).
- Trace-level Pass, Fail or Skip (Skip is the defer), a free-text note, and failure-mode chips once modes exist.
- Keys: `j`/`k` move, `p`/`f`/`s` set Pass, Fail or Skip, `n` focuses the note, Enter saves and advances.
- Each save appends one validated line to `evals/labels/<batch>.jsonl` with the annotator's name, and shows in the Pending changes tray. Labels are append-only; a correction is a new line.
- Sampling stays outside the view: `litmustest ingest` and `litmustest sample` write the batches.

Ask the reviewer to label five traces and tell you what slowed them down. Most problems are in the data, not the view: a source with no `messages` or `tool_calls` shows only the final answer. Fix the source or its conversion script and re-ingest before building anything.

## Phase 2: Decide whether a custom view is needed

Build one only when the reviewer cannot judge the trace as the queue renders it. The queue shows text as plain text and tool results as short code blocks. Good reasons:

- The output is a rendered artifact: an HTML email, a page, a chart, an image, a document with layout.
- The judgement needs a side-by-side: a code diff, a generated SQL query next to its result table, retrieved passages next to the answer.
- Long structured results (big JSON, many retrieved documents) that need folding and search to read.
- Multi-agent traces where the hand-offs between agents are what fails.

Not good reasons: styling preferences, wanting a different layout of the same text, or wanting labels stored somewhere else. Write down the specific gap and tell the user. A gap in the queue is worth reporting upstream as well.

## Phase 3: Build the custom view as a client

How it fits rule 1: the custom view is a reader and a client. It owns no data.

- Reads: `GET /api/batches` (list), `GET /api/batches/<name>` (items with existing labels), `GET /api/traces/<id>` (the trace, its turns view and labels).
- Writes: only `POST /api/labels` with `{"batch", "trace_id", "failure_mode": "overall", "label": "Pass"|"Fail"|"Skip", "note", "annotator"}`. The server validates it against the label schema, checks the trace exists, appends it, and puts it in the Pending changes tray. Use a failure-mode name instead of `overall` only for a mode that exists under `evals/failure_modes/`.
- Never write files under `evals/` from the view, never keep its own label store, never sample.

Put the code outside `evals/`, for example `tools/review/<name>/`. `litmustest serve` serves only its own UI and sends no CORS headers, so serve the page from a small local script that also forwards `/api/*` to http://127.0.0.1:4242. Same origin, no CORS. Keep the script dependency-free if you can.

Display, from the course:

- Render each part in its native form: emails as emails, markdown rendered, code highlighted, tables as tables, JSON pretty-printed and foldable.
- Show the full trace. Collapse what does not help judgement (shared system prompt, verbose tool JSON, reasoning) behind `<details>`, open on demand.
- Surface key metadata as a header. Bold the entities a reviewer checks (amounts, dates, names).
- Tell roles apart at a glance (a left border per role). Link each tool call to its result.
- Sanitize model output before rendering: strip raw HTML and block remote images, which can be tracking pixels.

Feedback and navigation:

- Trace-level Pass, Fail and Skip, and a free-text note. No failure-mode pick list in the first build; notes come first.
- Every label is saved by its POST; there is no separate save state. "Undo" posts a new line.
- Use the queue's keys (`j`/`k`, `p`/`f`/`s`, `n`, Enter) so reviewers do not relearn.
- A counter ("12 of 60, 41 unlabelled"), jump to trace id, and the annotator's name on every label.

## Phase 4: Test it on a copy, never on real labels

Testing writes labels, so never test against the team's `evals/`. Copy it to a scratch directory, make that a git repository (the server needs one), and serve the copy on another port:

```bash
cp -R evals <scratch>/evals && cd <scratch> && git init -q && git add -A && git commit -qm scratch
litmustest serve --dir <scratch>/evals --port 4243
```

Point the view at the copy, then check with Playwright:

1. Screenshots with representative traces: clear hierarchy, nothing left as raw JSON or unrendered markdown, the layout holds at narrow widths.
2. A full pass: Pass, Fail with a note, Skip; each produces one valid line in the copy's `labels/<batch>.jsonl`.
3. Navigation by buttons and keys; the counter updates; a reload shows the saved labels from the server.
4. Collapsed sections open and show their content.
5. `litmustest validate <scratch>/evals` passes.

Delete the scratch copy afterwards. Then stop: the view's code is uncommitted in the repo, and the user decides whether to keep it.

## What you never do

- Build a custom view before a reviewer has tried the queue and named what is missing.
- Store labels anywhere but `evals/labels/` through `POST /api/labels`.
- Label real traces, even "to check it works". Commit or push.
