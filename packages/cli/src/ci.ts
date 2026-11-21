// litmustest ci: run the gated suites, compare with the base run, post the comparison on the PR, fail on a crossed gate.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { localRoot, openStore, parseRef, storageConfig, type OpenStore } from "./storage/index.ts";
import { run, type RunOptions } from "./run.ts";
import { meaningBlock } from "./glossary_cli.ts";
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
  const meaning = meaningBlock(o.evalsDir, c);
  const links = transcriptLinks(o.evalsDir, c);
  const markdown = comparisonMarkdown(c, { title: "litmustest" }) + (links ? `\n${links}` : "") + (meaning ? `\n${meaning}` : "");
  let posted = false;
  if (o.comment) {
    const pr = o.prNumber ?? prFromEnv();
    if (pr) { const r = postPrComment(markdown, { pr, repo: o.repo }); if (!r.posted) return { run_id: runId, base, comparison: c, passed: g.passed, markdown, posted: false, reason: r.reason }; posted = true; }
  }
  return { run_id: runId, base, comparison: c, passed: g.passed, markdown, posted };
}
/** Post markdown as a comment on a pull request with the gh CLI. Never throws: a failure comes back as a reason. */
export function postPrComment(markdown: string, o: { pr: string; repo?: string; cwd?: string }): { posted: boolean; reason?: string } {
  try { execFileSync("gh", ["pr", "comment", o.pr, ...(o.repo ? ["--repo", o.repo] : []), "--body", markdown], { stdio: ["ignore", "pipe", "pipe"], ...(o.cwd ? { cwd: o.cwd } : {}) }); return { posted: true }; }
  catch (e) { return { posted: false, reason: `could not post: ${(e as Error).message.split("\n")[0]}` }; }
}
/** The number of the pull request open for the current branch, if gh knows one. */
export function currentPr(cwd: string): string | undefined {
  try { const n = execFileSync("gh", ["pr", "view", "--json", "number", "-q", ".number"], { cwd, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" }).trim(); return /^\d+$/.test(n) ? n : undefined; } catch { return undefined; }
}
function prFromEnv(): string | undefined {
  const ref = process.env.GITHUB_REF ?? ""; const m = /refs\/pull\/(\d+)\//.exec(ref); if (m) return m[1];
  return process.env.PR_NUMBER;
}

/** The name of the build artifact the scaffolded workflow uploads when transcripts are stored locally. */
export const TRANSCRIPTS_ARTIFACT = "litmustest-transcripts";

/**
 * Where a reader of the PR comment can open the transcripts of the tasks that broke or turned flaky.
 * A remote store: a link to the object or trace. The local store inside GitHub Actions: the build artifact the scaffolded
 * workflow uploads. The local store anywhere else: nothing, because the files are only on the machine that ran them.
 */
export function transcriptLinks(evalsDir: string, c: Comparison, env: Record<string, string | undefined> = process.env): string {
  const flips = c.flips.filter((f) => f.change !== "Fixed" && f.transcript_ref); if (!flips.length) return "";
  let store: OpenStore | undefined; try { store = openStore(evalsDir, { env }); } catch { /* an unreadable storage config: fall back to the refs */ }
  const artifacts = env.GITHUB_ACTIONS && env.GITHUB_RUN_ID && env.GITHUB_REPOSITORY ? `${env.GITHUB_SERVER_URL ?? "https://github.com"}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}#artifacts` : undefined;
  const lines: string[] = [];
  for (const f of flips) {
    const ref = String(f.transcript_ref); const p = parseRef(ref); if (!p) continue;
    if (p.scheme === "local") { if (artifacts) lines.push(`- \`${f.task}\` (${f.change.toLowerCase()}): \`${p.run}/${p.task}/${p.n}/\` in the [${TRANSCRIPTS_ARTIFACT} artifact](${artifacts})`); continue; }
    let url: string | undefined; try { url = store && store.backend !== "local" ? store.url(p.run, p.task, p.n) : undefined; } catch { /* no credentials here: the ref still says where it is */ }
    lines.push(`- \`${f.task}\` (${f.change.toLowerCase()}): ${url ? `[transcript](${url})` : `\`${ref}\``}`);
  }
  return lines.length ? `**Transcripts**\n\n${lines.join("\n")}\n` : "";
}

const SECRETS: Record<string, string[]> = { s3: ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"], gcs: ["GCS_ACCESS_KEY_ID", "GCS_SECRET_ACCESS_KEY"], langfuse: ["LANGFUSE_PUBLIC_KEY", "LANGFUSE_SECRET_KEY", "LANGFUSE_HOST"], braintrust: ["BRAINTRUST_API_KEY", "BRAINTRUST_PROJECT_ID"] };

/**
 * The GitHub Action for `litmustest ci`. Transcripts written on a CI runner vanish with it, so the workflow depends on
 * where they are stored: with the local backend it uploads the transcript directory as a build artifact (the PR comment
 * links broken tasks to it); with a remote backend it passes that backend's credentials and the comment links to the store.
 */
export function workflow(o: { backend?: string; transcriptsPath?: string } = {}): string {
  const backend = o.backend ?? "local"; const secrets = SECRETS[backend] ?? [];
  const head = `name: litmustest
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
${secrets.map((k) => `          ${k}: \${{ secrets.${k} }}\n`).join("")}        run: npx litmustest ci --comment
`;
  if (backend !== "local") return head;
  return `${head}      - name: Keep the transcripts (they are stored locally, and this runner is thrown away)
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: ${TRANSCRIPTS_ARTIFACT}
          path: ${o.transcriptsPath ?? ".litmustest/transcripts"}
          include-hidden-files: true
          if-no-files-found: ignore
          retention-days: 14
`;
}
/** The workflow for the default setup: local transcripts, uploaded as a build artifact. */
export const WORKFLOW = workflow();
export function writeWorkflow(repoRoot: string, path = ".github/workflows/litmustest.yml", evalsDir = join(repoRoot, "evals")): string {
  const abs = join(repoRoot, path); mkdirSync(join(repoRoot, ".github", "workflows"), { recursive: true });
  if (existsSync(abs)) throw new Error(`${path} already exists`);
  const backend = String(storageConfig(evalsDir).backend ?? "local");
  const rel = relative(resolve(repoRoot), localRoot(evalsDir)).split("\\").join("/");
  writeFileSync(abs, workflow({ backend, transcriptsPath: rel && !rel.startsWith("..") ? rel : ".litmustest/transcripts" })); return abs;
}
