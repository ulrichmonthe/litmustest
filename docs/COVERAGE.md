# Coverage

Coverage answers one question: which parts of the application would an eval catch if they broke?

## What it measures

Six maps of the application. Each item on a map gets a depth. A map that is not set up says how to set it up and is left out of every number.

| Map | Items | Covered when | Config |
| --- | --- | --- | --- |
| Spec | Every match of `id_pattern` in your spec or QA docs | A task's `source: spec:<id>` or `covers:` names it | `coverage.spec` |
| Surface | Every API route (OpenAPI file, a scan of route decorators, or a list), or tool names for an agent | A trial in the latest run called it, or a task's `covers:` names it | `coverage.surface` |
| Risk | Every failure mode that is not retired | A task has a check tagged with it that counts: code, outcome, transcript, or a trusted judge | always on |
| Traffic | Every surface item an ingested production trace used, weighted by how many traces used it | The surface item is covered | on when `coverage.surface` is set and traces are under `datasets/traces/` |
| Code | Every file in an lcov or Istanbul report, weighted by its lines | Lines ran while the suites ran | `coverage.code` |
| Frontend | Every page route (a list, or a scan of Next.js `app/` and `pages/` folders and React Router or Vue Router files) | A trial in the latest run opened its URL, or a task's `covers:` names it | `coverage.frontend` |

| Depth | Meaning |
| --- | --- |
| Guarded | A regression task covers it and passed in the latest run: the merge gate protects it. |
| Checked | A task outside regression covers it and passed. |
| Planned | Only capability tasks cover it, or none of its tasks has passed. A goal, not protection. |
| None | No task covers it. |

The headline number for each map is the share of items checked or guarded. Two maps weigh their items instead, because the items differ in size:

- **Traffic** reports the share of production use that lands on a checked or guarded item. A tool every conversation calls counts for more than one that a single trace touched. Tool calls in traces that match no surface item are reported as a warning.
- **Code** reports the share of lines that ran. litmustest instruments nothing: your agent's own process has to write the report while `litmustest run` runs it, for example with `c8`, `nyc` or coverage.py's lcov output. A file counts as checked when any of its lines ran.

## What it does not measure

- Whether a check is a good check. Covered means a check would run, not that it would catch every bug.
- Drafting tasks for gaps. The gap list says what is missing; writing the task is still yours.

## Configure

```yaml
coverage:
  spec:
    files: [docs/05-qa-test-cases.md]      # paths or globs from the repository root
    id_pattern: "SYS-[A-Z]+-\\d+"           # one spec id
    # area_pattern: "^(SYS-[A-Z]+)"        # optional; default is the id without its trailing number
  surface:
    scan: ["backend/**/*.py"]              # or openapi: openapi.json, or items: [tool_a, tool_b]
    ignore: ["GET /api/health", "GET /{path:path}"]
    group_depth: 2                         # /api/play is an area
  code:
    report: coverage/lcov.info             # or an Istanbul coverage-final.json or coverage-summary.json
    ignore: ["tests/*"]
  frontend:
    scan: ["web/app/**/page.tsx"]          # or routes: ["/settings", "/orders/{id}"]
```

A spec id's title and priority (P0 to P4) come from the line that starts with the id, such as a table row. A task can claim more than one item:

```yaml
covers: [SYS-LOOP-03, "POST /api/play/join"]
```

Surface coverage from calls needs the latest run's transcripts on the machine (the local store). Without them it counts `covers:` only, and says so.

## Where it shows

- `litmustest coverage` prints the maps, the weakest areas and the gaps by priority. `--fail-under spec=20` exits 1 below a threshold; `traffic=80` and `code=40` use the weighted share. `--json` for tools.
- The dashboard's Coverage page: a radar chart per map (one spoke per area, rings for guarded, checked and planned), a table view, the items with their tasks, and the biggest gaps.
- The Overview's Coverage card, with the change since the previous run.
- `litmustest run` stores a snapshot in the run summary; `compare` and the CI comment show the change and list items with no eval since the base run. Coverage is report only: it never fails a gate.
