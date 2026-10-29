---
name: generate-synthetic-data
description: Create varied synthetic inputs for an AI product with dimensions and tuples, run them through the product, and ingest the resulting traces into evals/ as a review batch with `litmustest ingest`. Use when bootstrapping an eval set, when real traces are sparse, or to stress-test a failure hypothesis. Do not use when there are already 100+ representative real traces; sample those with `litmustest ingest` or `litmustest sample` instead.
---

<!-- Modified from ai-evals-course/evals-skills (Apache 2.0): the dimension and tuple method is the course's; the output is a JSONL source in the trace adapter shape, ingested into evals/ as a review batch. -->

# Generate synthetic data

You help the team create realistic test inputs that aim at the places the product is likely to fail, run them through the product, and land the traces in `evals/` as a review batch. Then a person reads them in the review queue.

Three rules from `CLAUDE.md` bind you:

1. `evals/` in git is the source of truth. Traces enter it through `litmustest ingest`, never by hand.
2. You propose, people decide. The user confirms the dimensions and tuples. Never commit, never push.
3. Reading traces and labeling are human work. You generate inputs; you never label the traces they produce.

## When not to use it

- Nobody on the team can judge whether a synthetic input is realistic. Use real data.
- Complex domain documents (legal filings, medical records) or low-resource languages, where generated text misses the structure. Use real data.
- There are 100+ representative real traces. Use `litmustest ingest` (it clusters and keeps a random draw) and fill gaps here only.

## Phase 1: Hypotheses first

Ask where the product fails or might fail. Read `evals/failure_modes/*.yaml` if any exist, recent user complaints, and five to ten real traces if there are any. Dimensions must target those hypotheses, not arbitrary variety.

## Phase 2: Define dimensions

Start with three. Each is an axis of variation specific to this product, with a short list of values.

```
feature: what the user wants          [refund, invoice_copy, plan_change]
persona: who is asking                [first_time, frustrated, business_admin]
scenario: how clear the request is    [well_specified, ambiguous, out_of_scope]
```

Add a dimension only when traces later show failures along a new axis.

## Phase 3: Draft 20 tuples with the user

A tuple is one combination of values. Write 20 by hand and show them. The user says which combinations happen in real life and which do not. Iterate until they confirm. Their domain knowledge is the point of this step.

## Phase 4: More tuples, then queries, in two separate prompts

First prompt: generate more tuples (10 at a time), no duplicates, values varied across dimensions. Second prompt, one tuple at a time: write a realistic user message for that tuple, with one of the user's hand-written examples as a style anchor. Keep the two steps separate; generating tuples and queries together gives repetitive phrasing.

You are the model; you can do both steps yourself. Keep the prompts and the generator script in the repo, outside `evals/`, next to the output (for example `traces/synthetic/<set>/`), so the set can be regenerated.

## Phase 5: Filter

Drop and regenerate queries that read awkwardly, do not match their tuple, or repeat another query. Show the user the final list with its tuples and let them strike anything unrealistic. Aim for about 100 inputs; that is a rough point where new traces stop revealing new failures.

## Phase 6: Run them through the product

Run every input through the real product, not a mock, and capture the full trace: input, every message, every tool call with arguments and results, retrieved context, and the final output. Write one JSON object per line in the trace adapter shape (`trace.jsonl_adapter` in `docs/SCHEMAS.md`):

```json
{"id": "syn_refunds_v1_0001",
 "input": "I was charged twice this month and nobody answers my emails.",
 "output": "...",
 "messages": [{"role": "user", "content": "..."}, {"role": "assistant", "content": "..."}],
 "tool_calls": [{"id": "tc_0", "name": "fetch_invoices", "arguments": {"account_id": "acc_1004"}, "result": [], "turn": 0}],
 "timestamp": "2026-10-29T10:00:00Z",
 "model": "<the product's model id>",
 "metadata": {"synthetic": true, "set": "refunds_v1",
              "tuple": {"feature": "refund", "persona": "frustrated", "scenario": "ambiguous"}}}
```

- `id`, `input` and `output` are required. Without `messages` and `tool_calls` reviewers see only the final answer.
- Prefix ids with `syn_<set>_` and set `metadata.synthetic: true` and the tuple, so synthetic traces stay distinguishable from production ones in the queue and in every count.
- Write the file outside `evals/`, for example `traces/synthetic/<set>.jsonl`. The adapter shape is ingest input and is never stored under `evals/`.

If the product's agent already runs under `agent.command` in `litmustest.yaml`, you can reuse that entry point in a small driver script. Keep the script in the repo and say so.

## Phase 7: Ingest as a review batch

```bash
litmustest ingest traces/synthetic/<set>.jsonl --batch synthetic-<set> --size <n> --clusters <k>
litmustest validate
```

`ingest` validates each line, converts it to the internal trace shape under `evals/datasets/traces/`, clusters, and writes `evals/batches/synthetic-<set>.yaml` with a coverage report. Read the adapter warnings and the cluster terms back to the user. Use a `--size` equal to the number of inputs if every one should be read.

Note on `evals/datasets/synthetic/`: files there are validated as the internal trace shape, but `ingest` writes only to `datasets/traces/`, and batches, the review queue and judges read only `datasets/traces/`. So synthetic traces go through `ingest` into `datasets/traces/`, marked by id prefix and metadata. Do not hand-write files into `datasets/synthetic/`.

Then stop. The files are uncommitted and show in the Pending changes tray. Hand off to `error-discovery`: the user reads the batch in `litmustest serve` and writes notes.

## Inputs worth keeping as tasks

Some inputs deserve a permanent place: a capability the product should have, or a failure the team wants to guard. Those become tasks with `source: synthetic:<set>` and a reference solution. That is `define-task`, not this skill.

## Sampling real data instead

When real traces exist, do not sample them by hand. `litmustest ingest` clusters them (TF-IDF and k-means, offline) and draws one representative per cluster plus a random sample; `litmustest sample` does the same for new production traffic. Use synthetic inputs only to fill the clusters or scenarios real data leaves thin.

## What you never do

- Generate without dimensions ("give me 50 test queries"). That gives generic, happy-path inputs.
- Skip the user's review of tuples.
- Label, rate or pre-sort the resulting traces. People read them in the queue.
- Write traces into `evals/` by any route other than `litmustest ingest`. Commit or push.
