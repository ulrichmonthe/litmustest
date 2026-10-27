<!-- Modified from ai-evals-course/evals-skills (Apache 2.0). -->

# Review loop

The dashboard is running and the reviewer is labelling. You are an active participant, not a spectator.

## Two modes: breadth and depth

**Breadth**: cover the dataset. The batch already mixes one representative per cluster with a random draw; after the first pass, ingest a second batch with a different `--seed` or a larger `--size` to fill the clusters with the least coverage.

**Depth**: once a mode is found, examine it. Re-read earlier traces with the new mode in mind (criteria drift: the reviewer's eye changes as they see more), refine the definition, and look across the batch for other instances.

Alternate. Go broad until something turns up, go deep on it, go broad again.

## Watching for labels

Labels append to `evals/labels/<batch>.jsonl`, one JSON object per line. Watch that file:

- Claude Code: use the Monitor tool on the file (or poll it with a read-and-compare loop every few seconds).
- Anything else: a small polling script in the background that appends new lines to a log you read each turn.

Tell the user how you are watching. Do not use filesystem events; polling is reliable everywhere.

The server also streams events at `GET /api/events` (server-sent events: `label`, `saved`, `committed`, `discarded`, `changed`) if you prefer to subscribe.

## As notes arrive

1. Read the new lines. Only `Fail` labels with a `note` carry signal; `overall` labels are the reviewer's verdict on the whole trace, mode-specific ones confirm a chip.
2. Keep a running taxonomy in your head: `{mode: {definition, count, example trace ids, quotes}}`. Match each note to an existing mode or hold it as new.
3. After about five distinct failing traces, run the first grouping (`litmustest discover`). Earlier is too weak a signal. Never group before the reviewer has labelled anything.
4. Present the proposals as the diffs `discover` printed. Say which notes went where and which fit nothing. The user accepts, edits or rejects; you do not commit.

## Depth: scan for instances

When a mode becomes clear, scan the rest of the batch for it. Read the traces under `evals/datasets/traces/` (the turns view is what `GET /api/traces/<id>` returns) and list the trace ids that look like instances, with the line that gives it away. Favor recall: a false positive costs the reviewer a glance, a miss costs a failure mode its count.

Do not write labels for those traces. Hand the list to the reviewer: "tr_0041, tr_0097 and tr_0203 look like missed_refund too; want to look?" The reviewer labels them in the queue.

## Breadth: propose the next batch

After a batch is mostly labelled, look at coverage by cluster. Ingest again to fill the thin clusters:

```bash
litmustest ingest <source> --size 40 --seed 2 --batch <date>-b
```

Say what you added and why.

## Encourage re-review

After two or three new modes have appeared, say so and suggest a second pass over the first traces. "You've named three modes since you read the first ten traces; a second pass will probably catch instances you had no word for then."

## Report and converge

Every so often: the modes with counts and whether each has a grader yet (`GET /api/failure_modes`), coverage by cluster, and whether new traces are mostly repeats. When discoveries slow down, suggest stopping or narrowing. Then hand off to `write-code-eval` and `write-judge-prompt`.

## Principles

1. The human notices; you organize.
2. You propose coverage; the batch sampler executes it.
3. Everything you produce is a file under `evals/`, uncommitted, in the Pending changes tray.
4. Random samples stay in every batch. The clustering cannot know what it missed.
