// Dashboard actions that start from something a person just looked at:
// promote a reviewed trace to a task, mark a flip between two runs as expected, post a comparison to the PR.
// Each writes through the validated save path, so the change lands in the Pending changes tray for a person to commit.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { traceView } from "../trace_view.ts";
import { validateEvals } from "../validate.ts";
import { compareRuns } from "../compare.ts";
import { currentPr, postPrComment } from "../ci.ts";
import { loadFiles } from "./overview.ts";
import { HttpError, type App, type Reply } from "./app.ts";

type Obj = Record<string, unknown>;
const safe = (s: string) => s.replace(/[^A-Za-z0-9_.-]/g, "");
const snake = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
const now = () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

/**
 * Promote a trace to a task: the task file, a reference solution drafted from the trace, and the suite list, as one change.
 * The reference starts as what the agent did. When the trace failed, that reference fails its own checks; the reply
 * lists those problems so the person can edit the reference to what the agent should have done before committing.
 */
export function promoteTrace(app: App, traceId: string, body: Obj): Reply {
  const tracePath = join(app.evalsDir, "datasets", "traces", `${safe(traceId)}.json`);
  if (!existsSync(tracePath)) throw new HttpError(404, `no trace ${traceId}`);
  const trace = JSON.parse(readFileSync(tracePath, "utf8")) as Obj; const view = traceView(trace);
  const f = loadFiles(app.evalsDir);
  const suiteName = String(body.suite ?? "regression");
  const suite = f.suites.find((s) => s.name === suiteName); if (!suite) throw new HttpError(400, `no suite ${suiteName}`);
  const firstUser = view.turns.find((t) => t.role === "user")?.content ?? "";
  const meta = view.metadata;
  const stem = snake(String(meta.scenario ?? firstUser.replace(/^From:.*\n+/i, "").split(/\s+/).slice(0, 4).join(" "))) || "trace";
  const id = body.id ? snake(String(body.id)) : `${stem}_${snake(traceId)}`;
  if (!id) throw new HttpError(400, "the task id is empty");
  if (f.tasks.some((t) => t.id === id)) throw new HttpError(409, `task ${id} already exists`);
  const already = f.tasks.find((t) => t.source === `trace:${traceId}`);
  if (already && !body.id) throw new HttpError(409, `trace ${traceId} was already promoted to task ${String(already.id)}`);

  // Checks: the tools the trace called must be called again, plus the grader of every failure mode a reviewer marked Fail.
  const tools = [...new Set(view.calls.map((c) => c.name))];
  const agentTurns = view.turns.filter((t) => t.role === "agent").length;
  const checks: Obj[] = [tools.length
    ? { id: "tools_called", type: "transcript", path_check: true, required_tools: tools }
    : { id: "turns", type: "transcript", path_check: true, max_turns: Math.max(1, agentTurns) }];
  const failed = new Set(labelsFor(app.evalsDir, traceId).filter((l) => l.label === "Fail" && l.failure_mode && l.failure_mode !== "overall").map((l) => String(l.failure_mode)));
  const ungraded: string[] = [];
  for (const mode of failed) {
    if (f.judges.some((j) => j.name === mode && j.judge)) { checks.push({ id: mode, type: "judge", failure_mode: mode }); continue; }
    const code = f.tasks.flatMap((t) => (t.checks as Obj[]) ?? []).find((c) => c.type === "code" && c.failure_mode === mode);
    if (code) checks.push({ id: mode, type: "code", fn: code.fn, ...(code.args ? { args: code.args } : {}), failure_mode: mode });
    else ungraded.push(mode);
  }

  const lastAgent = [...view.turns].reverse().find((t) => t.role === "agent")?.content ?? "";
  const task: Obj = {
    id, suite: suiteName, source: `trace:${traceId}`,
    description: `Promoted from ${traceId}${meta.scenario ? `: ${String(meta.scenario).replace(/_/g, " ")}` : ""}${meta.persona ? `, ${String(meta.persona)} customer` : ""}.`.slice(0, 1000),
    input: { ...(meta.persona ? { persona: meta.persona } : {}), message: firstUser },
    reference_solution: `refs/${id}.json`,
    checks,
  };
  const ref: Obj = {
    task: id, output: lastAgent,
    tool_calls: view.calls.map((c) => ({ name: c.name, args: c.args ?? {}, result: c.result ?? null })),
    transcript: view.turns.map((t) => ({ role: t.role, content: t.content, ...(t.tool ? { tool: t.tool } : {}) })),
    note: "Drafted from the trace as the agent actually behaved. Edit it to what the agent should have done before committing.",
    at: now(), trace_id: traceId,
  };
  const items: { path: string; data: unknown }[] = [{ path: `tasks/${suiteName}/${id}.yaml`, data: task }, { path: `refs/${id}.json`, data: ref }];
  if (Array.isArray(suite.tasks)) items.push({ path: `suites/${suiteName}.yaml`, data: { ...suite, tasks: [...new Set([...(suite.tasks as string[]), id])] } });
  const r = app.putFiles(items);
  if (r.status !== 200) return r;

  // Does the drafted reference pass its own checks? Judges are skipped by the deep check; they run on `litmustest run --dry-run`.
  const deep = validateEvals(app.evalsDir, { deep: true, deepOnly: id }).problems.filter((p) => p.file === `tasks/${suiteName}/${id}.yaml` && p.level === "error");
  return { status: 200, body: { ...(r.body as Obj), task: id, suite: suiteName, href: `#/tasks/${encodeURIComponent(suiteName)}/${encodeURIComponent(id)}`, checks: checks.map((c) => c.id), ungraded_modes: ungraded, reference_problems: deep.map((p) => p.message) } };
}

function labelsFor(evalsDir: string, traceId: string): Obj[] {
  const dir = join(evalsDir, "labels"); if (!existsSync(dir)) return [];
  const out: Obj[] = [];
  for (const file of readdirSync(dir).filter((x) => x.endsWith(".jsonl"))) for (const l of readFileSync(join(dir, file), "utf8").split("\n")) { if (!l.trim()) continue; try { const o = JSON.parse(l) as Obj; if (o.trace_id === traceId) out.push(o); } catch { /* reported by validate */ } }
  return out;
}

/**
 * Mark (or unmark) a flip between runs A and B as expected. Stored on run B as expected_flips[], written through the
 * validated save. An expected flip explains a change in the comparison's verdict sentence; it never waives a numeric gate.
 */
export function setExpectedFlip(app: App, body: Obj): Reply {
  const a = String(body.a ?? ""), b = String(body.b ?? ""), taskId = String(body.task ?? "");
  if (!a || !b || !taskId) throw new HttpError(400, "a, b and task are required");
  const path = `runs/${safe(b)}.json`; const abs = join(app.evalsDir, path);
  if (!existsSync(abs) || !existsSync(join(app.evalsDir, "runs", `${safe(a)}.json`))) throw new HttpError(404, `no run ${existsSync(abs) ? a : b}`);
  const flip = compareRuns(app.evalsDir, a, b).flips.find((x) => x.task === taskId);
  if (!flip) throw new HttpError(404, `${taskId} did not flip between ${a} and ${b}`);
  const run = JSON.parse(readFileSync(abs, "utf8")) as Obj;
  const rest = ((run.expected_flips as Obj[] | undefined) ?? []).filter((x) => !(x.task === taskId && x.vs === a));
  const expected = body.expected !== false;
  const next = expected ? [...rest, { task: taskId, change: flip.change, vs: a, by: String(body.by ?? "dashboard"), at: now(), ...(body.note ? { note: String(body.note).slice(0, 1000) } : {}) }] : rest;
  if (next.length) run.expected_flips = next; else delete run.expected_flips;
  return app.putFile(path, undefined, undefined, run);
}

/** Post the comparison of A and B as a comment on a pull request: the one given, else the current branch's. */
export function commentRoute(app: App, body: Obj): Reply {
  const a = String(body.a ?? ""), b = String(body.b ?? ""); if (!a || !b) throw new HttpError(400, "a and b are required");
  const markdown = String(((app.compare(a, b).body as Obj).markdown) ?? "");
  const cwd = app.git.root;
  const pr = body.pr ? String(body.pr).replace(/[^0-9]/g, "") : currentPr(cwd);
  if (!pr) return { status: 400, body: { error: "no_pr", message: "No pull request for this branch. Open one from Pending changes, or give a PR number." } };
  const r = postPrComment(markdown, { pr, cwd });
  if (!r.posted) return { status: 502, body: { error: "comment_failed", message: r.reason ?? "gh pr comment failed", command: `gh pr comment ${pr} --body <markdown>` } };
  return { status: 200, body: { posted: true, pr } };
}
