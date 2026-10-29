---
name: evaluate-rag
description: Evaluate a retrieval-augmented generation system with litmustest. Separates retrieval failures from generation failures, turns each into failure modes and binary checks on tasks (code checks on retrieved ids first, judges for faithfulness and relevance), builds a retrieval dataset from real or synthetic questions, and compares retrieval or chunking changes with paired runs. Use when the product retrieves documents before answering and you need to know whether it finds the right context and uses it faithfully.
---

<!-- Modified from ai-evals-course/evals-skills (Apache 2.0): the retrieval-then-generation method is the course's; mapping it onto tasks, binary checks, failure modes and paired runs is litmustest's. -->

# Evaluate a RAG system

You are evaluating a system that retrieves context and then answers from it. The output is failure modes, code checks, judges and tasks under `evals/`, uncommitted on the branch. A person commits them.

Three rules from `CLAUDE.md` bind you:

1. `evals/` in git is the source of truth. You write files there; nothing else.
2. You propose, people decide. Never commit, never push. Reading traces and labelling are human.
3. No judge counts until it is calibrated (TPR and TNR at or above 90% on the test split).

Every check is binary. Code checks come before judges.

## Phase 1: Error analysis first

Do not pick metrics before reading traces. If there are no failure modes yet, run `error-discovery`. For each failing trace the reviewer notes, ask one question: did the answer fail because the right chunk was never retrieved, or because the model misused a chunk it had? Fix retrieval first: a model cannot answer from context it never saw.

Make sure the trace records retrieval. In the JSONL shape, the retriever is a tool call: `{"name": "search_docs", "args": {"query": ...}, "result": [{"id": "doc_12#3", "rank": 1, ...}]}`. Without retrieved ids in the trace, retrieval cannot be checked; say so and help add them to the agent's logging.

## Phase 2: Name the failure modes

Split retrieval from generation. Typical modes, each its own file under `evals/failure_modes/`:

| Stage | Failure mode | Check |
| --- | --- | --- |
| Retrieval | `missed_relevant_chunk`: a needed chunk is not in the top k | code |
| Retrieval | `relevant_chunk_ranked_low`: the key chunk is retrieved but below rank r | code |
| Retrieval | `missed_second_hop`: a multi-hop question lacks one of its chunks | code |
| Generation | `cited_unretrieved_source`: the answer cites an id that was not retrieved | code |
| Generation | `ungrounded_claim`: a claim absent from the retrieved context, even if true | judge |
| Generation | `misread_context`: context is represented wrongly | judge |
| Generation | `omitted_key_fact`: relevant retrieved information is ignored | judge |
| Generation | `off_query_answer`: faithful to the context but does not answer the question | judge |

Use the names the reviewer's notes support, not this list. One failure per mode; a definition that says what Pass and Fail look like.

## Phase 3: Build retrieval tasks

A retrieval task pairs a query with the chunk ids that answer it. It is an ordinary task (`docs/SCHEMAS.md`, `task`):

```yaml
id: refund_window_lookup
suite: capability
source: trace:tr_0142          # or synthetic:<slug>, or spec:<slug>
input: { message: "How long do I have to ask for a refund?" }
reference_solution: refs/refund_window_lookup.json
checks:
  - id: recall_at_5
    type: code
    fn: graders/code/recall_at_k.py
    args: { tool: search_docs, k: 5, relevant: ["policy_refunds#2"] }
    failure_mode: missed_relevant_chunk
    weight: 2
  - id: grounded
    type: judge
    failure_mode: ungrounded_claim
```

Where the questions come from, best first:

- **Real queries** promoted from traces (`source: trace:<id>`), with the relevant chunk ids chosen by a person.
- **Synthetic questions** (`source: synthetic:<slug>`): for a chunk, ask a model for one self-contained fact and a question only that fact answers. For harder cases, take a target chunk and two similar chunks that lack the answer, and write a question in the distractors' vocabulary that only the target answers. Keep the generated questions a person rates as realistic; this filtering is the one place a 1-5 rating is fine, because it only ranks candidates. Use `generate-synthetic-data` for the mechanics.

Re-check against real queries regularly; do not overfit to synthetic ones.

## Phase 4: Write the code checks

Use `write-code-eval` for each. Each check is binary, so a metric becomes a threshold in `args`:

- **Recall@k** for first-pass retrieval: Pass when every id in `args.relevant` is in the top `k` results of `args.tool`. Recall matters most; extra noise costs less than a missing chunk.
- **Rank** for single-fact lookups (the binary form of MRR): Pass when the first relevant id has rank at most `args.max_rank`.
- **Precision@k** for reranking: Pass when at least `args.min_relevant` of the top `k` are in `args.relevant`.
- **Two-hop recall@k**: Pass when both hop ids are in the top `k`. In the failing case, say whether hop one or hop two was missed.
- **Citations**: Pass when every id cited in `output` appears in a retrieval result.

Choose `k` by query type: 1 to 2 for a fact lookup, 5 to 10 for synthesis. The reference solution's `tool_calls` must show a correct retrieval so `litmustest validate --deep` passes.

## Phase 5: Write the judges

Use `write-judge-prompt` for faithfulness, misreading, omission and relevance, one judge per mode. Give each judge only what it needs: `inputs: [tool_calls, output]` for grounding (the retrieved chunks are the tool results), add `input` for relevance. For long documents, have the retriever log the chunk text, not whole documents. Then `validate-evaluator`. Never use ROUGE, BERTScore or embedding similarity as the generation check.

Read the pattern across checks:

| Retrieval | Grounded | On-query | Diagnosis |
| --- | --- | --- | --- |
| Fail | any | any | Retrieval: chunking, embeddings or query rewriting |
| Pass | Fail | any | Hallucination or misreading of good context |
| Pass | Pass | Fail | The model used the wrong part of a right document |

## Phase 6: Compare retrieval changes

Treat chunk size, overlap and content-aware chunking (section boundaries, titles prepended) as settings to test. For each setting, re-index, run the retrieval tasks, and compare against the baseline over the same tasks:

```bash
litmustest run --suite capability --id chunk_256_o128
litmustest compare chunk_512_o0 chunk_256_o128
```

`compare` is paired: a per-suite delta with a bootstrap interval, significant or within noise, and the tasks that broke or got fixed. Report the deltas with their intervals, not raw pass rates. Record which setting each run used in the run id or the commit.

## Report and stop

Tell the user: which failures are retrieval and which generation, the modes and checks you wrote, the tasks and where their questions came from, and any comparison with its interval. Everything is pending on the branch. Stop. Do not commit.

## What you never do

- Score retrieval and generation with one end-to-end number.
- Pick metrics before reading traces.
- Label traces or choose relevant chunk ids on the reviewer's behalf without showing them.
- Commit, push or switch branches.
