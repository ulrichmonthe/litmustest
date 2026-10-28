// `litmustest explain`: plain-language explanations for the failed trials of a run. Claude writes
// trials[n].explanation into the run summary (an uncommitted change a person reviews); --no-model prints
// the template only and writes nothing.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SchemaSet } from "./schemas.ts";
import { loadFiles } from "./server/overview.ts";
import { loadTrial } from "./server/transcripts.ts";
import { explainTemplate, explainWithClaude, type TemplateExplanation } from "./explain.ts";
import type { Ask } from "./discover.ts";

type Obj = Record<string, unknown>;
export interface ExplainRunItem { task: string; n: number; template: TemplateExplanation; explanation?: Obj; error?: string; skipped?: string }
export interface ExplainRunResult { run_id: string; path: string; items: ExplainRunItem[]; written: number }

export async function explainRun(opts: { evalsDir: string; runId?: string; tasks?: string[]; all?: boolean; force?: boolean; model?: boolean; ask?: Ask; concurrency?: number; onItem?: (i: ExplainRunItem) => void }): Promise<ExplainRunResult> {
  const f = loadFiles(opts.evalsDir);
  const run = opts.runId ? f.runs.find((r) => r.run_id === opts.runId) : f.runs[f.runs.length - 1];
  if (!run) throw new Error(opts.runId ? `no run ${opts.runId} under runs/` : "no runs yet; run `litmustest run` first");
  const path = join(opts.evalsDir, "runs", `${String(run.run_id)}.json`);
  const summary = JSON.parse(readFileSync(path, "utf8")) as Obj;
  const targets: { task: string; n: number }[] = [];
  for (const [task, t] of Object.entries(summary.tasks as Record<string, Obj>)) {
    if (opts.tasks?.length && !opts.tasks.includes(task)) continue;
    const trials = (t.trials as Obj[]) ?? [];
    const failed = trials.map((x, i) => ({ x, n: i + 1 })).filter(({ x }) => !x.pass && !x.infra_error);
    for (const { n } of opts.all ? failed : failed.slice(0, 1)) targets.push({ task, n });
  }
  const items: ExplainRunItem[] = new Array(targets.length);
  let next = 0, written = 0;
  const worker = async () => {
    while (next < targets.length) {
      const ix = next++; const { task, n } = targets[ix]!;
      const { explainInput, t } = loadTrial(opts.evalsDir, String(run.run_id), task, n);
      const item: ExplainRunItem = { task, n, template: explainTemplate(explainInput) };
      if (opts.model !== false) {
        if (t.explanation && !opts.force) { item.skipped = "already explained"; item.explanation = t.explanation as Obj; }
        else try {
          const e = await explainWithClaude(explainInput, { ask: opts.ask });
          const clean = Object.fromEntries(Object.entries(e).filter(([, v]) => v !== ""));
          (((summary.tasks as Record<string, Obj>)[task]!.trials as Obj[])[n - 1]!).explanation = clean; item.explanation = clean; written++;
        } catch (err) { item.error = (err as Error).message; }
      }
      items[ix] = item; opts.onItem?.(item);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(opts.concurrency ?? 4, targets.length)) }, worker));
  if (written) {
    const errs = new SchemaSet().check("run_summary", summary);
    if (errs.length) throw new Error(`run summary would not validate: ${errs.join("; ")}`);
    writeFileSync(path, JSON.stringify(summary, null, 2) + "\n");
  }
  return { run_id: String(run.run_id), path, items, written };
}

export function explainText(i: ExplainRunItem): string {
  const t = i.template; const e = i.explanation as { summary?: string; cause?: string; fix?: string; confidence?: string } | undefined;
  const lines = [`${i.task} #${i.n} · ${t.title}`, `  ${t.headline}`, `  Tested: ${t.tested}`, `  Happened: ${t.happened}`, `  Means: ${t.meaning}`];
  if (t.to_pass.length) lines.push(`  To pass: ${t.to_pass.join(" ")}`);
  if (e?.summary) lines.push(`  Claude: ${e.summary}`, ...(e.cause ? [`    Cause: ${e.cause}`] : []), ...(e.fix ? [`    Fix: ${e.fix}`] : []), `    (${e.confidence ?? "low"} confidence${i.skipped ? ", saved earlier" : ""})`);
  if (i.error) lines.push(`  Claude could not explain this: ${i.error}`);
  return lines.join("\n");
}
