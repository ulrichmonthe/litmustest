// Judge routes: list, detail with lint checks, calibrate in the background with progress events, and the two drafts.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { calibrate, labelsFor, makeSplits } from "../calibrate.ts";
import { draftCheck, draftJudge } from "../draft.ts";
import type { JudgeAsk } from "../judge_run.ts";
import type { Ask } from "../discover.ts";
import { SchemaSet } from "../schemas.ts";
import { sha256 } from "../validate.ts";
import { loadFiles, judgeStatus } from "./overview.ts";
import type { App, Reply } from "./app.ts";

type Obj = Record<string, unknown>;
export interface JudgeHooks { judgeAsk?: JudgeAsk; draftAsk?: Ask }
const running = new Map<string, { split: string; started: string; done: number; total: number }>();

export function judgesList(app: App): Reply {
  const f = loadFiles(app.evalsDir);
  const threshold = Number((f.config.judges as Obj | undefined)?.trust_threshold ?? 90);
  const judges = f.judges.map((j) => {
    const s = judgeStatus(j, threshold);
    const c = j.calibration; const dev = c?.dev as Obj | undefined; const test = c?.test as Obj | null | undefined;
    const used = f.tasks.filter((t) => ((t.checks as Obj[]) ?? []).some((ch) => ch.type === "judge" && (ch.judge ?? ch.failure_mode) === j.name)).length;
    return { name: j.name, failure_mode: j.judge?.failure_mode ?? j.name, status: s.status, label: s.label, model: j.judge?.model, version: j.judge?.version ?? 1, dev: dev?.tpr !== undefined ? { tpr: dev.tpr, tnr: dev.tnr } : null, test: test && s.status !== "stale" ? { tpr: test.tpr, tnr: test.tnr } : null, labels: labelsFor(app.evalsDir, String(j.judge?.failure_mode ?? j.name)).size, used_by: used, running: running.get(j.name) ?? null };
  });
  // failure modes without a judge, so the list can offer to draft one
  const candidates = f.modes.filter((m) => !m.retired && !f.judges.some((j) => j.name === m.name)).map((m) => ({ name: m.name, labels: labelsFor(app.evalsDir, String(m.name)).size, has_code_check: f.tasks.some((t) => ((t.checks as Obj[]) ?? []).some((ch) => ch.type === "code" && ch.failure_mode === m.name)) }));
  return { status: 200, body: { judges, candidates, threshold } };
}

export function judgeDetail(app: App, name: string): Reply {
  const dir = join(app.evalsDir, "graders", "judges", name);
  if (!existsSync(join(dir, "judge.yaml"))) return { status: 404, body: { error: "not_found", message: `no judge ${name}` } };
  const f = loadFiles(app.evalsDir);
  const threshold = Number((f.config.judges as Obj | undefined)?.trust_threshold ?? 90);
  const j = f.judges.find((x) => x.name === name)!;
  const judgeText = readFileSync(join(dir, "judge.yaml"), "utf8");
  const promptPath = join(app.evalsDir, String(j.judge!.prompt));
  const promptText = existsSync(promptPath) ? readFileSync(promptPath, "utf8") : "";
  const s = judgeStatus(j, threshold);
  const labels = labelsFor(app.evalsDir, String(j.judge!.failure_mode));
  const cal = j.calibration;
  const sp = cal?.splits as Record<string, { trace_ids: string[] }> | undefined;
  const splits = sp ? { train: sp.train.trace_ids, dev: sp.dev.trace_ids, test: sp.test.trace_ids } : makeSplits(name, labels);
  const few = (j.judge!.few_shot as { trace_id: string }[] | undefined) ?? [];
  const promptHash = sha256(promptText);
  const schemaErrs = new SchemaSet().check("judge", j.judge);
  const mentions = (re: RegExp) => re.test(promptText);
  const fewLabels = new Set(few.map((x) => labels.get(x.trace_id)?.label ?? (x as Obj).label));
  const checks = [
    { id: "schema", ok: schemaErrs.length === 0, text: schemaErrs.length ? `judge.yaml: ${schemaErrs[0]}` : "judge.yaml validates against its schema" },
    { id: "one_mode", ok: j.judge!.failure_mode === name && f.modes.some((m) => m.name === name), text: "One failure mode, and it exists" },
    { id: "pass_fail", ok: mentions(/\bpass\b/i) && mentions(/\bfail\b/i), text: "Prompt says what Pass and what Fail look like" },
    { id: "unknown", ok: mentions(/\bunknown\b/i), text: "Prompt allows Unknown when the inputs cannot settle it" },
    { id: "examples", ok: few.length >= 3 && fewLabels.has("Pass") && fewLabels.has("Fail"), text: few.length >= 3 ? "Three or more examples, with a Pass and a Fail" : `Needs ${Math.max(0, 3 - few.length)} more few-shot example${3 - few.length === 1 ? "" : "s"}` },
    { id: "leakage", ok: !few.some((x) => splits.dev.includes(x.trace_id) || splits.test.includes(x.trace_id)), text: "No few-shot example in the dev or test split" },
    { id: "hash", ok: j.judge!.prompt_hash === promptHash, text: j.judge!.prompt_hash === promptHash ? "prompt_hash matches prompt.md" : "prompt_hash is out of date; the next save fixes it" },
    { id: "model", ok: !/(latest|preview|beta)$/i.test(String(j.judge!.model)), text: "Model pinned to one id" },
  ];
  const trainCandidates = splits.train.map((id) => ({ trace_id: id, label: labels.get(id)?.label, note: labels.get(id)?.note, in_few_shot: few.some((x) => x.trace_id === id) }));
  const used = f.tasks.filter((t) => ((t.checks as Obj[]) ?? []).some((ch) => ch.type === "judge" && (ch.judge ?? ch.failure_mode) === name)).map((t) => ({ id: t.id, suite: t.suite }));
  const dev = cal?.dev as Obj | undefined; const test = cal?.test as Obj | null | undefined;
  const devOk = dev?.tpr !== undefined && Number(dev.tpr) >= threshold && Number(dev.tnr) >= threshold && ((dev.runs as Obj[]) ?? []).some((r) => r.prompt_hash === promptHash);
  const testDone = Boolean(test && test.prompt_hash === promptHash);
  const step = s.status === "trusted" ? 4 : testDone ? 3 : devOk ? 3 : dev?.tpr !== undefined ? 2 : 1;
  return { status: 200, body: {
    name, failure_mode: j.judge!.failure_mode, status: s.status, label: s.label, threshold, step,
    judge: { data: j.judge, content: judgeText, hash: sha256(judgeText), path: `graders/judges/${name}/judge.yaml` },
    prompt: { content: promptText, hash: promptHash, path: `graders/judges/${name}/prompt.md` },
    calibration: cal ?? null, splits: { train: splits.train.length, dev: splits.dev.length, test: splits.test.length }, labels: labels.size,
    fail_labels: [...labels.values()].filter((l) => l.label === "Fail").length,
    checks, train_candidates: trainCandidates, used_by: used, mode: f.modes.find((m) => m.name === name) ?? null,
    can_run_test: devOk && !testDone, test_done: testDone, running: running.get(name) ?? null,
  } };
}

export async function judgeCalibrate(app: App, name: string, body: Obj, hooks: JudgeHooks): Promise<Reply> {
  const split = (body.split as "dev" | "test" | "none") ?? "dev";
  if (!["dev", "test", "none"].includes(split)) return { status: 400, body: { error: "bad_split", message: "split must be dev, test or none" } };
  if (running.has(name)) return { status: 409, body: { error: "running", message: `${name} is already being calibrated`, running: running.get(name) } };
  const job = { split, started: new Date().toISOString(), done: 0, total: 0 };
  running.set(name, job);
  app.emit({ type: "calibrate", judge: name, split, done: 0, total: 0, state: "started" });
  const run = calibrate({ evalsDir: app.evalsDir, judge: name, split, ask: hooks.judgeAsk, force: Boolean(body.force), onProgress: (done, total) => { job.done = done; job.total = total; app.emit({ type: "calibrate", judge: name, split, done, total, state: "running" }); } })
    .then((r) => { app.pending.track(r.path); app.invalidate(); app.emit({ type: "calibrate", judge: name, split, state: "done", status: r.status, tpr: r.ran?.tpr, tnr: r.ran?.tnr, warnings: r.warnings }); return r; })
    .catch((e: Error) => { app.emit({ type: "calibrate", judge: name, split, state: "failed", message: e.message }); throw e; })
    .finally(() => running.delete(name));
  if (body.wait) {
    try { const r = await run; return { status: 200, body: { judge: name, split, status: r.status, ran: r.ran, warnings: r.warnings, splits: r.splits } }; }
    catch (e) { return { status: 400, body: { error: "calibrate_failed", message: (e as Error).message } }; }
  }
  run.catch(() => {});
  return { status: 202, body: { judge: name, split, started: job.started } };
}

export async function judgeDraft(app: App, mode: string, hooks: JudgeHooks): Promise<Reply> {
  try { const r = await draftJudge({ evalsDir: app.evalsDir, failureMode: mode, ask: hooks.draftAsk }); for (const f of r.files) app.pending.track(join(app.evalsDir, f.path)); app.invalidate(); app.emit({ type: "saved", path: r.files[0]!.path, side_effects: r.files.slice(1).map((f) => f.path) }); return { status: 200, body: r }; }
  catch (e) { return { status: modelUnavailable(e) ? 502 : 400, body: { error: "draft_failed", message: (e as Error).message } }; }
}
export async function checkDraft(app: App, mode: string, hooks: JudgeHooks): Promise<Reply> {
  try { const r = await draftCheck({ evalsDir: app.evalsDir, failureMode: mode, ask: hooks.draftAsk }); for (const f of r.files) app.pending.track(join(app.evalsDir, f.path)); app.invalidate(); app.emit({ type: "saved", path: r.files[0]!.path, side_effects: r.files.slice(1).map((f) => f.path) }); return { status: 200, body: r }; }
  catch (e) { return { status: modelUnavailable(e) ? 502 : 400, body: { error: "draft_failed", message: (e as Error).message } }; }
}
function modelUnavailable(e: unknown): boolean { return /authentication|api key|apiKey|authToken|401/i.test((e as Error).message ?? ""); }

/** The few-shot picker: labelled traces in the train split with a short excerpt. */
export function trainExcerpts(app: App, name: string): Reply {
  const dir = join(app.evalsDir, "graders", "judges", name);
  if (!existsSync(join(dir, "judge.yaml"))) return { status: 404, body: { error: "not_found", message: `no judge ${name}` } };
  const judge = parseYaml(readFileSync(join(dir, "judge.yaml"), "utf8")) as Obj;
  const labels = labelsFor(app.evalsDir, String(judge.failure_mode));
  const calPath = join(dir, "calibration.json");
  const sp = existsSync(calPath) ? ((JSON.parse(readFileSync(calPath, "utf8")) as Obj).splits as Record<string, { trace_ids: string[] }>) : undefined;
  const train = sp ? sp.train.trace_ids : makeSplits(name, labels).train;
  const tracesDir = join(app.evalsDir, "datasets", "traces");
  const items = train.map((id) => { let excerpt = ""; try { const t = JSON.parse(readFileSync(join(tracesDir, `${id}.json`), "utf8")); const msgs = (t.spans as Obj[]).flatMap((s) => ((s.attributes as Obj)?.["gen_ai.output.messages"] as Obj[]) ?? []); const text = msgs.flatMap((m) => (m.parts as Obj[]).filter((p) => p.type === "text").map((p) => String(p.content))).join(" "); excerpt = text.slice(0, 160); } catch { /* no trace */ } return { trace_id: id, label: labels.get(id)?.label, note: labels.get(id)?.note, excerpt }; });
  void readdirSync;
  return { status: 200, body: { train: items } };
}
