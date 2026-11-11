# Labelling study

The protocol for the one Phase 1 acceptance line that code cannot close (`docs/ACCEPTANCE.md`):

> A domain expert who has read guide chapters 3, 6 and 7 can label 50 traces in under an hour without asking an engineer anything.

**Status: not run.** This is a study with people. Nothing here has been done yet, and the box stays open until the results table at the end is filled in from real sessions. An agent cannot run it: reading traces and labelling are human-only (`CLAUDE.md`, rule 2).

## What the line claims

Three things, each measured separately:

1. **Speed.** 50 traces labelled in under 60 minutes of working time.
2. **Independence.** Zero questions that only an engineer could answer.
3. **Preparation is enough.** The only preparation is reading guide chapters 3, 6 and 7. No walkthrough, no demo.

Speed without quality would be a hollow pass, so the study also checks that the labels are usable (see Pass criteria).

## Participants

- **Three domain experts**, run one at a time. One session can pass or fail by luck; three shows whether the result repeats. Fewer than three is a pilot, not a result.
- A domain expert here is someone who knows the product's subject (for the example: subscription billing support) and does not write code for it. Support leads, operations, policy owners.
- **Exclude** anyone who has used the litmustest dashboard, watched it being built, or works as an engineer on the product.
- Record for each: role, years in the domain, whether they have labelled data before.

## Materials

- The review queue served from the example repo, on a laptop with a keyboard:

```bash
node packages/cli/dist/main.js serve --dir examples/support-agent/evals
```

- A review batch of **60 traces** the participant has never seen (50 to label, 10 spare), sampled with `litmustest ingest`. Use the same batch for all three participants so their labels can be compared.
- The failure modes already defined in `examples/support-agent/evals/failure_modes/`. Participants may also write a note that fits none.
- Guide chapters 3, 6 and 7, sent **two days before**, with one line: "Please read these before the session. That is all the preparation there is."
- A short product brief (one page, written by the product owner, not by an engineer): what the support agent is for and what its policies are. This is domain context an expert at the company would already have; it is not litmustest help.
- A facilitator and, in a different room or on call, an engineer who answers only when the facilitator relays a question.
- Screen and audio recording, with consent.

Before the first session, run one **pilot** with a colleague to check the setup. Do not count it.

## Procedure

| Step | Time | What happens |
| --- | --- | --- |
| 1. Welcome | 3 min | Consent to record. "We are testing the tool, not you. If you get stuck, try to work it out as you would alone; if you cannot, tell me." |
| 2. Reading check | 2 min | "Did you read the three chapters? Roughly how long did it take?" Record the answer. Do not summarise the chapters for them. |
| 3. Start | 0 min | Open the review queue on the batch. Say: "Please label the first 50 conversations: did the agent do the right thing, and if not, what went wrong. Start when you are ready." Start the clock at their first keypress or click in the queue. |
| 4. Labelling | up to 75 min | The facilitator stays silent. Stop the clock when the 50th label is saved. If 75 minutes pass first, stop and record how many were done. |
| 5. Debrief | 10 min | The questions below. |

**The facilitator's rules**

- Do not explain the interface, the shortcuts, the failure modes or the method. The on-screen help (the `?` panel, the glossary, Plain language) is part of the product and may be used freely.
- If the participant asks a question, first say: "What would you try?" If they remain stuck for two minutes, log the question, relay it to the engineer, give the answer, and mark the question as answered by an engineer.
- Pauses the participant chooses (a break, a phone call) stop the clock. Time spent stuck does not.

## What to record

**The timing sheet**, one row per trace, filled from the recording afterwards:

| # | Trace id | Seconds | Verdict | Failure modes chosen | Note written (y/n) | Help opened (y/n) | Question asked |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | | | | | | | |

The label files give the verdict, modes, note and save time without transcription: each line of `evals/labels/<batch>.jsonl` carries `trace_id`, `label`, `failure_mode`, `note`, `annotator` and `at`. Seconds per trace is the gap between consecutive `at` values, checked against the recording for pauses.

**The question log**, one row per question:

| Time | What they asked, word for word | Class | Who answered |
| --- | --- | --- | --- |

Classes:

- **Engineer**: only someone who knows the system's internals could answer. "What does `verify_identity` returning null mean?" "Is this JSON an error?" "Where did my label go?"
- **Tool**: about using litmustest, and the answer is on screen. "How do I go back?" Counts against independence only if they could not find the answer themselves within two minutes.
- **Domain**: about the product's policy. "Is a refund due after 30 days?" Not counted: that is the expert's own field or the product brief's job.
- **Study**: about the session. "Should I keep going?" Not counted.

Two people classify the questions independently after the session and settle disagreements before looking at the totals.

**Debrief questions**

1. What was the hardest conversation to judge, and why?
2. Was there anything on screen you did not understand? What did you do about it?
3. Did you use the `?` help or hover a term? Did it answer your question?
4. Was there a moment you wanted to ask someone something and did not?
5. Which failure mode was hardest to tell apart from another?
6. Would you do another 50 tomorrow? What would make it faster?

## Pass criteria

Decide these before the first session and do not move them afterwards.

A **session passes** when all four hold:

| Criterion | Threshold |
| --- | --- |
| Speed | 50 labels saved in 60:00 or less of working time |
| Independence | 0 questions classed Engineer; 0 Tool questions that needed the engineer |
| Completeness | Every Fail has a failure mode or a note saying what went wrong |
| Usable labels | Agreement with a reference set on the overall verdict of at least 80% (see below) |

The **acceptance line passes** when at least **two of the three** sessions pass, and no session had more than one Engineer question. One pass is a pilot result; say so.

**The reference set.** Before the study, the product owner and one other person label the same 50 traces independently, then reconcile. That reconciled set is the reference. Report each participant's raw agreement with it and Cohen's kappa. 80% is a floor for "the labels are usable to start error discovery", not a claim that the expert is wrong where they differ: read every disagreement, because some will be the reference's mistake or an unclear failure-mode definition, and those are findings too.

## What a failure tells you

A failed criterion is the useful output. Map it to a cause before changing anything:

| Observation | Likely cause | Where to look |
| --- | --- | --- |
| Slow on every trace | Reading cost: long tool-call JSON, too much scrolling | The trace renderer; the `build-review-interface` skill |
| Slow on the first ten, fast after | Learning the interface | Onboarding, the shortcut legend, the first-run help |
| Engineer questions about tool calls | The trace shows internals in the system's words | The renderer's labels; the product brief |
| Tool questions the help could not answer | A missing or unclear glossary term | `plugin/glossary/terms.yaml` |
| Many Fails with no failure mode | The modes do not cover what experts see | Run error discovery on their notes |
| Low agreement on one failure mode | Its definition does not say what Pass and Fail look like | That mode's `definition` |
| Did not read the chapters, or they did not help | The preparation is wrong, not the tool | The guide |

Fix, then run the study again with **new** participants: someone who has done it once is no longer a first-time expert.

## Reporting

Fill this in from real sessions only. Leave a cell empty rather than estimate it.

| Participant | Role | Date | Read chapters (min) | Labels in 60 min | Time to 50 | Engineer questions | Tool questions needing help | Fails without a reason | Agreement with reference | Kappa | Pass |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| P1 | | | | | | | | | | | |
| P2 | | | | | | | | | | | |
| P3 | | | | | | | | | | | |

Then: the verdict against the acceptance line, the question log in full, the three most common causes of delay, and what was changed as a result. When two of three pass, tick the line in `docs/ACCEPTANCE.md` with the date and a link to the filled-in table.

## Limits of this study

- Three people is enough to see whether the claim holds roughly, not to estimate a rate. Do not report "expert labelling takes N minutes" from it.
- The example product is simple. A product with longer conversations or denser tool output will be slower; rerun on your own traces before relying on the hour.
- A facilitator in the room changes behaviour. People ask fewer questions when watched, which flatters independence. Debrief question 4 is there to catch that.
- "Guide chapters 3, 6 and 7" must exist in a form a domain expert can be sent. If they do not, that is the first finding.
