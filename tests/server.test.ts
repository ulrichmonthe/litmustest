import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { initEvals } from "../packages/cli/src/init.ts";
import { ingest } from "../packages/cli/src/ingest.ts";
import { serve, type Running } from "../packages/cli/src/serve.ts";

const EXAMPLE_JSONL = join(import.meta.dirname, "..", "examples", "support-agent", "traces", "support.jsonl");
const git = (cwd: string, ...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd, encoding: "utf8" }).trim();

let cwd: string; let run: Running;
const api = async (path: string, init?: RequestInit) => { const r = await fetch(run.url + path, { ...init, headers: { "content-type": "application/json", ...(init?.headers ?? {}) } }); return { status: r.status, body: await r.json() }; };
const put = (path: string, content: string, base_hash?: string) => api("/api/file", { method: "PUT", body: JSON.stringify({ path, content, base_hash }) });

beforeAll(async () => {
  cwd = mkdtempSync(join(tmpdir(), "litmustest-srv-"));
  git(cwd, "init", "-q", "-b", "main");
  initEvals({ cwd, source: EXAMPLE_JSONL });
  ingest({ cwd, evalsDir: "evals", source: EXAMPLE_JSONL, size: 10, clusters: 3, batch: "b1", now: new Date("2026-10-27T10:00:00Z") });
  writeFileSync(join(cwd, "evals", "failure_modes", "tone_mismatch.yaml"), "name: tone_mismatch\ndefinition: The agent's tone does not match the customer's state at all.\nseverity: med\ncreated: 2026-10-20\n");
  writeFileSync(join(cwd, ".gitignore"), ".litmustest/\n");
  git(cwd, "add", "-A"); git(cwd, "commit", "-q", "-m", "seed");
  run = await serve({ evalsDir: join(cwd, "evals"), port: 0, watch: false });
});
afterAll(async () => { await run.close(); });

describe("reads", () => {
  it("health and files", async () => {
    const h = await api("/api/health"); expect(h.status).toBe(200); expect(h.body.branch).toBe("main"); expect(h.body.errors).toBe(0);
    const f = await api("/api/files"); expect(f.body.files.some((x: { path: string; kind: string }) => x.path === "litmustest.yaml" && x.kind === "config")).toBe(true);
    const one = await api("/api/file?path=failure_modes/tone_mismatch.yaml"); expect(one.body.kind).toBe("failure_mode"); expect(one.body.data.name).toBe("tone_mismatch"); expect(one.body.hash).toMatch(/^[a-f0-9]{64}$/);
    expect((await api("/api/file?path=../../etc/passwd")).status).toBe(400);
    expect((await api("/api/file?path=nope.yaml")).status).toBe(404);
  });
  it("batches and traces with the derived view", async () => {
    const b = await api("/api/batches"); expect(b.body.batches[0].name).toBe("b1"); expect(b.body.batches[0].items).toBe(10);
    const one = await api("/api/batches/b1"); expect(one.body.items.length).toBe(10);
    const t = await api(`/api/traces/${one.body.items[0].trace_id}`); expect(t.status).toBe(200); expect(t.body.view.turns.length).toBeGreaterThan(1);
  });
});

describe("validated writes", () => {
  it("refuses an invalid file with the field named and leaves disk untouched", async () => {
    const before = readFileSync(join(cwd, "evals", "failure_modes", "tone_mismatch.yaml"), "utf8");
    const r = await put("failure_modes/tone_mismatch.yaml", "name: tone_mismatch\nseverity: critical\ncreated: 2026-10-20\n");
    expect(r.status).toBe(422);
    expect(r.body.problems.map((p: { message: string }) => p.message).join(" ")).toMatch(/severity/);
    expect(readFileSync(join(cwd, "evals", "failure_modes", "tone_mismatch.yaml"), "utf8")).toBe(before);
    expect((await api("/api/pending")).body.files).toEqual([]);
  });
  it("refuses a write that breaks a cross-file rule and reverts", async () => {
    const r = await put("suites/regression.yaml", "name: regression\nkind: regression\ntasks: [ghost_task]\n");
    expect(r.status).toBe(422);
    expect(r.body.problems.some((p: { rule: string }) => p.rule === "task_exists")).toBe(true);
    expect(readFileSync(join(cwd, "evals", "suites", "regression.yaml"), "utf8")).not.toContain("ghost_task");
  });
  it("saves a valid edit, reports conflict on a stale hash, and tracks it as pending with a diff", async () => {
    const cur = (await api("/api/file?path=failure_modes/tone_mismatch.yaml")).body.hash;
    const stale = await put("failure_modes/tone_mismatch.yaml", "name: tone_mismatch\ndefinition: Edited with a stale hash, should be refused.\nseverity: med\ncreated: 2026-10-20\n", "0".repeat(64));
    expect(stale.status).toBe(409); expect(stale.body.current_hash).toBe(cur); expect(stale.body.resolve).toEqual(["reload", "keep_mine"]);
    const ok = await put("failure_modes/tone_mismatch.yaml", "name: tone_mismatch\ndefinition: The agent's tone does not match the customer's state. Edited from the API.\nseverity: high\nowner: cx\ncreated: 2026-10-20\n", cur);
    expect(ok.status).toBe(200); expect(ok.body.status).toBe("saved to branch");
    const p = await api("/api/pending");
    expect(p.body.files.length).toBe(1);
    expect(p.body.files[0].status).toBe("modified");
    expect(p.body.files[0].diff).toContain("+severity: high");
    expect(p.body.files[0].affected_views).toContain("Failure modes");
    // keep mine: resend with the current hash
    const again = await put("failure_modes/tone_mismatch.yaml", "name: tone_mismatch\ndefinition: The agent's tone does not match the customer's state. Edited twice from the API.\nseverity: high\nowner: cx\ncreated: 2026-10-20\n", stale.body.current_hash);
    expect(again.status).toBe(409);
    const keep = await put("failure_modes/tone_mismatch.yaml", "name: tone_mismatch\ndefinition: The agent's tone does not match the customer's state. Edited twice from the API.\nseverity: high\nowner: cx\ncreated: 2026-10-20\n", again.body.current_hash);
    expect(keep.status).toBe(200);
  });
  it("creates a new file and refuses calibration and trace writes", async () => {
    const r = await put("failure_modes/missed_refund.yaml", "name: missed_refund\ndefinition: The customer was owed a refund and none was processed before the conversation ended.\nseverity: high\ncreated: 2026-10-27\n");
    expect(r.status).toBe(200);
    expect((await api("/api/pending")).body.files.find((f: { path: string }) => f.path.endsWith("missed_refund.yaml")).status).toBe("added");
    expect((await put("graders/judges/x/calibration.json", "{}")).status).toBe(403);
    expect((await put("datasets/traces/tr_0001.json", "{}")).status).toBe(403);
  });
});

describe("labels", () => {
  it("appends a validated label with a timestamp and lists it on the trace", async () => {
    const b = await api("/api/batches/b1"); const id = b.body.items[0].trace_id;
    const r = await api("/api/labels", { method: "POST", body: JSON.stringify({ batch: "b1", trace_id: id, failure_mode: "tone_mismatch", label: "Fail", note: "breezy", annotator: "ulrich" }) });
    expect(r.status).toBe(200); expect(r.body.label.at).toMatch(/Z$/);
    expect(Math.abs(Date.now() - Date.parse(r.body.label.at))).toBeLessThan(1000);
    expect(readFileSync(join(cwd, "evals", "labels", "b1.jsonl"), "utf8").trim().split("\n").length).toBe(1);
    expect((await api(`/api/traces/${id}`)).body.labels.length).toBe(1);
    expect((await api("/api/batches/b1")).body.items[0].labels.length).toBe(1);
    const bad = await api("/api/labels", { method: "POST", body: JSON.stringify({ batch: "b1", trace_id: id, failure_mode: "nope", label: "Fail", annotator: "u" }) });
    expect(bad.status).toBe(422);
  });
});

describe("pending changes tray", () => {
  it("commits to an evals/<slug> branch, then discards a later edit", async () => {
    const c = await api("/api/pending/commit", { method: "POST", body: JSON.stringify({ slug: "tone-and-labels" }) });
    expect(c.status).toBe(200); expect(c.body.branch).toBe("evals/tone-and-labels"); expect(c.body.commit).toMatch(/^[a-f0-9]{7,}$/);
    expect(git(cwd, "rev-parse", "--abbrev-ref", "HEAD")).toBe("evals/tone-and-labels");
    expect(git(cwd, "status", "--porcelain")).toBe("");
    expect((await api("/api/pending")).body.files).toEqual([]);
    const cur = (await api("/api/file?path=failure_modes/missed_refund.yaml")).body.hash;
    await put("failure_modes/missed_refund.yaml", "name: missed_refund\ndefinition: Will be discarded. The customer was owed a refund and none was processed.\nseverity: low\ncreated: 2026-10-27\n", cur);
    await put("failure_modes/over_searching.yaml", "name: over_searching\ndefinition: The agent repeats a lookup with trivially different arguments instead of using the first result.\nseverity: low\ncreated: 2026-10-27\n");
    expect((await api("/api/pending")).body.files.length).toBe(2);
    const d = await api("/api/pending/discard", { method: "POST", body: JSON.stringify({}) });
    expect(d.status).toBe(200);
    expect(readFileSync(join(cwd, "evals", "failure_modes", "missed_refund.yaml"), "utf8")).toContain("severity: high");
    expect(existsSync(join(cwd, "evals", "failure_modes", "over_searching.yaml"))).toBe(false);
    expect((await api("/api/pending")).body.files).toEqual([]);
    expect((await api("/api/pending/commit", { method: "POST", body: "{}" })).status).toBe(400);
  });
  it("open PR without a remote fails with the command to run", async () => {
    const r = await api("/api/pending/pr", { method: "POST", body: "{}" });
    expect(r.status).toBe(502); expect(r.body.command).toContain("gh pr create");
  });
});

describe("judge side effects", () => {
  it("saving a judge prompt updates prompt_hash and marks a trusted calibration stale", async () => {
    const dir = join(cwd, "evals", "graders", "judges", "tone_mismatch");
    const h = (s: string) => execFileSync("shasum", ["-a", "256"], { input: s, encoding: "utf8" }).slice(0, 64);
    const prompt = "You check tone_mismatch. Critique first, then Pass, Fail or Unknown.\n";
    expect((await put("graders/judges/tone_mismatch/prompt.md", prompt)).status).toBe(200);
    expect((await put("graders/judges/tone_mismatch/judge.yaml", `id: tone_mismatch\nfailure_mode: tone_mismatch\nmodel: claude-sonnet-5-5\ninputs: [transcript]\noutput:\n  critique: { type: string }\n  result: { enum: [Pass, Fail, Unknown] }\nprompt: graders/judges/tone_mismatch/prompt.md\nprompt_hash: ${h(prompt)}\n`)).status).toBe(200);
    const split = (ids: string[]) => ({ trace_ids: ids, hash: h(ids.join("\n")) });
    writeFileSync(join(dir, "calibration.json"), JSON.stringify({ judge: "tone_mismatch", prompt_hash: h(prompt), model: "claude-sonnet-5-5", splits: { train: split(["tr_0001"]), dev: split(["tr_0002"]), test: split(["tr_0003"]) }, dev: { runs: [] }, test: { tpr: 95, tnr: 95, matrix: { tp: 1, tn: 1, fp: 0, fn: 0 }, ran_at: "2026-10-26T10:00:00Z", prompt_hash: h(prompt) }, status: "trusted" }));
    run.app.invalidate();
    expect((await api("/api/health")).body.errors).toBe(0);
    const r = await put("graders/judges/tone_mismatch/prompt.md", prompt + "\nBe strict about exclamation marks.\n");
    expect(r.status).toBe(200);
    expect(r.body.side_effects).toEqual(["graders/judges/tone_mismatch/judge.yaml", "graders/judges/tone_mismatch/calibration.json"]);
    const cal = JSON.parse(readFileSync(join(dir, "calibration.json"), "utf8"));
    expect(cal.status).toBe("stale"); expect(cal.stale_reason).toBe("prompt_changed");
    expect(readFileSync(join(dir, "judge.yaml"), "utf8")).toContain(h(prompt + "\nBe strict about exclamation marks.\n"));
    expect((await api("/api/health")).body.errors).toBe(0);
  });
});
