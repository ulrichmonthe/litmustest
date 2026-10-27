// A fake agent for runner tests. Copies the task's reference solution into trial.json, with planted behaviour:
//   task id contains "ghost"      -> writes a state that never matches (always fails the outcome check)
//   task id ends with "_first_time" and odd trial -> drops send_confirmation (flaky)
//   FAKE_CRASH=<task id>          -> exit 1 with a stack trace
//   FAKE_HANG=<task id>           -> never exits (timeout)
//   FAKE_SILENT=<task id>         -> exit 0 without writing trial.json
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
const task = process.env.LITMUSTEST_TASK, dir = process.env.LITMUSTEST_TRIAL_DIR, evals = process.env.LITMUSTEST_EVALS, n = Number(process.env.LITMUSTEST_TRIAL);
if (process.env.FAKE_HANG === task) { setInterval(() => {}, 1000); } else {
  if (process.env.FAKE_CRASH === task) { console.error("TypeError: boom\n    at agent.mjs:1"); process.exit(1); }
  if (process.env.FAKE_SILENT === task) process.exit(0);
  const taskFile = process.env.LITMUSTEST_TASK_FILE;
  const refRel = /reference_solution:\s*(\S+)/.exec(readFileSync(taskFile, "utf8"))[1];
  const ref = JSON.parse(readFileSync(resolve(evals, refRel), "utf8"));
  const trial = { ...ref, usage: { input_tokens: 1000 + n, output_tokens: 100, cost_usd: 0.006 }, latency_ms: 1200 + n };
  delete trial.task; delete trial.note; delete trial.author;
  if (task.includes("ghost")) trial.state = { refunds: { count: 0, status: "none", amount_cents: 0 }, tickets: { status: "none" }, confirmations: { sent: 0 } };
  if (task.endsWith("_first_time") && n % 2 === 1) { trial.tool_calls = trial.tool_calls.filter((c) => c.name !== "send_confirmation"); trial.state = { ...trial.state, confirmations: { sent: 0 } }; }
  writeFileSync(join(dir, "trial.json"), JSON.stringify(trial, null, 2));
  void dirname;
}
