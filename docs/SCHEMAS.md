# Schemas

Generated from `schemas/*.json` by `npm run docs:schemas`. Do not edit by hand.

Every file under `evals/` has a JSON Schema (draft 2020-12), versioned under `https://litmustest.dev/schemas/v1/`. `litmustest validate` checks every file against its schema and then applies the cross-file rules listed at the end.

| Schema | File | Purpose |
| --- | --- | --- |
| [config](#config) | `evals/litmustest.yaml` | Config |
| [failure_mode](#failure_mode) | `evals/failure_modes/<name>.yaml` | Failure mode |
| [task](#task) | `evals/tasks/**/<id>.yaml` | Task |
| [check.code](#checkcode) | `inline in a task` | Code check |
| [check.judge](#checkjudge) | `inline in a task` | Judge check |
| [check.outcome](#checkoutcome) | `inline in a task` | Outcome check |
| [check.transcript](#checktranscript) | `inline in a task` | Transcript check |
| [reference_solution](#reference_solution) | `evals/refs/<task id>.json` | Reference solution |
| [judge](#judge) | `evals/graders/judges/<name>/judge.yaml` | Judge |
| [calibration](#calibration) | `evals/graders/judges/<name>/calibration.json` | Calibration |
| [label](#label) | `evals/labels/<batch>.jsonl (one object per line)` | Label |
| [suite](#suite) | `evals/suites/<name>.yaml` | Suite |
| [run_summary](#run_summary) | `evals/runs/<run id>.json` | Run summary |
| [trace](#trace) | `evals/datasets/traces/<id>.json` | Trace |
| [trace.jsonl_adapter](#tracejsonl_adapter) | `ingest input only; never stored` | JSONL trace (adapter input) |

Shared definitions (names, timestamps, model ids, gates, confusion matrices) live in [common](#common).

## config

evals/litmustest.yaml. Where traces come from, how runs execute, how judges are trusted, what CI enforces, and where results go.

| Field | Type | Required | Constraints | Description |
| --- | --- | --- | --- | --- |
| `version` | `1` |  | default `1` | Config schema version. |
| `project` | [name](#name) | yes |  | The project this evals/ folder belongs to. |
| `sources` | object | yes |  | Where traces come from. |
| `runs` | object | yes |  | How tasks execute. |
| `judges` | object | yes |  | Defaults for judge checks. |
| `gates` | map of [gate](#gate) | yes |  | Per-suite gates, keyed by suite name. |
| `storage` | object |  |  | Where run output goes. Summaries are small and go in git; transcripts are evidence and get a stable address. |
| `ci` | object |  |  |  |

#### `sources`

| Field | Type | Required | Constraints | Description |
| --- | --- | --- | --- | --- |
| `traces` | object | yes |  |  |
| `sampler` | object |  |  | How a review batch is drawn from the source. |

##### `traces`

| Field | Type | Required | Constraints | Description |
| --- | --- | --- | --- | --- |
| `format` | `otel` · `jsonl` · `langfuse` · `braintrust` · `langsmith` | yes |  | otel and jsonl ship in Phase 1; the platform adapters are Phase 4. |
| `path` | string | yes | min length 1 | A file or glob, relative to the repo root. |

##### `sampler`

| Field | Type | Required | Constraints | Description |
| --- | --- | --- | --- | --- |
| `every` | `manual` · `daily` · `weekly` |  | default `"manual"` |  |
| `size` | integer |  | ≥ 1, ≤ 1000, default `60` | Traces per batch. |
| `clusters` | integer |  | ≥ 1, ≤ 100, default `8` | Number of clusters; one representative per cluster, the rest random. |

#### `runs`

| Field | Type | Required | Constraints | Description |
| --- | --- | --- | --- | --- |
| `trials` | integer |  | ≥ 1, ≤ 100, default `5` | Trials per task unless the task overrides. |
| `concurrency` | integer |  | ≥ 1, ≤ 256, default `8` |  |
| `budget_usd` | number |  | ≥ 0 | Stop the run when spend crosses this. |
| `environment` | `inprocess` · `harbor` · `docker` |  | default `"inprocess"` | Where each trial runs. Harbor and docker give a clean container per trial. |
| `resources` | object |  |  |  |

##### `resources`

| Field | Type | Required | Constraints | Description |
| --- | --- | --- | --- | --- |
| `cpus` | number |  | > 0 |  |
| `memory_mb` | integer |  | ≥ 128 |  |
| `timeout_s` | integer |  | ≥ 1, default `600` |  |

#### `judges`

| Field | Type | Required | Constraints | Description |
| --- | --- | --- | --- | --- |
| `default_model` | [model_id](#model_id) |  |  | Model used by a judge that does not pin its own. Must be a dated snapshot. |
| `trust_threshold` | number |  | ≥ 50, ≤ 100, default `90` | TPR and TNR (percent) a judge needs on the held-out test set to be trusted. |
| `stale_on_change` | boolean |  | default `true` | Mark a judge stale when its prompt hash or model changes. |
| `correct_for_judge_error` | boolean |  | default `true` | Correct reported pass rates for the judge's measured TPR/TNR. |

#### `storage`

| Field | Type | Required | Constraints | Description |
| --- | --- | --- | --- | --- |
| `summaries` | string |  | default `"evals/runs"` | Directory for run summaries, committed. |
| `transcripts` | object |  |  |  |

##### `transcripts`

| Field | Type | Required | Constraints | Description |
| --- | --- | --- | --- | --- |
| `backend` | `local` · `s3` · `gcs` · `braintrust` · `langfuse` · `langsmith` | yes | default `"local"` |  |
| `path` | string |  |  | Local directory (git-ignored) or bucket URI. |

#### `ci`

| Field | Type | Required | Constraints | Description |
| --- | --- | --- | --- | --- |
| `pr_comment` | boolean |  | default `true` | Post the comparison as a PR comment. |
| `base_run` | `latest_on_base_branch` · `latest` |  | default `"latest_on_base_branch"` | Which run a CI run is compared against. |

## failure_mode

evals/failure_modes/<name>.yaml. One named way the product goes wrong, found by reading traces. Failure modes are tags on the checks inside tasks.

| Field | Type | Required | Constraints | Description |
| --- | --- | --- | --- | --- |
| `name` | [name](#name) | yes |  | Must equal the file name without extension. |
| `definition` | string | yes | min length 20, max length 2000 | What counts as this failure, in plain words a judge and a new annotator can both apply. Say what Pass and Fail look like. |
| `severity` | [severity](#severity) | yes |  |  |
| `owner` | string |  | min length 1 | The person or team who decides what counts. |
| `examples` | array of [trace_id](#trace_id) |  | unique | Trace ids that show the failure clearly. Used in the editor, not as few-shot examples; those live in the judge. |
| `created` | [date](#date) | yes |  |  |
| `retired` | [date](#date) |  |  | Set when the mode is merged or no longer tracked. A retired mode cannot be referenced by a new check. |
| `merged_into` | [name](#name) |  |  | When retired by a merge, the surviving mode. |

## task

evals/tasks/**/<id>.yaml. The unit of work: an input, a reference solution, and binary checks. A task reports both strict pass (all checks) and a weighted score.

| Field | Type | Required | Constraints | Description |
| --- | --- | --- | --- | --- |
| `id` | [name](#name) | yes |  | Must equal the file name without extension. |
| `suite` | [name](#name) | yes |  | The suite this task belongs to. Must exist under evals/suites/. |
| `source` | string | yes | pattern `^(trace:[^\s]+\|spec:[a-z0-9][a-z0-9-]*\|synthetic:[a-z0-9][a-z0-9-]*)$` | Where the task came from: trace:<trace id> for a promoted trace, spec:<slug> for a capability task written from the spec, synthetic:<slug> for generated input. |
| `description` | string |  | max length 1000 | One or two sentences on what this task tests. |
| `input` | object | yes |  | What the agent receives. Free shape; the sample repo uses { persona, message }. |
| `reference_solution` | [relative_path](#relative_path) | yes |  | Path to a reference_solution JSON that must pass every check before the task can join a suite. |
| `trials` | integer |  | ≥ 1, ≤ 100 | Overrides runs.trials in the config. |
| `checks` | array of [check.code](#checkcode) or [check.judge](#checkjudge) or [check.outcome](#checkoutcome) or [check.transcript](#checktranscript) | yes | min 1 items |  |
| `report` | array of `strict_pass` · `weighted_score` · `pass_at_k` · `pass_hat_k` |  | unique, default `["strict_pass","weighted_score","pass_at_k","pass_hat_k"]` |  |
| `tags` | array of [name](#name) |  | unique |  |
| `graduated_from` | [name](#name) |  |  | Set when a saturated capability task moved to regression. |

## check.code

A deterministic check implemented as a function in graders/code/. Preferred over a judge whenever the failure mode is objective.

| Field | Type | Required | Constraints | Description |
| --- | --- | --- | --- | --- |
| `id` | [name](#name) | yes |  |  |
| `type` | `"code"` | yes |  |  |
| `fn` | [relative_path](#relative_path) | yes | pattern `^graders/code/[a-z][a-z0-9_]*\.py$` | Path to a Python file exposing check(trial: dict, args: dict) -> bool. |
| `args` | object |  |  | Passed to the function as its second argument. |
| `weight` | number |  | > 0, default `1` |  |
| `failure_mode` | [name](#name) |  |  | Optional tag. Must name an existing failure mode. |

## check.judge

A model-based check for one failure mode. Counts in a gate only when its judge is trusted.

| Field | Type | Required | Constraints | Description |
| --- | --- | --- | --- | --- |
| `id` | [name](#name) | yes |  |  |
| `type` | `"judge"` | yes |  |  |
| `failure_mode` | [name](#name) | yes |  | The failure mode this check tags. Must exist. |
| `judge` | [name](#name) |  |  | The judge under graders/judges/. Defaults to the failure mode name. |
| `inputs` | array of `transcript` · `output` · `input` · `state` · `tool_calls` · `reference` |  | unique | What the judge is shown. Defaults to the judge's own inputs list. |
| `weight` | number |  | > 0, default `1` |  |

## check.outcome

Reads the real end state after a trial (a database row, a file, an HTTP resource, a page) and compares it to what should be there.

| Field | Type | Required | Constraints | Description |
| --- | --- | --- | --- | --- |
| `id` | [name](#name) | yes |  |  |
| `type` | `"outcome"` | yes |  |  |
| `backend` | `sql` · `fs` · `http` · `page` |  | default `"sql"` | How the state is read. |
| `expect` | object | yes |  | Dotted path to a value in the state snapshot, e.g. refunds.status: processed. Every entry must match. |
| `weight` | number |  | > 0, default `1` |  |
| `failure_mode` | [name](#name) |  |  |  |

## check.transcript

A check on how the agent got there rather than what it produced. Always flagged path_check: true, and off by default in capability suites.

| Field | Type | Required | Constraints | Description |
| --- | --- | --- | --- | --- |
| `id` | [name](#name) | yes |  |  |
| `type` | `"transcript"` | yes |  |  |
| `path_check` | `true` | yes |  | Marks this as a path check so suites can switch it off. |
| `max_turns` | integer |  | ≥ 1 |  |
| `max_toolcalls` | integer |  | ≥ 0 |  |
| `required_tools` | array of [name](#name) |  | min 1 items, unique | Each must be called at least once. |
| `forbidden_tools` | array of [name](#name) |  | min 1 items, unique | None may be called. |
| `weight` | number |  | > 0, default `1` |  |
| `failure_mode` | [name](#name) |  |  |  |

## reference_solution

evals/refs/<task id>.json. A known-good trial for a task: the output, end state, and tool calls that every check on the task must pass. Confirms the task is unambiguous.

| Field | Type | Required | Constraints | Description |
| --- | --- | --- | --- | --- |
| `task` | [name](#name) | yes |  | The task id. Must match the task that references this file. |
| `output` | string |  |  | The final response the agent should give. |
| `state` | object |  |  | The end state an outcome check reads, keyed the way expect paths address it, e.g. { refunds: { status: processed } }. |
| `tool_calls` | array of object |  |  |  |
| `transcript` | array of object |  |  | Ordered turns, the derived view a judge receives. |
| `note` | string |  | max length 2000 | Why this is the right answer. |
| `author` | string |  |  |  |
| `at` | [timestamp](#timestamp) |  |  |  |

#### `tool_calls` (each item)

| Field | Type | Required | Constraints | Description |
| --- | --- | --- | --- | --- |
| `name` | [name](#name) | yes |  |  |
| `args` | object |  |  |  |
| `result` | any |  |  |  |

#### `transcript` (each item)

| Field | Type | Required | Constraints | Description |
| --- | --- | --- | --- | --- |
| `role` | `user` · `agent` · `tool` · `system` | yes |  |  |
| `content` | string | yes |  |  |
| `tool` | [name](#name) |  |  |  |

## judge

evals/graders/judges/<name>/judge.yaml. A model-based grader for exactly one failure mode. Critique before verdict; Pass, Fail or Unknown; few-shot examples from the train split only.

| Field | Type | Required | Constraints | Description |
| --- | --- | --- | --- | --- |
| `id` | [name](#name) | yes |  | Must equal the directory name. |
| `failure_mode` | [name](#name) | yes |  | The one failure mode this judge detects. |
| `model` | [model_id](#model_id) | yes |  | Pinned to a dated snapshot. Changing it marks the judge stale. |
| `inputs` | array of `transcript` · `output` · `input` · `state` · `tool_calls` · `reference` | yes | min 1 items, unique | What the judge is shown. |
| `output` | object | yes |  | The structured output the judge must produce. Critique comes first so the verdict is reasoned. |
| `few_shot` | array of object |  | max 10 items, unique |  |
| `prompt` | [relative_path](#relative_path) | yes | pattern `\.md$` | Path to prompt.md, relative to evals/. |
| `prompt_hash` | [common.json#/$defs/sha256](#commonjson#/$defs/sha256) | yes |  | SHA-256 of prompt.md. The validator recomputes it; a mismatch means the judge is stale. |
| `temperature` | number |  | ≥ 0, ≤ 1, default `0` |  |
| `version` | integer |  | ≥ 1, default `1` | Bumped by hand on every prompt or model change; TPR/TNR are tracked by version. |

#### `output`

| Field | Type | Required | Constraints | Description |
| --- | --- | --- | --- | --- |
| `critique` | object | yes |  |  |
| `result` | object | yes |  |  |

##### `critique`

| Field | Type | Required | Constraints | Description |
| --- | --- | --- | --- | --- |
| `type` | `"string"` | yes |  |  |
| `max_chars` | integer |  | ≥ 50 |  |

##### `result`

| Field | Type | Required | Constraints | Description |
| --- | --- | --- | --- | --- |
| `enum` | `["Pass","Fail","Unknown"]` | yes |  |  |

#### `few_shot` (each item)

| Field | Type | Required | Constraints | Description |
| --- | --- | --- | --- | --- |
| `trace_id` | [trace_id](#trace_id) | yes |  | Must come from calibration.splits.train. Never dev or test. |
| `label` | [label_value](#label_value) | yes |  |  |
| `note` | string |  | max length 1000 | Why it is a Pass or a Fail; shown to the model. |

## calibration

evals/graders/judges/<name>/calibration.json. Written only by `litmustest calibrate`; never hand-edited. Tracks the judge's measured agreement with human labels and whether it can be trusted.

| Field | Type | Required | Constraints | Description |
| --- | --- | --- | --- | --- |
| `judge` | [name](#name) | yes |  |  |
| `prompt_hash` | [common.json#/$defs/sha256](#commonjson#/$defs/sha256) | yes |  | The prompt this calibration measured. Differs from judge.yaml when stale. |
| `model` | [model_id](#model_id) | yes |  |  |
| `splits` | object | yes |  | Labelled trace ids split 15/45/40 into train, dev and test. Hashes lock the test set. |
| `dev` | object | yes |  | Results on the dev split, re-run freely while editing the prompt. |
| `test` | null or object | yes |  | Results on the held-out test split. Run once per prompt version; null until then. |
| `status` | `untested` · `dev` · `trusted` · `stale` | yes |  | untested: no runs yet. dev: dev runs exist, test not run. trusted: test passed the threshold. stale: prompt or model changed since the test run. |
| `stale_reason` | `prompt_changed` · `model_changed` · `labels_changed` |  |  | Required when status is stale. |
| `disagreements` | array of object |  |  | Dev-split traces where judge and human disagree, for the editor. |

#### `splits`

| Field | Type | Required | Constraints | Description |
| --- | --- | --- | --- | --- |
| `train` | [split](#split) | yes |  |  |
| `dev` | [split](#split) | yes |  |  |
| `test` | [split](#split) | yes |  |  |

#### `dev`

| Field | Type | Required | Constraints | Description |
| --- | --- | --- | --- | --- |
| `tpr` | number |  | ≥ 0, ≤ 100 |  |
| `tnr` | number |  | ≥ 0, ≤ 100 |  |
| `matrix` | [confusion_matrix](#confusion_matrix) |  |  |  |
| `runs` | array of object | yes |  |  |

##### `runs` (each item)

| Field | Type | Required | Constraints | Description |
| --- | --- | --- | --- | --- |
| `ran_at` | [timestamp](#timestamp) | yes |  |  |
| `prompt_hash` | [common.json#/$defs/sha256](#commonjson#/$defs/sha256) | yes |  |  |
| `version` | integer |  | ≥ 1 |  |
| `tpr` | number | yes | ≥ 0, ≤ 100 |  |
| `tnr` | number | yes | ≥ 0, ≤ 100 |  |
| `matrix` | [confusion_matrix](#confusion_matrix) | yes |  |  |

#### `disagreements` (each item)

| Field | Type | Required | Constraints | Description |
| --- | --- | --- | --- | --- |
| `trace_id` | [trace_id](#trace_id) | yes |  |  |
| `human` | [label_value](#label_value) | yes |  |  |
| `judge` | [verdict](#verdict) | yes |  |  |
| `critique` | string |  |  |  |

### Definitions in calibration

#### split



| Field | Type | Required | Constraints | Description |
| --- | --- | --- | --- | --- |
| `trace_ids` | array of [trace_id](#trace_id) | yes | unique |  |
| `hash` | [common.json#/$defs/sha256](#commonjson#/$defs/sha256) | yes |  | SHA-256 of the sorted, newline-joined trace ids. Locks the split. |


## label

One line of evals/labels/<batch>.jsonl. A human judgement on one trace for one failure mode (or overall). Files are append-only; a correction is a new line.

| Field | Type | Required | Constraints | Description |
| --- | --- | --- | --- | --- |
| `trace_id` | [trace_id](#trace_id) | yes |  |  |
| `failure_mode` | [name](#name) or `"overall"` | yes |  | The failure mode labelled, or 'overall' for a whole-trace Pass/Fail from the review queue. |
| `label` | [label_value](#label_value) | yes |  |  |
| `note` | string |  | max length 4000 | Free text from the annotator. Error discovery groups these into failure modes. |
| `annotator` | string | yes | min length 1 |  |
| `at` | [timestamp](#timestamp) | yes |  |  |
| `rubric_version` | integer |  | ≥ 1 | The failure-mode definition version the annotator was reading. |
| `batch` | string |  |  | The review batch this came from. |

## suite

evals/suites/<name>.yaml. A named set of tasks with one job: regression stays near 100%, capability is the hill to climb, quality uses trusted judges only.

| Field | Type | Required | Constraints | Description |
| --- | --- | --- | --- | --- |
| `name` | [name](#name) | yes |  | Must equal the file name without extension. |
| `kind` | [suite_kind](#suite_kind) | yes |  |  |
| `description` | string |  | max length 1000 |  |
| `tasks` | array of [name](#name) |  | unique | Explicit task ids. |
| `include` | array of string |  |  | Globs under evals/tasks/, e.g. refunds/**. |
| `gate` | [gate](#gate) |  |  | Overrides the gate in litmustest.yaml for this suite. |
| `path_checks` | boolean |  |  | Whether transcript checks count. Defaults to true for regression and quality, false for capability. |
| `graduated_from` | [name](#name) |  |  | For a regression suite seeded from a saturated capability suite. |

At least one of: `tasks`; `include`.

## run_summary

evals/runs/<run id>.json. What one run of one or more suites produced, small enough to commit. Raw transcripts live in the configured store and are referenced by id.

| Field | Type | Required | Constraints | Description |
| --- | --- | --- | --- | --- |
| `run_id` | string | yes | pattern `^[a-z0-9][a-z0-9_-]*$` | Must equal the file name without extension. |
| `commit` | string | yes | pattern `^[a-f0-9]{7,40}$` | The product commit that was evaluated. |
| `branch` | string |  |  |  |
| `started_at` | [timestamp](#timestamp) | yes |  |  |
| `finished_at` | [timestamp](#timestamp) |  |  |  |
| `config_hash` | [common.json#/$defs/sha256](#commonjson#/$defs/sha256) | yes |  | SHA-256 of litmustest.yaml at run time. |
| `trials` | integer |  | ≥ 1 |  |
| `suites` | map of object | yes |  |  |
| `tasks` | map of object | yes |  |  |
| `infra_error_rate` | number | yes | ≥ 0, ≤ 100 | Percent of trials with an infra error. |
| `cost_usd` | number | yes | ≥ 0 |  |
| `judge_corrections` | array of object |  |  | Per judge, the TPR/TNR used to correct its checks' pass rates. |

#### `suites` (each value)

| Field | Type | Required | Constraints | Description |
| --- | --- | --- | --- | --- |
| `pass_rate` | number | yes | ≥ 0, ≤ 100 | Percent of trials with strict pass, corrected for judge error when enabled. |
| `ci` | [ci_bounds](#ci_bounds) | yes |  |  |
| `pass_at_1` | number | yes | ≥ 0, ≤ 100 |  |
| `pass_hat_k` | number | yes | ≥ 0, ≤ 100 | Percent of tasks that passed every trial. |
| `k` | integer |  | ≥ 1 |  |
| `n_tasks` | integer | yes | ≥ 0 |  |
| `excluded_judges` | array of [name](#name) |  |  | Judges left out because they were not trusted. |

#### `tasks` (each value)

| Field | Type | Required | Constraints | Description |
| --- | --- | --- | --- | --- |
| `suite` | [name](#name) | yes |  |  |
| `strict_pass` | number | yes | ≥ 0, ≤ 100 | Percent of trials where every check passed. |
| `weighted` | number | yes | ≥ 0, ≤ 100 | Mean weighted score across trials. |
| `flaky` | boolean |  |  | Set by the flaky-task detector. |
| `likely_broken` | boolean |  |  | Set when the task fails every trial across several runs. |
| `trials` | array of object | yes | min 1 items |  |

##### `trials` (each item)

| Field | Type | Required | Constraints | Description |
| --- | --- | --- | --- | --- |
| `pass` | boolean | yes |  |  |
| `failed_checks` | array of [name](#name) | yes | unique |  |
| `unknown_checks` | array of [name](#name) |  | unique | Judge checks that answered Unknown. |
| `infra_error` | boolean | yes |  | Timeout, OOM or harness error. Excluded from the agent's score. |
| `infra_error_kind` | `timeout` · `oom` · `harness` · `network` · `other` |  |  |  |
| `tokens` | integer |  | ≥ 0 |  |
| `latency_ms` | integer |  | ≥ 0 |  |
| `cost_usd` | number |  | ≥ 0 |  |
| `transcript_ref` | string |  |  | Address of the raw transcript in the configured store. |

#### `judge_corrections` (each item)

| Field | Type | Required | Constraints | Description |
| --- | --- | --- | --- | --- |
| `judge` | [name](#name) | yes |  |  |
| `tpr` | number | yes | ≥ 0, ≤ 100 |  |
| `tnr` | number | yes | ≥ 0, ≤ 100 |  |
| `prompt_hash` | [common.json#/$defs/sha256](#commonjson#/$defs/sha256) |  |  |  |

## trace

evals/datasets/traces/<id>.json. The internal trace shape: one trace as a list of spans following the OpenTelemetry GenAI semantic conventions. The ordered turns view that the review queue, the transcript page and judges use is derived from the spans at read time and never stored.

| Field | Type | Required | Constraints | Description |
| --- | --- | --- | --- | --- |
| `id` | [trace_id](#trace_id) | yes |  |  |
| `source` | string |  |  | Which adapter produced it (otel, jsonl, langfuse, ...). |
| `ingested_at` | [timestamp](#timestamp) |  |  |  |
| `metadata` | object |  |  | Anything the source attached that is not a span attribute (persona, environment, customer tier). |
| `spans` | array of object | yes | min 1 items |  |

#### `spans` (each item)

| Field | Type | Required | Constraints | Description |
| --- | --- | --- | --- | --- |
| `span_id` | string | yes | min length 1 |  |
| `parent_span_id` | string |  |  |  |
| `name` | string | yes | min length 1 |  |
| `kind` | `internal` · `client` · `server` · `producer` · `consumer` |  | default `"internal"` |  |
| `start_time` | [timestamp](#timestamp) | yes |  |  |
| `end_time` | [timestamp](#timestamp) | yes |  |  |
| `status` | object |  |  |  |
| `attributes` | object |  |  | OTel GenAI attributes. Known keys are typed; other keys are allowed. |
| `events` | array of object |  |  |  |

##### `status`

| Field | Type | Required | Constraints | Description |
| --- | --- | --- | --- | --- |
| `code` | `unset` · `ok` · `error` |  |  |  |
| `message` | string |  |  |  |

##### `attributes`

| Field | Type | Required | Constraints | Description |
| --- | --- | --- | --- | --- |
| `gen_ai.operation.name` | `chat` · `text_completion` · `embeddings` · `execute_tool` · `create_agent` · `invoke_agent` · `generate_content` |  |  |  |
| `gen_ai.provider.name` | string |  |  |  |
| `gen_ai.request.model` | string |  |  |  |
| `gen_ai.response.model` | string |  |  |  |
| `gen_ai.usage.input_tokens` | integer |  | ≥ 0 |  |
| `gen_ai.usage.output_tokens` | integer |  | ≥ 0 |  |
| `gen_ai.tool.name` | string |  |  |  |
| `gen_ai.tool.call.id` | string |  |  |  |
| `gen_ai.conversation.id` | string |  |  |  |
| `gen_ai.agent.name` | string |  |  |  |
| `gen_ai.input.messages` | array of [message](#message) |  |  |  |
| `gen_ai.output.messages` | array of [message](#message) |  |  |  |
| `gen_ai.tool.call.arguments` | any |  |  |  |
| `gen_ai.tool.call.result` | any |  |  |  |

##### `events` (each item)

| Field | Type | Required | Constraints | Description |
| --- | --- | --- | --- | --- |
| `name` | string | yes |  |  |
| `time` | [timestamp](#timestamp) | yes |  |  |
| `attributes` | object |  |  |  |

### Definitions in trace

#### message



| Field | Type | Required | Constraints | Description |
| --- | --- | --- | --- | --- |
| `role` | `system` · `user` · `assistant` · `tool` | yes |  |  |
| `parts` | array of object | yes | min 1 items |  |
| `finish_reason` | string |  |  |  |

##### `parts` (each item)

| Field | Type | Required | Constraints | Description |
| --- | --- | --- | --- | --- |
| `type` | `text` · `tool_call` · `tool_call_response` | yes |  |  |
| `content` | any |  |  |  |
| `id` | string |  |  |  |
| `name` | string |  |  |  |
| `arguments` | any |  |  |  |
| `response` | any |  |  |  |


## trace.jsonl_adapter

One line of a plain JSONL log that `litmustest ingest` converts to the internal trace shape. Input only; never stored under evals/. The adapter warns about every field it could not fill.

| Field | Type | Required | Constraints | Description |
| --- | --- | --- | --- | --- |
| `id` | [trace_id](#trace_id) | yes |  |  |
| `input` | any | yes |  | The user's first message or the task input. A string or an object. |
| `output` | any | yes |  | The agent's final response. A string or an object. |
| `messages` | array of object |  |  | Optional full conversation. Without it the trace has one user turn and one agent turn. |
| `tool_calls` | array of object |  |  | Optional tool calls in order. Placed after the assistant turn that made them when messages carry no ids. |
| `timestamp` | [timestamp](#timestamp) |  |  |  |
| `model` | string |  |  |  |
| `metadata` | object |  |  |  |

#### `messages` (each item)

| Field | Type | Required | Constraints | Description |
| --- | --- | --- | --- | --- |
| `role` | `system` · `user` · `assistant` · `tool` | yes |  |  |
| `content` | any | yes |  |  |
| `name` | string |  |  |  |
| `tool_call_id` | string |  |  |  |

#### `tool_calls` (each item)

| Field | Type | Required | Constraints | Description |
| --- | --- | --- | --- | --- |
| `id` | string |  |  |  |
| `name` | string | yes | min length 1 |  |
| `arguments` | any |  |  |  |
| `result` | any |  |  |  |
| `turn` | integer |  | ≥ 0 |  |

## common

Shared definitions used by every litmustest schema. Not a file type of its own.


### Definitions in common

#### name

A snake_case identifier: lowercase letters, digits and underscores, starting with a letter. These are what the dashboard shows in mono.

Type: string. pattern `^[a-z][a-z0-9_]*$`, max length 64.

#### trace_id

The id of a trace under datasets/traces/. Labels and few-shot examples reference traces by id, never by position.

Type: string. min length 1, max length 128.

#### timestamp

RFC 3339 timestamp with offset, e.g. 2026-10-27T09:12:00Z.

Type: string. date-time.

#### date

Calendar date, YYYY-MM-DD.

Type: string. date.

#### relative_path

A path relative to the evals/ directory. Never absolute, never climbing out with ../.

Type: string. pattern `^(?!/)(?!.*\.\./).*$`, min length 1.

#### model_id

A model id pinned to a dated snapshot: it must end in a date, YYYYMMDD or YYYY-MM-DD (e.g. claude-sonnet-4-5-20250929). Floating aliases like claude-sonnet-4-5 or 'latest' are rejected.

Type: string. pattern `^[a-z0-9][a-z0-9._/:@-]*(\d{8}|\d{4}-\d{2}-\d{2})$`.

#### sha256

Lowercase hex SHA-256.

Type: string. pattern `^[a-f0-9]{64}$`.

#### severity

How much a failure mode matters when it happens.

Type: `high` · `med` · `low`.

#### verdict

A judge's binary verdict, with Unknown for cases the judge cannot decide. Unknown is counted separately and routed to a person.

Type: `Pass` · `Fail` · `Unknown`.

#### label_value

A human label. Skip means the annotator could not judge this trace for this failure mode.

Type: `Pass` · `Fail` · `Skip`.

#### suite_kind

regression: must stay near 100%. capability: the hill to climb. quality: trusted judges only.

Type: `regression` · `capability` · `quality`.

#### gate

What CI enforces for a suite.

| Field | Type | Required | Constraints | Description |
| --- | --- | --- | --- | --- |
| `min_pass_rate` | number |  | ≥ 0, ≤ 100 | Fail the gate when the suite pass rate (percent) is below this. |
| `max_drop_pts` | number |  | ≥ 0, ≤ 100 | Fail the gate when the paired delta against the base run drops more than this many points and the drop is significant. |
| `report_only` | boolean |  | default `false` | Post the comparison but never fail the build. Default for capability suites. |
| `trusted_judges_only` | boolean |  | default `true` | Exclude any judge check whose calibration status is not trusted. |

#### ci_bounds

A 95% confidence interval on a percentage.

| Field | Type | Required | Constraints | Description |
| --- | --- | --- | --- | --- |
| `low` | number | yes | ≥ 0, ≤ 100 |  |
| `high` | number | yes | ≥ 0, ≤ 100 |  |
| `method` | `bootstrap` · `wilson` · `normal` |  | default `"bootstrap"` |  |

#### confusion_matrix

Judge verdicts against human labels on one split. Unknown verdicts are counted apart.

| Field | Type | Required | Constraints | Description |
| --- | --- | --- | --- | --- |
| `tp` | integer | yes | ≥ 0 | Judge Fail, human Fail (the failure mode was present and caught). |
| `tn` | integer | yes | ≥ 0 | Judge Pass, human Pass. |
| `fp` | integer | yes | ≥ 0 | Judge Fail, human Pass. |
| `fn` | integer | yes | ≥ 0 | Judge Pass, human Fail (a miss). |
| `unknown` | integer |  | ≥ 0, default `0` | Judge answered Unknown; excluded from TPR and TNR. |


## Cross-file rules

`litmustest validate` enforces these after the per-file schema checks. Errors fail the run; warnings do not.

| Rule | Level | What it checks |
| --- | --- | --- |
| `name_matches_file` | error | A failure mode, task, suite, judge, calibration, trace or run summary carries the id its file or directory name says. |
| `failure_mode_exists` | error | Every failure mode referenced by a check, a judge or a label exists under `failure_modes/`. |
| `failure_mode_not_retired` | error | No check references a retired failure mode. |
| `suite_exists` | error | A task's `suite` has a file under `suites/`. |
| `task_exists`, `task_suite_matches` | error | A suite's `tasks` list names real tasks that declare that suite. |
| `reference_exists`, `reference_task_matches` | error | A task's `reference_solution` exists and names the task. |
| `judge_exists`, `judge_failure_mode_matches` | error | A judge check's judge exists and detects the check's failure mode. |
| `judge_calibrated` | error | A judge used by a check has a `calibration.json`. |
| `judge_trusted` | warning | A judge whose status is not `trusted` will not count in gates. |
| `prompt_exists`, `prompt_hash` | error / warning | `prompt.md` exists; its SHA-256 matches `prompt_hash`, otherwise the judge is stale. |
| `stale_on_change` | error | A calibration marked `trusted` measured the prompt and model the judge uses now. |
| `trusted_requires_test`, `trust_threshold` | error | `trusted` needs a test run with TPR and TNR at or above `judges.trust_threshold`. |
| `splits_disjoint` | error | Train, dev and test share no trace ids. |
| `no_leakage`, `few_shot_from_train` | error / warning | No few-shot example comes from dev or test; each should come from train. |
| `code_fn_exists` | error | A code check's `fn` file exists. |
| `check_ids_unique` | error | Check ids are unique within a task. |
| `gate_suite_exists` | warning | Every gate in `litmustest.yaml` names a suite file. |
| `trace_exists` | warning | A label's trace is present under `datasets/traces/` (only checked when that directory has files). |
| `reference_passes` | error (`--deep`) | Each task's code, outcome and transcript checks pass against its reference solution. Judge checks are noted and skipped; they run under `litmustest run`. |

## Code check contract

A code check is a Python file under `graders/code/` exposing `check(trial: dict, args: dict) -> bool`. `trial` carries `input`, `output`, `state`, `tool_calls` and `transcript` in the shape of a reference solution; `args` is the check's `args` from the task. The validator runs it with `python3 -I` against the reference solution under `--deep`.
