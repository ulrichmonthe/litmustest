// litmustest calibrate <judge>: split the labels, run the judge on dev (freely) or test (once), write calibration.json.
// This is the only writer of calibration.json besides the server marking it stale.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { SchemaSet } from "./schemas.ts";
import { sha256 } from "./validate.ts";
import { bootstrapRates, matrixOf, tnr, tpr, type Matrix } from "./stats.ts";
import { judgeTraces, loadJudge, type JudgeAsk, type Verdict } from "./judge_run.ts";

type Obj = Record<string, unknown>;
export interface Splits { train: string[]; dev: string[]; test: string[] }
export interface CalibrateOptions { evalsDir: string; judge: string; split?: "dev" | "test" | "none"; ask?: JudgeAsk; force?: boolean; concurrency?: number; seed?: number; now?: Date; onProgress?: (done: number, total: number, v: Verdict) => void }
export interface CalibrateResult { judge: string; split: "dev" | "test" | "none"; labels: number; splits: Splits; ran?: { tpr: number; tnr: number; matrix: Matrix; tpr_ci: Obj; tnr_ci: Obj; unknown: number; disagreements: Obj[] }; status: string; calibration: Obj; path: string; warnings: string[] }

/** Latest human label per trace for one failure mode; Skip and labels without a verdict are ignored. */
export function labelsFor(evalsDir: string, failureMode: string): Map<string, { label: "Pass" | "Fail"; note?: string; at: string }> {
  const out = new Map<string, { label: "Pass" | "Fail"; note?: string; at: string }>();
  const dir = join(evalsDir, "labels");
  if (!existsSync(dir)) return out;
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".jsonl")).sort()) for (const line of readFileSync(join(dir, f), "utf8").split("\n")) {
    if (!line.trim()) continue;
    let l: Obj; try { l = JSON.parse(line); } catch { continue; }
    if (l.failure_mode !== failureMode || (l.label !== "Pass" && l.label !== "Fail")) continue;
    const prev = out.get(String(l.trace_id));
    if (!prev || String(l.at) >= prev.at) out.set(String(l.trace_id), { label: l.label as "Pass" | "Fail", note: l.note as string | undefined, at: String(l.at) });
  }
  return out;
}

const splitHash = (ids: string[]) => sha256([...ids].sort().join("\n"));
const bucket = (id: string, judge: string) => parseInt(createHash("sha256").update(`${judge}:${id}`).digest("hex").slice(0, 8), 16) / 0xffffffff;

/**
 * 15/45/40 train/dev/test, stratified by label, deterministic per trace id. The test split is locked: traces already in a
 * split stay there, and new traces go to train or dev only, so the held-out set never grows after a test run.
 */
export function makeSplits(judge: string, labels: Map<string, { label: "Pass" | "Fail" }>, existing?: Splits): Splits {
  const s: Splits = { train: [...(existing?.train ?? [])], dev: [...(existing?.dev ?? [])], test: [...(existing?.test ?? [])] };
  const placed = new Set([...s.train, ...s.dev, ...s.test].filter((id) => labels.has(id)));
  s.train = s.train.filter((id) => labels.has(id)); s.dev = s.dev.filter((id) => labels.has(id)); s.test = s.test.filter((id) => labels.has(id));
  const fresh = [...labels.keys()].filter((id) => !placed.has(id));
  for (const label of ["Fail", "Pass"] as const) {
    const ids = fresh.filter((id) => labels.get(id)!.label === label).sort((a, b) => bucket(a, judge) - bucket(b, judge));
    ids.forEach((id, i) => {
      const q = (i + 0.5) / ids.length;
      if (existing && existing.test.length) s[q < 0.25 ? "train" : "dev"].push(id); // test is locked
      else s[q < 0.15 ? "train" : q < 0.6 ? "dev" : "test"].push(id);
    });
  }
  for (const k of ["train", "dev", "test"] as const) s[k].sort();
  return s;
}

export async function calibrate(o: CalibrateOptions): Promise<CalibrateResult> {
  const judge = loadJudge(o.evalsDir, o.judge);
  const failureMode = String(judge.judge.failure_mode);
  const config = existsSync(join(o.evalsDir, "litmustest.yaml")) ? (parseYaml(readFileSync(join(o.evalsDir, "litmustest.yaml"), "utf8")) as Obj) : {};
  const threshold = Number((config.judges as Obj | undefined)?.trust_threshold ?? 90);
  const labels = labelsFor(o.evalsDir, failureMode);
  const warnings: string[] = [];
  if (labels.size < 60) warnings.push(`${labels.size} labels for ${failureMode}; under 60 gives wide intervals (the course suggests 60 or more)`);
  const fails = [...labels.values()].filter((l) => l.label === "Fail").length;
  if (labels.size && (fails < labels.size * 0.2 || fails > labels.size * 0.8)) warnings.push(`labels are imbalanced: ${fails} Fail of ${labels.size}; aim for a balanced calibration set`);
  const calPath = join(judge.dir, "calibration.json");
  const existing = existsSync(calPath) ? (JSON.parse(readFileSync(calPath, "utf8")) as Obj) : undefined;
  const existingSplits = existing?.splits as Record<string, { trace_ids: string[] }> | undefined;
  const splits = makeSplits(o.judge, labels, existingSplits ? { train: existingSplits.train.trace_ids, dev: existingSplits.dev.trace_ids, test: existingSplits.test.trace_ids } : undefined);
  const promptHash = sha256(readFileSync(join(o.evalsDir, String(judge.judge.prompt))));
  if (judge.judge.prompt_hash !== promptHash) warnings.push(`judge.yaml prompt_hash does not match prompt.md; calibrating against the prompt on disk (${promptHash.slice(0, 12)}…)`);
  const model = String(judge.judge.model);
  const split = o.split ?? "dev";
  const now = (o.now ?? new Date()).toISOString().replace(/\.\d{3}Z$/, "Z");

  // few-shot leakage is a hard stop: the examples must come from train
  const few = ((judge.judge.few_shot as { trace_id: string }[]) ?? []).map((f) => f.trace_id);
  const leaked = few.filter((id) => splits.dev.includes(id) || splits.test.includes(id));
  if (leaked.length) throw new Error(`few_shot traces ${leaked.join(", ")} are in the dev or test split; pick examples from train only`);

  const cal: Obj = {
    judge: o.judge, prompt_hash: promptHash, model,
    splits: { train: { trace_ids: splits.train, hash: splitHash(splits.train) }, dev: { trace_ids: splits.dev, hash: splitHash(splits.dev) }, test: { trace_ids: splits.test, hash: splitHash(splits.test) } },
    dev: (existing?.dev as Obj) ?? { runs: [] },
    test: (existing?.test as Obj | null) ?? null,
    status: "untested",
  };
  // a previous test on a different prompt or model no longer describes this judge
  const testObj = cal.test as Obj | null;
  const testValid = testObj && testObj.prompt_hash === promptHash && existing?.model === model;
  let ran: CalibrateResult["ran"] | undefined;

  if (split !== "none") {
    const ids = splits[split];
    if (!ids.length) throw new Error(`the ${split} split is empty; label more traces for ${failureMode} first`);
    if (split === "test") {
      const dev = cal.dev as Obj;
      const devOk = dev.tpr !== undefined && Number(dev.tpr) >= threshold && Number(dev.tnr) >= threshold && (dev.runs as Obj[]).some((r) => r.prompt_hash === promptHash);
      if (!devOk && !o.force) throw new Error(`the test set runs once, after dev reaches TPR and TNR >= ${threshold} on this prompt; dev is ${dev.tpr ?? "not run"} / ${dev.tnr ?? "not run"}. Pass --force to override`);
      if (testValid && !o.force) throw new Error(`the test set already ran for this prompt and model on ${testObj!.ran_at}; edit the judge or pass --force`);
    }
    const verdicts = await judgeTraces({ evalsDir: o.evalsDir, judge, traceIds: ids, labelsByTrace: labels, ask: o.ask, concurrency: o.concurrency, onVerdict: (v, d, t) => o.onProgress?.(d, t, v) });
    const pairs = verdicts.map((v) => ({ human: labels.get(v.trace_id)!.label, judge: v.result }));
    const matrix = matrixOf(pairs);
    const ci = bootstrapRates(pairs, 1000, o.seed ?? 1);
    const disagreements = verdicts.filter((v) => v.result !== labels.get(v.trace_id)!.label).map((v) => ({ trace_id: v.trace_id, human: labels.get(v.trace_id)!.label, judge: v.result, critique: v.critique.slice(0, 500) }));
    ran = { tpr: +tpr(matrix).toFixed(1), tnr: +tnr(matrix).toFixed(1), matrix, tpr_ci: { low: ci.tpr.low, high: ci.tpr.high }, tnr_ci: { low: ci.tnr.low, high: ci.tnr.high }, unknown: matrix.unknown, disagreements };
    const record = { ran_at: now, prompt_hash: promptHash, version: Number(judge.judge.version ?? 1), tpr: ran.tpr, tnr: ran.tnr, tpr_ci: ran.tpr_ci, tnr_ci: ran.tnr_ci, matrix };
    if (split === "dev") { cal.dev = { tpr: ran.tpr, tnr: ran.tnr, tpr_ci: ran.tpr_ci, tnr_ci: ran.tnr_ci, matrix, runs: [...(((cal.dev as Obj).runs as Obj[]) ?? []), record].slice(-20) }; cal.disagreements = disagreements; }
    else cal.test = { tpr: ran.tpr, tnr: ran.tnr, tpr_ci: ran.tpr_ci, tnr_ci: ran.tnr_ci, matrix, ran_at: now, prompt_hash: promptHash };
  }
  // status: trusted/dev when a test on this prompt exists; dev once dev ran on this prompt; stale when the only
  // test is for an older prompt or model; untested otherwise.
  const t = cal.test as Obj | null;
  const devRuns = (((cal.dev as Obj).runs as Obj[]) ?? []);
  const devOnThisPrompt = devRuns.some((r) => r.prompt_hash === promptHash);
  delete cal.stale_reason;
  if (t && t.prompt_hash === promptHash && (split === "test" || testValid)) cal.status = Number(t.tpr) >= threshold && Number(t.tnr) >= threshold ? "trusted" : "dev";
  else if (devOnThisPrompt) cal.status = "dev";
  else if (t) { cal.status = "stale"; cal.stale_reason = existing?.model !== model ? "model_changed" : "prompt_changed"; }
  else cal.status = "untested";

  const errs = new SchemaSet().check("calibration", cal);
  if (errs.length) throw new Error(`calibration.json would not validate: ${errs.join("; ")}`);
  writeFileSync(calPath, JSON.stringify(cal, null, 2) + "\n");
  return { judge: o.judge, split, labels: labels.size, splits, ran, status: String(cal.status), calibration: cal, path: calPath, warnings };
}
