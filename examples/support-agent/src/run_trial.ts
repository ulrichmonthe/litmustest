// Run one task once in a fresh environment and write the trial in reference-solution shape, plus its trace.
//   node src/run_trial.ts --task duplicate_charge_frustrated [--multi] [--out .litmustest/trials]
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { freshDb, snapshot } from "./db.ts";
import { runAgent } from "./agent.ts";
import { toTrace } from "./otel.ts";
import type { Persona } from "./catalog.ts";

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (n: string) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const taskId = flag("--task");
if (!taskId) { console.error("usage: node src/run_trial.ts --task <task id> [--multi] [--out dir]"); process.exit(2); }

const taskFile = join(here, "..", "evals", "tasks", ...(await findTask(taskId)));
const task = parseYaml(readFileSync(taskFile, "utf8")) as { id: string; input: { persona: Persona; from: string; message: string; goal?: string } };
const opening = `From: ${task.input.from}\n\n${task.input.message}`;
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const outDir = resolve(flag("--out") ?? join(here, "..", ".litmustest", "trials"), `${task.id}_${stamp}`);
const { db, path } = freshDb(outDir);
console.log(`fresh database at ${path}`);

const rec = await runAgent({
  id: `trial_${task.id}_${stamp}`, db, message: opening, persona: task.input.persona,
  simulate: args.includes("--multi") ? { goal: task.input.goal ?? task.input.message, maxRounds: 4 } : undefined,
});
const trial = {
  task: task.id,
  output: [...rec.turns].reverse().find((t) => t.role === "agent")?.content ?? "",
  state: snapshot(db),
  tool_calls: rec.calls.map((c) => ({ name: c.name, args: c.args, result: c.result })),
  transcript: rec.turns.map((t) => (t.tool ? { role: "tool", content: t.content, tool: t.tool } : { role: t.role, content: t.content })),
  at: rec.started.toISOString(),
};
db.close();
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, "trial.json"), JSON.stringify(trial, null, 2));
writeFileSync(join(outDir, "trace.json"), JSON.stringify(toTrace(rec), null, 2));
console.log(`tokens in/out ${rec.input_tokens}/${rec.output_tokens}; ${rec.calls.length} tool calls`);
console.log(`wrote ${join(outDir, "trial.json")} and trace.json`);
console.log(`\n${trial.output}`);

async function findTask(id: string): Promise<string[]> {
  const { readdirSync } = await import("node:fs");
  const root = join(here, "..", "evals", "tasks");
  for (const dir of readdirSync(root)) for (const f of readdirSync(join(root, dir))) if (f === `${id}.yaml`) return [dir, f];
  console.error(`no task ${id} under evals/tasks/`); process.exit(2);
}
