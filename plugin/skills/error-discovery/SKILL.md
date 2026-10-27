---
name: error-discovery
description: Run error analysis on a product's traces with litmustest. Ingest and sample traces, run the review queue, organize the reviewer's notes into failure-mode files, and propose them as a diff on a branch. Use when a team has traces or logs and no named failure modes yet, or when "it feels worse" and nobody can check.
---

<!-- Modified from ai-evals-course/evals-skills (Apache 2.0): the method is the course's; the review app, the sampling and the files are litmustest's. -->

# Error discovery

You are running an error-analysis session. The team has traces of an AI product (a JSONL log, or an OpenTelemetry export) and wants to find out how it fails. The output of this skill is a set of named, defined, counted failure modes under `evals/failure_modes/`, proposed as a diff on a branch. A person commits them.

Three rules from `CLAUDE.md` bind you:

1. `evals/` in git is the source of truth. You write files there; nothing else.
2. You propose, people decide. Every file you write stays uncommitted on the branch until the user commits it. Never commit, never push.
3. Reading traces and writing notes is human work. You never label a trace and never write a note on the reviewer's behalf. You organize what they noticed.

This skill is for interactive sessions. If the session is non-interactive (`claude -p`), do Phases 1 and 2, stop the server, print the command to start it, and stop. Never claim a review happened.

## Progress updates

Say what you are about to do before each phase and what you found after it. "Ingesting 300 traces from logs/support.jsonl into 8 clusters." "The reviewer has labelled 14 traces; grouping 11 notes." Do not go silent while a command or the model runs.

## Phase 1: Set up the evals directory

If there is no `evals/litmustest.yaml`:

```bash
litmustest init
```

It detects a JSONL trace source in the usual places (`.`, `logs/`, `traces/`, `data/`). Open the config it wrote and confirm `sources.traces.path`. If the traces are somewhere else, pass `--source <file>`.

Read five to ten lines of the source. Each line needs `id`, `input` and `output`; `messages` and `tool_calls` are optional and make the review far better. If the log has a different shape, write a small conversion script to that shape, keep it in the repo, and say so. Do not hand-edit traces.

## Phase 2: Ingest, cluster, sample

```bash
litmustest ingest <source> [--size 60] [--clusters 8]
litmustest validate
```

`ingest` normalizes every line to the internal trace shape under `evals/datasets/traces/`, clusters offline (TF-IDF and k-means, so no key is needed and the same input gives the same batch), and writes `evals/batches/<date>.yaml`: one representative per cluster plus a random draw, with a coverage report. Read the coverage report back to the user: cluster sizes and top terms. A cluster whose terms look like a failure ("noted, flagged, team, hear") is worth pointing out before anyone reads a trace.

Then start the dashboard:

```bash
litmustest serve
```

Tell the user the review queue is at http://127.0.0.1:4242 and how it works: `j`/`k` move, `p`/`f` label Pass or Fail, `n` focuses the note, Enter saves and advances. Ask them to write, in their own words, the first thing that looks wrong on each failing trace. Free text only; no categories yet. Failure-mode chips appear once modes exist, but the note is what matters.

## Phase 3: The review loop

Follow [review-loop.md](review-loop.md). In short: watch `evals/labels/*.jsonl` for new lines, read the notes as they arrive, and after about five distinct failing traces run the first grouping.

## Phase 4: Group notes into failure modes

Grouping is the one step where a model does the writing, and it still only proposes.

```bash
litmustest discover            # show proposals and diffs, write nothing
litmustest discover --apply    # save the proposed files as pending changes on the branch
```

`discover` reads every label with a note, pulls a short excerpt of each trace, shows the existing failure modes, and asks the model to group the notes into modes: create, update, keep or retire, each with a definition that says what Pass and Fail look like, a severity, example trace ids from the notes, and a one-sentence rationale. Each proposal is shown as a diff of `evals/failure_modes/<name>.yaml`. The dashboard offers the same thing as "Ask Claude to regroup notes" on the review queue.

You can do the grouping yourself instead of calling the model through the CLI; you are the same model. If you do, write the files to `evals/failure_modes/` with the schema in `docs/SCHEMAS.md` and run `litmustest validate`. Either way the result is uncommitted files on the branch, visible in the Pending changes tray, and you present them to the user as a diff and stop. Do not commit.

Rules for a good mode, from the course:

- One failure per mode, specific enough that a judge could apply it and a new annotator could recognise it. "Quality issues" is not a mode. "States a refund window without fetching the policy" is.
- Prefer updating an existing mode over creating a near-duplicate. Retire a mode only when another clearly subsumes it, and record `merged_into`.
- Names are `snake_case`. Definitions are one to three plain sentences.
- Severity: high when the customer is harmed or data is wrong; med when the answer is right but the experience is poor; low for inefficiency.
- Examples are trace ids from the notes, at most five, that show the mode clearly.
- Notes that fit no mode stay unassigned. Say which ones, and ask the reviewer whether they are a new mode or noise.

## Phase 5: Report and converge

After each grouping, report: the modes with their counts (Fail labels per mode, from the review queue's "Failure modes so far" panel or `GET /api/failure_modes`), coverage by cluster, and whether new traces are revealing new modes or repeating known ones. When the rate of new modes drops, say so and suggest stopping. Then point at the next skill: `write-code-eval` for modes a function can check, `write-judge-prompt` for the rest.

## What you never do

- Label a trace, write a note, or change a label. Labels are append-only and human.
- Commit, push, or switch branches. The Pending changes tray and the user do that.
- Edit `calibration.json` or anything under `datasets/`.
- Build a separate review app. `litmustest serve` is the review app; if it lacks something, say so.
