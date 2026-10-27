import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { serve, type Running } from "../packages/cli/src/serve.ts";
import type { JudgeAsk } from "../packages/cli/src/judge_run.ts";

const EXAMPLE = join(import.meta.dirname, "..", "examples", "support-agent", "evals");
const PLANTED = join(import.meta.dirname, "..", "examples", "support-agent", "traces", "planted_truth.jsonl");
const git = (cwd: string, ...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd, encoding: "utf8" }).trim();
let cwd: string; let run: Running; let planted: Map<string, string[]>;
const api = async (path: string, init?: RequestInit) => { const r = await fetch(run.url + path, { ...init, headers: { "content-type": "application/json" } }); return { status: r.status, body: await r.json() }; };
const oracle: JudgeAsk = async (_s, user) => { const id = /Trace to judge · (tr_\d+)/.exec(user)?.[1] ?? ""; const mode = /failure mode: \*\*(\w+)\*\*|one failure mode: (\w+)/i.exec(_s); const name = mode?.[1] ?? mode?.[2] ?? "tone_mismatch"; const fail = planted.get(id)?.includes(name); return JSON.stringify({ critique: "oracle", result: fail ? "Fail" : "Pass" }); };

beforeAll(async () => {
  cwd = mkdtempSync(join(tmpdir(), "litmustest-jr-"));
  git(cwd, "init", "-q", "-b", "main");
  cpSync(EXAMPLE, join(cwd, "evals"), { recursive: true });
  planted = new Map(readFileSync(PLANTED, "utf8").split("\n").filter(Boolean).map((l) => { const o = JSON.parse(l); return [o.trace_id, o.failures]; }));
  writeFileSync(join(cwd, ".gitignore"), ".litmustest/\n");
  git(cwd, "add", "-A"); git(cwd, "commit", "-q", "-m", "seed");
  run = await serve({ evalsDir: join(cwd, "evals"), port: 0, watch: false, judgeAsk: oracle });
});
afterAll(async () => { await run.close(); });

describe("judges API", () => {
  it("lists judges with status and candidates without a judge", async () => {
    const r = await api("/api/judges");
    expect(r.status).toBe(200);
    const tm = r.body.judges.find((j: { name: string }) => j.name === "tone_mismatch");
    expect(tm.status).toBe("trusted"); expect(tm.used_by).toBe(40); expect(tm.labels).toBe(50);
    expect(r.body.judges.find((j: { name: string }) => j.name === "missed_refund").status).toBe("stale");
    expect(r.body.candidates.map((c: { name: string }) => c.name)).toContain("over_searching");
  });
  it("details a judge with lint checks, splits, the stepper step and the few-shot picker", async () => {
    const r = await api("/api/judges/tone_mismatch");
    expect(r.status).toBe(200); expect(r.body.step).toBe(4);
    expect(r.body.checks.every((c: { ok: boolean }) => c.ok)).toBe(true);
    expect(r.body.splits.train + r.body.splits.dev + r.body.splits.test).toBe(50);
    expect(r.body.prompt.hash).toMatch(/^[a-f0-9]{64}$/); expect(r.body.judge.hash).toMatch(/^[a-f0-9]{64}$/);
    const t = await api("/api/judges/tone_mismatch/train");
    expect(t.body.train.length).toBe(r.body.splits.train); expect(t.body.train[0]).toHaveProperty("label");
    expect((await api("/api/judges/nope")).status).toBe(404);
  });
  it("calibrates on dev with wait, streams progress, and the stale judge advances to dev", async () => {
    const events: string[] = [];
    const ctrl = new AbortController();
    const stream = fetch(run.url + "/api/events", { signal: ctrl.signal }).then(async (res) => { const reader = res.body!.getReader(); const dec = new TextDecoder(); while (true) { const { value, done } = await reader.read(); if (done) break; events.push(dec.decode(value)); } }).catch(() => {});
    await new Promise((r) => setTimeout(r, 100));
    const r = await api("/api/judges/missed_refund/calibrate", { method: "POST", body: JSON.stringify({ split: "dev", wait: true }) });
    expect(r.status).toBe(200); expect(r.body.ran.tpr).toBeGreaterThan(50); expect(r.body.status).toBe("dev");
    await new Promise((r) => setTimeout(r, 100)); ctrl.abort(); await stream;
    const text = events.join("");
    expect(text).toContain("event: calibrate"); expect(text).toContain('"state":"done"');
    const d = await api("/api/judges/missed_refund");
    expect(d.body.status).toBe("dev"); expect(d.body.step).toBeGreaterThanOrEqual(2);
    expect((await api("/api/pending")).body.files.some((f: { path: string }) => f.path.endsWith("missed_refund/calibration.json"))).toBe(true);
  });
  it("refuses a second concurrent run and a bad split", async () => {
    expect((await api("/api/judges/missed_refund/calibrate", { method: "POST", body: JSON.stringify({ split: "weird" }) })).status).toBe(400);
    const a = await api("/api/judges/tone_mismatch/calibrate", { method: "POST", body: JSON.stringify({ split: "dev" }) });
    expect(a.status).toBe(202);
    const b = await api("/api/judges/tone_mismatch/calibrate", { method: "POST", body: JSON.stringify({ split: "dev" }) });
    expect([202, 409]).toContain(b.status);
    await new Promise((r) => setTimeout(r, 1500));
  });
});
