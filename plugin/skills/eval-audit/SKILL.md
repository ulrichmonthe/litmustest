---
name: eval-audit
description: Audit an eval setup and report its problems in order of impact, each with the litmustest skill or command that fixes it. Runs `litmustest validate --deep`, `litmustest doctor` and `litmustest coverage`, then inspects failure modes, graders, calibrations, labels and runs. Use when inheriting evals, when unsure whether the numbers can be trusted, or before building more graders. Do not use to build a new grader; use error-discovery, write-code-eval or write-judge-prompt.
---

<!-- Modified from ai-evals-course/evals-skills (Apache 2.0): the six diagnostic areas are the course's; the checks read the litmustest files and CLI output, and Anthropic's task, trial and suite checks are added. -->

# Eval audit

You inspect an eval setup and produce a short, prioritized list of real problems, each with a concrete fix. The output is a report in the conversation. This skill writes no files; fixes happen through the skills it names.

Three rules from `CLAUDE.md` bind you:

1. `evals/` in git is the source of truth. Audit the files, not what people say the setup does.
2. You propose, people decide. Never commit, never push, never "fix while auditing".
3. Reading traces and labeling are human work. You may count labels; you never add or change one.

## Phase 1: Find the artifacts

If `evals/litmustest.yaml` exists, the audit runs on it. If the team has evals elsewhere (notebooks, scripts, a platform such as Langfuse or Braintrust), read those files and apply the same six areas; then recommend `litmustest init` and `error-discovery` to bring them into `evals/`. If there is nothing at all, skip to "No eval setup".

## Phase 2: Run the three commands

```bash
litmustest validate --deep
litmustest doctor
litmustest coverage --gaps 10
```

Add `--json` to any of them if you want to parse the output. Read all three before judging anything:

- `validate --deep`: schema and cross-file errors, stale judges, few-shot leakage, and `reference_passes` (each task's code, outcome and transcript checks run against its reference solution). A reference that fails its own checks means the task is broken, not the agent.
- `doctor`: stale or untested judges, broken and flaky tasks, saturation, graduation candidates, unlabelled traces, and the next step.
- `coverage`: spec, surface and risk maps with depth (guarded, checked, planned, none). High-severity failure modes with no counting check are top findings. Coverage v1 does not measure production traffic, code lines or the frontend; do not claim it does.

## Phase 3: Inspect the six areas

Look at the files behind each finding. A checklist run without reading the artifacts is not an audit.

### 1. Error analysis

- Are there files under `evals/failure_modes/`? Do they have `examples` (trace ids) and labels with notes behind them in `evals/labels/*.jsonl`?
- Were modes observed or brainstormed? Generic names (`hallucination`, `helpfulness`, `coherence`) with no example traces suggest brainstorming. Application names (`ungrounded_policy`, `missed_refund`) suggest observation.
- Fix: `error-discovery`; `generate-synthetic-data` first if there are no traces.

### 2. Grader design

- Every check is binary by schema. Look inside `graders/code/*.py` for checks that compute a score and pass on an arbitrary threshold, or use similarity metrics (ROUGE, BLEU, BERTScore, cosine, embedding distance) as the verdict. These measure overlap, not correctness.
- Read each `graders/judges/<name>/prompt.md`. A judge must target exactly one failure mode with explicit Pass and Fail definitions. Flag holistic prompts ("is this response good?").
- Flag judges used for objective criteria: format, schema, a tool called or not, a value in the end state. Those belong in a code, transcript or outcome check. Code checks come before judges.
- Agents that change things: do tasks have `outcome` checks on the real end state, or only judges on the final message?
- Fix: `write-code-eval`, `write-judge-prompt`, `define-task`.

### 3. Judge validation

- For each judge, read `calibration.json` `status`. Only `trusted` counts in scores and gates. `untested`, `dev` and `stale` judges are excluded; say how many checks that removes.
- Is the test interval wide? A trusted judge with 12 test labels has a TPR interval too wide to lean on.
- Few-shot examples must come from the train split. `validate` reports `no_leakage` and `few_shot_from_train`.
- If the team reports judge "accuracy" or "agreement" anywhere outside litmustest (a slide, a README), flag it: with class imbalance, accuracy hides a judge that never says Fail. litmustest measures TPR and TNR.
- Fix: `validate-evaluator`. Never edit `calibration.json` by hand; `litmustest calibrate` writes it.

### 4. Human review

- Who labels? Read `annotator` across `evals/labels/*.jsonl`. One annotator with no domain role, or labels only from an outsourced pool, is a finding. A second annotator on a sample gives agreement.
- Do reviewers see the full trace? Open a few files under `evals/datasets/traces/`. If every trace is one user turn and one agent turn, the source had no `messages` or `tool_calls` and reviewers are judging outputs only. Fix the source or the conversion script.
- Can they judge it as shown? Start `litmustest serve` and look at the review queue. If the trace shape needs rendering the queue lacks, that is `build-review-interface`.

### 5. Labeled data

- Count labels per failure mode and per value. Error analysis saturates around 100 traces. Judge calibration needs roughly 50 Pass and 50 Fail per mode; fewer makes TPR/TNR unreliable.
- Read the latest `evals/batches/*.yaml` coverage: are some clusters unsampled? Does every batch keep random items? The clustering cannot know what it missed.
- Fix: `litmustest ingest <source> --size N --seed S` for another batch, `litmustest sample` for production traffic, `generate-synthetic-data` for thin regions.

### 6. Pipeline hygiene and runs

- When was the last batch, and the last change to the product's prompt or model (`git log` on those files)? Error analysis older than a big change is stale.
- `sources.sampler.every` is `manual` and no sampler workflow exists: nobody re-reads production.
- Runs: are there summaries under `evals/runs/`? Trials below 5 give no pass^k. Infra failures should be tagged and excluded, not counted as agent failures.
- Suites and gates: does `regression` have a gate in `litmustest.yaml`? Are capability tasks saturated and never graduated?
- Fix: `analyze-run`, `triage-failures`, `graduate-suite`, `litmustest ci --write-workflow` (a person enables it).

## No eval setup

1. `litmustest init`, then `error-discovery` on real traces.
2. No production data: `generate-synthetic-data`, run the inputs through the product, then `error-discovery`.
3. Do not recommend graders, judges or gates before error analysis has named failure modes.

## Report format

Order by impact on the product, most harmful first. Group under the six areas and leave out areas with no problem.

```
### <Problem title>
Status: problem / OK / cannot tell
<One or two sentences on what you found, naming files, ids and counts.>
Fix: <skill, or the exact CLI command to run>
```

End with the one next step, usually the `next:` line from `doctor` unless a higher-impact finding overrides it.

## What you never do

- Report generic advice that is not tied to a file you read.
- Recommend a judge for something code can check.
- Edit, commit or "tidy" files during the audit. Re-audit after the team makes changes.
