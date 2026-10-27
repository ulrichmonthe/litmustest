# support-agent example

A small but real target for litmustest: a billing support agent for a subscription product, the traces it produced, and a seeded `evals/` directory that exercises every schema. Everything here is generated from `src/catalog.ts`, so the planted failures, the labels and the tasks agree with each other.

## Ten minutes from clone to a populated review queue

```bash
git clone https://github.com/ulrichmonthe/litmustest && cd litmustest
npm install
npm run example:seed                                   # 300 traces + the evals/ directory, no API key needed
npm run build
node packages/cli/dist/main.js ingest examples/support-agent/traces/support.jsonl --dir examples/support-agent/evals
                                                       # clusters the traces and writes a review batch with a coverage report
node packages/cli/dist/main.js validate examples/support-agent/evals --deep   # every file checks out
node packages/cli/dist/main.js serve --dir examples/support-agent/evals    # the dashboard on http://127.0.0.1:4242
```

The Review queue opens on the batch: `j`/`k` move, `p`/`f` label, `n` focuses the note, Enter saves and advances. Labels append to `evals/labels/<batch>.jsonl` and show up in the Pending changes tray, from where you commit to an `evals/<slug>` branch. From the queue, "Ask Claude to regroup notes" proposes failure-mode files from the notes as diffs; nothing is written until you accept. The Overview reads the two seeded runs (verdict, suite scorecards with margins, needs-attention, Pareto, judge trust, flips) and Failure modes edits the files in place. Judges shows the calibration stepper: edit the prompt and few-shot examples, run the dev set, run the held-out test set once, trusted. `tone_mismatch` ships trusted and `missed_refund` stale, so both halves of the flow are visible. Tasks, Run compare, Transcripts and Settings arrive with Phase 3.

## What is in here

| Path | What |
| --- | --- |
| `prompt.md` | The agent's one prompt file |
| `src/catalog.ts` | Accounts, policy, ten scenarios, three personas, seven failure modes with planted rates |
| `src/db.ts`, `environments/seed.sqlite` | SQLite schema (`accounts`, `invoices`, `refunds`, `tickets`, `confirmations`, `audit`) and the seed; `freshDb()` copies it per trial |
| `src/tools.ts` | The five tools: `verify_identity`, `fetch_invoices`, `fetch_policy`, `process_refund`, `send_confirmation` |
| `src/agent.ts` | The agent: a tool-use loop on `claude-opus-5-5`, recording every turn and call |
| `src/simulated_user.ts` | Plays a frustrated, business or first-time customer for multi-turn tasks |
| `src/run_trial.ts` | Runs one task once in a fresh database; writes `trial.json` (reference-solution shape) and `trace.json`. The task's `input.from` (the ticket's sender address) is shown to the agent above the message |
| `src/generate_traces.ts` | 300 synthetic traces with planted failures; writes `traces/` and `evals/datasets/traces/` |
| `src/seed_evals.ts` | Writes the rest of `evals/`: failure modes, tasks, refs, graders, labels, suites, runs |
| `traces/support.jsonl` | The plain log a team would have before litmustest (adapter input) |
| `traces/planted_truth.jsonl` | Which failures were planted in which trace, so calibration numbers can be checked |
| `environments/harbor/` | A Harbor task for the same agent (untested until decision #2) |

## Planted failure rates

| Failure mode | Target | Applies to |
| --- | --- | --- |
| `tone_mismatch` | 12% | frustrated and business personas |
| `missed_refund` | 8% | refund scenarios |
| `ungrounded_policy` | 6% | scenarios with a policy question |
| `over_searching` | 4% | all |
| `wrong_tool_args` | 2% | refund scenarios |
| `identity_leak` | 1% | all |
| `skipped_confirmation` | 3% | scenarios that end with a confirmation |

Realised counts print when you run `npm run generate-traces`. Because some modes only apply to some scenarios, the realised rate over all 300 traces is a little below the target for those modes.

## The seeded evals

- **7 failure modes**, the table above.
- **40 tasks** in three suites: regression (promoted from traces), capability (written from the spec), quality (judge-only, tone). One is deliberately broken (`refund_ghost_account_frustrated`: the account does not exist, so no agent can verify it; the run summaries flag it `likely_broken`) and one is flaky (`invoice_copy_frustrated`, flagged `flaky`). The three `cancel_monthly_*` tasks sit in the capability suite because the agent has no cancellation tool yet; they are the hill to climb.
- **2 code checks**: `identity_verified_first.py`, `confirmation_sent.py`.
- **2 judges**: `tone_mismatch` is trusted (test TPR 90 / TNR 100); `missed_refund` is stale because its prompt was edited after its test run, so its verdicts are excluded from gates until it is re-calibrated.
- **100 labels** over the two judged failure modes, balanced, drawn from the planted truth.
- **2 run summaries** (`run_0040`, `run_0041`) so `compare` has something to compare.

## Running the agent for real

```bash
export ANTHROPIC_API_KEY=...   # or `ant auth login`
npm run trial -- --task duplicate_charge_frustrated          # one turn
npm run trial -- --task cancel_monthly_business --multi      # simulated customer keeps talking
```

Each trial gets its own copy of the database under `.litmustest/trials/`. A safety refusal from the model ends the turn and is recorded in the transcript as `[refusal]`.
