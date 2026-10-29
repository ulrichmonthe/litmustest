---
name: write-judge-prompt
description: Write a model judge for one failure mode with litmustest. Drafts graders/judges/<name>/{prompt.md,judge.yaml,calibration.json} with binary Pass/Fail/Unknown verdicts, critique before verdict, few-shot examples from the train split only, and a pinned model id, then hands off to calibration. Use when a failure mode needs interpretation (tone, faithfulness, relevance, completeness) that a code check cannot decide. Use write-code-eval when code can decide; use validate-evaluator to calibrate an existing judge.
---

<!-- Modified from ai-evals-course/evals-skills (Apache 2.0): the four-part judge is the course's; the files, the split-backed few-shot and the draft command are litmustest's. -->

# Write a judge

You are writing a judge for one failure mode that already exists under `evals/failure_modes/<name>.yaml`. The output is a judge directory under `evals/graders/judges/<name>/`, uncommitted on the branch. A judge counts in no score or gate until `validate-evaluator` makes it trusted.

Three rules from `CLAUDE.md` bind you:

1. `evals/` in git is the source of truth. You write files there; nothing else.
2. You propose, people decide. Never commit, never push.
3. No judge counts until it is calibrated: TPR and TNR at or above 90% on a held-out test set, run once. Labels are human; you never write one.

## Before you start

Check three things and say what you found:

- **A code check cannot do it.** Exhaust code first. Many modes that look subjective reduce to structure: which tool ran, whether a figure in the output matches a tool result, whether a hedge word appears. If code can do it, use `write-code-eval`.
- **The prompt asked for the behaviour.** If the product's own prompt never told the agent to do this, the fix is the product prompt, not a judge. A judge can still guard a critical requirement afterwards.
- **There are labels.** The judge's labels are lines in `evals/labels/*.jsonl` with `failure_mode: <name>`, Pass or Fail. `overall` labels do not count. `draft-judge` needs at least 6 with both Pass and Fail in the train split; calibration wants 60 or more, roughly balanced. If there are too few, send the reviewer back to the review queue (`litmustest serve`) to label this mode's chip.

## The four parts of a judge

**1. Task and one criterion.** The prompt names one failure mode and nothing else. "You check one failure mode: missed_refund." Never "is this response good", never two modes in one judge.

**2. Pass and Fail definitions.** Binary, from the failure-mode definition and the reviewers' notes. Say what Fail looks like with concrete examples, and what Pass looks like, including "the situation never arose". Pass means the failure is absent; Fail means it is present. No scales, no grades, no partial credit. If you need severity, write two binary modes.

**3. Few-shot examples from the train split only.** They live in `judge.yaml` under `few_shot`, by `trace_id`, with a `note` saying why. The runner renders the traces into the prompt. Rules:

- Every `trace_id` must be in `calibration.json` `splits.train`. `litmustest calibrate` refuses a judge whose examples sit in dev or test; that is leakage.
- One clear Fail, one clear Pass, and one borderline case. Borderline teaches the most.
- Two to four examples. More rarely helps; the schema allows ten.
- The note is a real critique: what the agent did, with the evidence, and why that meets or misses the definition. It sets the bar for the judge's own critiques.

**4. Structured output, critique first.** `judge.yaml` declares it:

```yaml
output:
  critique: { type: string, max_chars: 800 }
  result: { enum: [Pass, Fail, Unknown] }
```

The runner asks for JSON `{critique, result}` with the critique written first. Unknown is allowed when what the judge was shown cannot settle it; it is counted separately, never as a Pass.

## Phase 1: Draft

```bash
litmustest draft-judge <failure_mode>
```

It reads the mode's definition and the reviewers' notes, makes the 15/45/40 train/dev/test split, and writes:

- `prompt.md`: the task, the Pass and Fail definitions, and the instruction to critique first
- `judge.yaml`: `failure_mode`, `model`, `inputs`, `output`, three `few_shot` from train, `prompt_hash`, `temperature: 0`, `version`
- `calibration.json` with the splits and `status: untested` (written by `calibrate --split none`, the only writer)

Needs `ANTHROPIC_API_KEY`. You can write `prompt.md` and `judge.yaml` yourself instead; then run `litmustest calibrate <failure_mode> --split none` to create the splits, and pick few-shot ids from `splits.train`. Use `examples/support-agent/evals/graders/judges/missed_refund/` as the shape.

## Phase 2: Review the draft

Read the drafted prompt against the reviewers' notes and fix what is weak:

- Definitions are concrete and drawn from what reviewers actually wrote.
- `inputs` feeds only what the judge needs: `transcript`, `output`, `input`, `state`, `tool_calls`, `reference`. Tone needs the persona and the reply. Grounding needs the tool results and the reply. Tool misuse needs `tool_calls`. Less is more accurate.
- The few-shot set has a borderline case and real notes, not "see the agent's reply".

## Model

`model` is one exact id, such as `claude-opus-5-5`, or a dated snapshot where the provider issues them. Never a floating alias; the schema rejects ids ending in `latest`, `preview` or `beta`. `draft-judge` uses `judges.default_model` from `litmustest.yaml`. Start with a capable model; optimise cost only after the judge is trusted. Changing the model later marks the judge stale.

## Keeping the files consistent

- `prompt_hash` in `judge.yaml` is the SHA-256 of `prompt.md`. `draft-judge` and a save through the dashboard set it. If you edit `prompt.md` by hand, update it (`shasum -a 256 evals/graders/judges/<name>/prompt.md`) and bump `version`.
- Never edit `calibration.json`.
- Run `litmustest validate`. It recomputes the hash and checks that every few-shot id is in train.

## Wire it into tasks

```yaml
checks:
  - id: tone
    type: judge
    failure_mode: tone_mismatch     # judge defaults to the failure mode's name
    weight: 1
```

Judges usually belong in the quality suite. An untrusted judge's verdicts are recorded but excluded from scores and gates.

## Report and stop

Tell the user: the criterion, the inputs, the three few-shot traces and why each, the model id, the split sizes, and the next step: `validate-evaluator` (`litmustest calibrate <name> --split dev`). The files are pending on the branch. Stop. Do not commit.

## What you never do

- One judge for several failure modes, or a holistic "quality" judge.
- Likert scales, grades or scores.
- Few-shot examples from dev or test.
- A floating model alias.
- Edit `calibration.json` or a label; commit or push.
