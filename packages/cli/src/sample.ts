// litmustest sample: the production sampler. Pulls traces that arrived since the last batch (new lines in the JSONL
// source, or new traces from a platform) and ingests them as a dated review batch. --if-due honours sources.sampler.every.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { ingest, type IngestResult } from "./ingest.ts";
import { pullSource, type Fetch } from "./adapters/platforms.ts";

type Obj = Record<string, unknown>;
export interface SampleOptions { evalsDir: string; cwd?: string; size?: number; clusters?: number; ifDue?: boolean; since?: string; now?: Date; fetch?: Fetch; env?: Record<string, string | undefined>; batch?: string; limit?: number }
export interface SampleResult { skipped?: string; batch?: string; pulled: number; fresh: number; ingest?: IngestResult; source: string; warnings: string[] }

export function lastBatch(evalsDir: string): { name: string; created: string } | undefined {
  const dir = join(evalsDir, "batches"); if (!existsSync(dir)) return undefined;
  const batches = readdirSync(dir).filter((f) => f.endsWith(".yaml")).map((f) => parseYaml(readFileSync(join(dir, f), "utf8")) as Obj).filter((b) => b.created).sort((a, b) => String(a.created).localeCompare(String(b.created)));
  const b = batches[batches.length - 1]; return b ? { name: String(b.name), created: String(b.created) } : undefined;
}
export function isDue(every: string, last: string | undefined, now: Date): boolean {
  if (every === "manual") return false;
  if (!last) return true;
  const days = every === "daily" ? 1 : 7;
  return now.getTime() - Date.parse(last) >= days * 86_400_000 - 60_000;
}

export async function sample(o: SampleOptions): Promise<SampleResult> {
  const cwd = resolve(o.cwd ?? dirname(resolve(o.evalsDir))); const evalsDir = resolve(o.evalsDir);
  const config = parseYaml(readFileSync(join(evalsDir, "litmustest.yaml"), "utf8")) as Obj;
  const src = ((config.sources as Obj).traces as Obj); const sampler = ((config.sources as Obj).sampler as Obj) ?? {};
  const every = String(sampler.every ?? "manual"); const now = o.now ?? new Date();
  const last = lastBatch(evalsDir);
  if (o.ifDue && !isDue(every, last?.created, now)) return { skipped: every === "manual" ? "sampler is manual; pass --size without --if-due to sample now" : `not due: last batch ${last?.name} at ${last?.created}, sampler runs ${every}`, pulled: 0, fresh: 0, source: String(src.format), warnings: [] };
  const known = new Set(existsSync(join(evalsDir, "datasets", "traces")) ? readdirSync(join(evalsDir, "datasets", "traces")).filter((f) => f.endsWith(".json")).map((f) => f.replace(/\.json$/, "")) : []);
  const since = o.since ?? last?.created;
  let lines: Obj[] = []; let source = String(src.format); const warnings: string[] = [];
  const format = String(src.format);
  if (format === "jsonl" || format === "otel") {
    const files = globFiles(cwd, String(src.path)); if (!files.length) throw new Error(`no files match sources.traces.path ${src.path}`);
    for (const f of files) for (const line of readFileSync(f, "utf8").split("\n")) { if (!line.trim()) continue; try { lines.push(JSON.parse(line)); } catch { warnings.push(`${f}: unparseable line skipped`); } }
    source = files.length === 1 ? files[0]! : `${files.length} files`;
  } else { const r = await pullSource(format, { since, limit: o.limit ?? 2000, fetch: o.fetch, env: o.env, project: src.project as string | undefined }); lines = r.lines; source = r.source; warnings.push(...r.warnings); }
  const fresh = lines.filter((l) => l.id !== undefined && !known.has(String(l.id)));
  if (!fresh.length) return { skipped: "no new traces since the last batch", pulled: lines.length, fresh: 0, source, warnings };
  const tmp = mkdtempSync(join(tmpdir(), "litmustest-sample-")); const file = join(tmp, "fresh.jsonl");
  writeFileSync(file, fresh.map((l) => JSON.stringify(l)).join("\n") + "\n");
  const name = o.batch ?? now.toISOString().slice(0, 10) + (last?.name === now.toISOString().slice(0, 10) ? "-b" : "");
  const r = ingest({ cwd, evalsDir, source: file, size: o.size ?? Number(sampler.size ?? 60), clusters: o.clusters ?? Number(sampler.clusters ?? 8), batch: name, now });
  // the batch records the real source, not the temp file
  const bp = join(evalsDir, "batches", `${name}.yaml`); writeFileSync(bp, readFileSync(bp, "utf8").replace(/^source: .*$/m, `source: ${JSON.stringify(source)}`));
  mkdirSync(join(evalsDir, "batches"), { recursive: true });
  return { batch: name, pulled: lines.length, fresh: fresh.length, ingest: r, source, warnings: [...warnings, ...[...r.warnings.entries()].map(([w, n]) => `${w} (${n})`)] };
}
function globFiles(cwd: string, pattern: string): string[] {
  const abs = resolve(cwd, pattern);
  if (!pattern.includes("*")) return existsSync(abs) ? [abs] : [];
  const dir = dirname(abs); if (!existsSync(dir)) return [];
  const re = new RegExp("^" + pattern.split("/").pop()!.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$");
  return readdirSync(dir).filter((f) => re.test(f)).map((f) => join(dir, f)).sort();
}

export const SAMPLER_WORKFLOW = `name: litmustest sampler
on:
  schedule:
    - cron: "0 6 * * 1"   # Mondays 06:00 UTC
  workflow_dispatch:
jobs:
  sample:
    runs-on: ubuntu-latest
    permissions:
      contents: write
      pull-requests: write
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npm ci
      - name: Pull new production traces into a review batch
        env:
          LANGFUSE_PUBLIC_KEY: \${{ secrets.LANGFUSE_PUBLIC_KEY }}
          LANGFUSE_SECRET_KEY: \${{ secrets.LANGFUSE_SECRET_KEY }}
          BRAINTRUST_API_KEY: \${{ secrets.BRAINTRUST_API_KEY }}
        run: npx litmustest sample --if-due
      - name: Open a pull request with the batch
        env:
          GH_TOKEN: \${{ github.token }}
        run: |
          if [ -z "$(git status --porcelain evals)" ]; then echo "nothing new"; exit 0; fi
          branch="evals/batch-$(date -u +%F)"
          git switch -c "$branch"
          git -c user.name=litmustest -c user.email=litmustest@users.noreply.github.com add evals
          git -c user.name=litmustest -c user.email=litmustest@users.noreply.github.com commit -m "evals: review batch $(date -u +%F)"
          git push -u origin "$branch"
          gh pr create --title "Review batch $(date -u +%F)" --body "New production traces sampled into the review queue by the litmustest sampler. Label them with litmustest serve."
`;
