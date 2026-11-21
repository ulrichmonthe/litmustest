// A fake agent for runner tests. Copies the task's reference solution into trial.json, with planted behaviour:
//   task id contains "ghost"      -> writes a state that never matches (always fails the outcome check)
//   task id ends with "_first_time" and odd trial -> drops send_confirmation (flaky)
//   FAKE_CRASH=<task id>          -> exit 1 with a stack trace
//   FAKE_HANG=<task id>           -> never exits (timeout)
//   FAKE_SILENT=<task id>         -> exit 0 without writing trial.json
//   FAKE_LIE=<task id>            -> trial.json claims the reference state, the database it leaves says nothing happened
// It also leaves support.sqlite in the trial directory holding the same end state, the way the example's agent does,
// so outcome checks with a sql reader have a real database to query.
import { readFileSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
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
  const real = process.env.FAKE_LIE === task ? {} : trial.state ?? {};
  const db = new DatabaseSync(join(dir, "support.sqlite"));
  db.exec("CREATE TABLE refunds (id INTEGER PRIMARY KEY AUTOINCREMENT, status TEXT, amount_cents INTEGER); CREATE TABLE confirmations (id INTEGER PRIMARY KEY AUTOINCREMENT); CREATE TABLE tickets (id INTEGER PRIMARY KEY AUTOINCREMENT, status TEXT);");
  for (let i = 0; i < (real.refunds?.count ?? (real.refunds?.status && real.refunds.status !== "none" ? 1 : 0)); i++) db.prepare("INSERT INTO refunds (status, amount_cents) VALUES (?, ?)").run(real.refunds.status, real.refunds.amount_cents);
  for (let i = 0; i < (real.confirmations?.sent ?? 0); i++) db.exec("INSERT INTO confirmations DEFAULT VALUES");
  if (real.tickets?.status && real.tickets.status !== "none") db.prepare("INSERT INTO tickets (status) VALUES (?)").run(real.tickets.status);
  db.close();
  void dirname;
}
