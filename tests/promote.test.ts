// A1: promote a trace to a task, mark a flip expected, post a comparison to the PR.
import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { compareRuns, comparisonMarkdown, evaluateGates } from "../packages/cli/src/compare.ts";
import { validateEvals } from "../packages/cli/src/validate.ts";
import { serve, type Running } from "../packages/cli/src/serve.ts";

const EXAMPLE = join(import.meta.dirname, "..", "examples", "support-agent", "evals");
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" });

let repo: string, evals: string, server: Running;
const api = async (path: string, init?: RequestInit) => { const r = await fetch(`${server.url}${path}`, { ...init, headers: { "content-type": "application/json" } }); return { status: r.status, body: (await r.json()) as Record<string, any> }; };
const post = (path: string, body: unknown) => api(path, { method: "POST", body: JSON.stringify(body) });

beforeAll(async () => {
  repo = mkdtempSync(join(tmpdir(), "lt-promote-")); evals = join(repo, "evals");
  cpSync(EXAMPLE, evals, { recursive: true });
  writeFileSync(join(repo, ".gitignore"), ".litmustest/\n");
  git(repo, "init", "-q", "-b", "main"); git(repo, "add", "-A"); git(repo, "commit", "-q", "-m", "seed");
  server = await serve({ evalsDir: evals, port: 0, watch: false });
});
afterAll(async () => { await server?.close(); });

describe("promote a trace to a task", () => {
  it("writes the task, a reference drafted from the trace and the suite entry as one pending change", async () => {
    const before = (await api("/api/pending")).body.files.length;
    const r = await post("/api/traces/tr_0300/promote", { suite: "regression" });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const id = r.body.task as string;
    expect(id).toMatch(/^[a-z0-9_]+_tr_0300$/);
    const task = parseYaml(readFileSync(join(evals, "tasks", "regression", `${id}.yaml`), "utf8"));
    expect(task.source).toBe("trace:tr_0300");
    expect(task.input.message).toBeTruthy();
    // the reviewer marked tone_mismatch Fail on this trace, and that mode has a judge
    expect(task.checks.map((c: any) => c.id)).toContain("tone_mismatch");
    const tools = task.checks.find((c: any) => c.type === "transcript");
    expect(tools.required_tools.length).toBeGreaterThan(0);
    const ref = JSON.parse(readFileSync(join(evals, "refs", `${id}.json`), "utf8"));
    expect(ref.task).toBe(id); expect(ref.trace_id).toBe("tr_0300");
    expect(ref.transcript.at(-1).role).toBe("agent");
    expect(parseYaml(readFileSync(join(evals, "suites", "regression.yaml"), "utf8")).tasks).toContain(id);
    expect((await api("/api/pending")).body.files.length).toBe(before + 3);
    expect(validateEvals(evals).errors).toBe(0);
    expect(r.body.href).toBe(`#/tasks/regression/${id}`);
    expect(Array.isArray(r.body.reference_problems)).toBe(true);
    // the review queue now knows which tools the task expects of this trace
    expect((await api("/api/traces/tr_0300")).body.expected_tools).toEqual(tools.required_tools);
    }, 30_000);
  it("refuses a second promotion of the same trace, an unknown suite and an unknown trace, and writes nothing", async () => {
    const before = (await api("/api/pending")).body.files.length;
    expect((await post("/api/traces/tr_0300/promote", {})).status).toBe(409);
    expect((await post("/api/traces/tr_0299/promote", { suite: "nope" })).status).toBe(400);
    expect((await post("/api/traces/tr_9999/promote", {})).status).toBe(404);
    expect((await api("/api/pending")).body.files.length).toBe(before);
    expect(existsSync(join(evals, "tasks", "nope"))).toBe(false);
  });
});

describe("expected flips", () => {
  it("marks a flip expected on run B without touching the gates, and unmarks it", async () => {
    const c0 = compareRuns(evals, "run_0040", "run_0041"); const g0 = evaluateGates(c0);
    const flip = c0.flips[0]!;
    expect(flip.transcript).toMatch(new RegExp(`^#/transcripts/run_0041/${flip.task}/\\d+$`));
    const r = await post("/api/compare/expected", { a: "run_0040", b: "run_0041", task: flip.task, note: "prompt change", by: "ulrich" });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const run = JSON.parse(readFileSync(join(evals, "runs", "run_0041.json"), "utf8"));
    expect(run.expected_flips).toEqual([expect.objectContaining({ task: flip.task, change: flip.change, vs: "run_0040", by: "ulrich", note: "prompt change" })]);
    const c1 = compareRuns(evals, "run_0040", "run_0041"); const g1 = evaluateGates(c1);
    expect(c1.flips.find((x) => x.task === flip.task)).toMatchObject({ expected: true, note: "prompt change" });
    expect(g1.passed).toBe(g0.passed);
    expect(c1.suites.map((s) => s.gate_result)).toEqual(c0.suites.map((s) => s.gate_result));
    expect(comparisonMarkdown(c1)).toContain("marked expected by a person");
    expect(comparisonMarkdown(c1)).toContain(`${flip.change} (expected)`);
    // against a different base run the mark does not apply
    expect((await post("/api/compare/expected", { a: "run_0040", b: "run_0041", task: "no_such_task" })).status).toBe(404);
    const off = await post("/api/compare/expected", { a: "run_0040", b: "run_0041", task: flip.task, expected: false });
    expect(off.status).toBe(200);
    expect(JSON.parse(readFileSync(join(evals, "runs", "run_0041.json"), "utf8")).expected_flips).toBeUndefined();
  });
  it("leaves an expected broken regression task out of the verdict sentence", () => {
    const dir = mkdtempSync(join(tmpdir(), "lt-flip-")); const e = join(dir, "evals"); cpSync(EXAMPLE, e, { recursive: true });
    // make one regression task pass every trial in A and fail every trial in B
    const a = JSON.parse(readFileSync(join(e, "runs", "run_0040.json"), "utf8")), b = JSON.parse(readFileSync(join(e, "runs", "run_0041.json"), "utf8"));
    const id = "duplicate_charge_first_time";
    for (const t of a.tasks[id].trials) { t.pass = true; t.infra_error = false; t.failed_checks = []; }
    for (const t of b.tasks[id].trials) { t.pass = false; t.infra_error = false; t.failed_checks = ["tone"]; }
    writeFileSync(join(e, "runs", "run_0040.json"), JSON.stringify(a)); writeFileSync(join(e, "runs", "run_0041.json"), JSON.stringify(b));
    const before = compareRuns(e, "run_0040", "run_0041");
    expect(before.flips.find((x) => x.task === id)?.change).toBe("Broke");
    expect(before.verdict.text).toMatch(/broken task|worse on/);
    b.expected_flips = before.flips.filter((x) => x.change === "Broke" && x.suite === "regression").map((x) => ({ task: x.task, change: "Broke", vs: "run_0040", by: "t", at: "2026-11-11T09:00:00Z" }));
    writeFileSync(join(e, "runs", "run_0041.json"), JSON.stringify(b));
    const after = compareRuns(e, "run_0040", "run_0041");
    expect(after.verdict.text).not.toMatch(/breaks \d+ regression task/);
  });
});

describe("post to PR", () => {
  it("answers with a clear error when there is no pull request or gh cannot post", async () => {
    const r = await post("/api/compare/comment", { a: "run_0040", b: "run_0041" });
    expect([400, 502]).toContain(r.status);
    expect(r.body.message).toBeTruthy();
  });
});
