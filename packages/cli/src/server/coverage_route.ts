// GET /api/coverage: the three maps, the gaps in order, and the coverage each run recorded, for trends.
import { computeCoverage } from "../coverage.ts";
import { gaps } from "../coverage_cli.ts";
import { loadFiles } from "./overview.ts";
import type { App, Reply } from "./app.ts";

type Obj = Record<string, unknown>;
export function coverageRoute(app: App): Reply {
  const f = loadFiles(app.evalsDir);
  const c = computeCoverage(app.evalsDir, { files: f });
  const history = f.runs.filter((r) => r.coverage).map((r) => ({ run_id: r.run_id, started_at: r.started_at, ...(r.coverage as Obj) }));
  return { status: 200, body: { ...c, gaps: gaps(c, 25), history } };
}
