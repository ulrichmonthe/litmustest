# litmustest

From raw AI-product traces to a trusted, CI-gated eval suite. This package is the `litmustest` CLI.

```bash
npx @concertedlabs/litmustest@0.2.0 validate evals/ --deep
```

`validate` checks every file under `evals/` against its JSON Schema and the cross-file rules (failure modes exist, judges are calibrated, no few-shot leakage, reference solutions pass their checks). Exit 1 on any error. `litmustest serve` opens the dashboard; `litmustest --help` lists every command (`init`, `ingest`, `run`, `compare`, `calibrate`, `ci`, `doctor` and the rest).

Install it once with `npm install -g @concertedlabs/litmustest`; the command it installs is `litmustest`.

Source, schemas and docs: https://github.com/ulrichmonthe/litmustest. Apache 2.0.
