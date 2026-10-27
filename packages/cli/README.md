# litmustest

From raw AI-product traces to a trusted, CI-gated eval suite. This package is the `litmustest` CLI.

```bash
npx litmustest@0.1.0 validate evals/ --deep
```

`validate` checks every file under `evals/` against its JSON Schema and the cross-file rules (failure modes exist, judges are calibrated, no few-shot leakage, reference solutions pass their checks). Exit 1 on any error. The other commands (`init`, `ingest`, `run`, `compare`, `calibrate`, `serve`, `ci`, `doctor`) arrive in later phases.

Source, schemas and docs: https://github.com/ulrichmonthe/litmustest. Apache 2.0.
