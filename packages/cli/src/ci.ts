// litmustest ci: run the gated suites, compare with the base run, post the comparison on the PR, fail on a crossed gate.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { run, type RunOptions } from "./run.ts";
import { compareRuns, comparisonMarkdown, evaluateGates, type Comparison } from "./compare.ts";
import { loadFiles } from "./server/overview.ts";

type Obj = Record<string, unknown>;
export interface CiOptions extends Omit<RunOptions, "suites"> { base?: string; baseBranch?: string; comment?: boolean; prNumber?: string; repo?: string; suites?: string[]; onlyCompare?: [string, string] }
export interface CiResult { run_id?: string; base?: string; comparison?: Comparison; passed: boolean; markdown: string; posted?: boolean; reason?: string }

/** The run to compare against: --base, else the latest run on the base branch, else the latest run at all. */
export function pickBase(evalsDir: string, opts: { base?: string; baseBranch?: string; exclude?: string }): string | undefined {
  if (opts.base) return opts.base;
  const runs = loadFiles(evalsDir).runs.filter((r) => r.run_id !== opts.exclude);
  const onBase = opts.baseBranch ? runs.filter((r) => r.branch === opts.baseBranch) : [];
  const pick = (onBase.length ? onBase : runs).slice(-1)[0];
  return pick ? String(pick.run_id) : undefined;
}

export async function ci(o: CiOptions): Promise<CiResult> {
  const f = loadFiles(o.evalsDir);
  const gated = o.suites?.length ? o.suites : Object.keys((f.config.gates as Obj) ?? {}).filter((s) => f.suites.some((x) => x.name === s));
  if (!gated.length) return { passed: true, markdown: "", reason: "no gated suites in litmustest.yaml" };
  let runId: string; let base: string | undefined;
  if (o.onlyCompare) { [base, runId] = o.onlyCompare; }
  else { const r = await run({ ...o, suites: gated }); runId = r.run_id; base = pickBase(o.evalsDir, { base: o.base, baseBranch: o.baseBranch ?? process.env.GITHUB_BASE_REF, exclude: runId }); }
  if (!base) return { run_id: runId, passed: true, markdown: `### litmustest: ${runId}\n\nFirst run; nothing to compare against yet.`, reason: "no base run" };
  const c = compareRuns(o.evalsDir, base, runId);
  const g = evaluateGates(c);
  const markdown = comparisonMarkdown(c, { title: "litmustest" });
  let posted = false;
  if (o.comment) {
    const pr = o.prNumber ?? prFromEnv();
    if (pr) { try { execFileSync("gh", ["pr", "comment", pr, ...(o.repo ? ["--repo", o.repo] : []), "--body", markdown], { stdio: ["ignore", "pipe", "pipe"] }); posted = true; } catch (e) { return { run_id: runId, base, comparison: c, passed: g.passed, markdown, posted: false, reason: `could not post: ${(e as Error).message.split("\n")[0]}` }; } }
  }
  return { run_id: runId, base, comparison: c, passed: g.passed, markdown, posted };
}
function prFromEnv(): string | undefined {
  const ref = process.env.GITHUB_REF ?? ""; const m = /refs\/pull\/(\d+)\//.exec(ref); if (m) return m[1];
  return process.env.PR_NUMBER;
}

export const WORKFLOW = `name: litmustest
on:
  pull_request:
jobs:
  evals:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - uses: actions/setup-python@v5
        with:
          python-version: "3.12"
      - run: npm ci
      - name: Run the gated suites and post the comparison
        env:
          ANTHROPIC_API_KEY: \${{ secrets.ANTHROPIC_API_KEY }}
          GH_TOKEN: \${{ github.token }}
        run: npx litmustest ci --comment
`;
export function writeWorkflow(repoRoot: string, path = ".github/workflows/litmustest.yml"): string {
  const abs = join(repoRoot, path); mkdirSync(join(repoRoot, ".github", "workflows"), { recursive: true });
  if (existsSync(abs)) throw new Error(`${path} already exists`);
  writeFileSync(abs, WORKFLOW); return abs;
}
