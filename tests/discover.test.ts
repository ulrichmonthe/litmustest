import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { initEvals } from "../packages/cli/src/init.ts";
import { ingest } from "../packages/cli/src/ingest.ts";
import { discover, gatherNotes, parseJson, type Ask } from "../packages/cli/src/discover.ts";
import { serve, type Running } from "../packages/cli/src/serve.ts";

const EXAMPLE_JSONL = join(import.meta.dirname, "..", "examples", "support-agent", "traces", "support.jsonl");
const git = (cwd: string, ...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd, encoding: "utf8" }).trim();

let cwd: string; let ids: string[]; let run: Running;
const fakeAsk: Ask = async (system, user) => {
  expect(system).toContain("snake_case");
  expect(user).toContain("Reviewer notes");
  return "```json\n" + JSON.stringify({ modes: [
    { action: "create", name: "ungrounded_policy", definition: "The agent states a policy fact without fetching the policy. Fail on any unbacked policy claim; Pass when every claim follows a fetch_policy result.", severity: "high", owner: "support-quality", examples: [ids[0], "tr_not_in_notes"], rationale: "Two notes mention a refund window that was never fetched." },
    { action: "update", name: "tone_mismatch", definition: "The agent's register does not match the customer. Fail on breezy replies to frustrated customers; Pass when the tone fits.", severity: "med", examples: [ids[1]], rationale: "The note on the second trace is about tone." },
    { action: "keep", name: "missed_refund" },
    { action: "create", name: "Bad Name", definition: "short", severity: "critical", examples: [], rationale: "should be dropped by the schema" },
  ], unassigned: [ids[2]] }) + "\n```";
};

beforeAll(async () => {
  cwd = mkdtempSync(join(tmpdir(), "litmustest-disc-"));
  git(cwd, "init", "-q", "-b", "main");
  initEvals({ cwd, source: EXAMPLE_JSONL });
  ingest({ cwd, evalsDir: "evals", source: EXAMPLE_JSONL, size: 6, clusters: 2, batch: "b1", now: new Date("2026-10-27T10:00:00Z") });
  const batch = readFileSync(join(cwd, "evals", "batches", "b1.yaml"), "utf8");
  ids = [...batch.matchAll(/trace_id: (tr_\d+)/g)].map((m) => m[1]!);
  writeFileSync(join(cwd, "evals", "failure_modes", "tone_mismatch.yaml"), "name: tone_mismatch\ndefinition: Old definition of tone mismatch that will be updated by discover.\nseverity: low\ncreated: 2026-10-20\n");
  writeFileSync(join(cwd, "evals", "failure_modes", "missed_refund.yaml"), "name: missed_refund\ndefinition: Refund owed and never processed before the conversation ended.\nseverity: high\ncreated: 2026-10-20\n");
  writeFileSync(join(cwd, "evals", "labels", "b1.jsonl"), [
    { trace_id: ids[0], failure_mode: "overall", label: "Fail", note: "Quoted a 60 day refund window with no policy lookup.", annotator: "u", at: "2026-10-27T10:00:00Z" },
    { trace_id: ids[1], failure_mode: "overall", label: "Fail", note: "No worries!! to a furious customer.", annotator: "u", at: "2026-10-27T10:01:00Z" },
    { trace_id: ids[2], failure_mode: "overall", label: "Fail", note: "Not sure, something off.", annotator: "u", at: "2026-10-27T10:02:00Z" },
    { trace_id: ids[3], failure_mode: "overall", label: "Pass", annotator: "u", at: "2026-10-27T10:03:00Z" },
    { trace_id: ids[4], failure_mode: "overall", label: "Skip", note: "skipped", annotator: "u", at: "2026-10-27T10:04:00Z" },
  ].map((l) => JSON.stringify(l)).join("\n") + "\n");
  writeFileSync(join(cwd, ".gitignore"), ".litmustest/\n");
  git(cwd, "add", "-A"); git(cwd, "commit", "-q", "-m", "seed");
  run = await serve({ evalsDir: join(cwd, "evals"), port: 0, watch: false, ask: fakeAsk });
});
afterAll(async () => { await run.close(); });

describe("gatherNotes", () => {
  it("collects Fail and Pass notes with excerpts, skipping Skip and note-less labels", () => {
    const { notes, existing } = gatherNotes(join(cwd, "evals"));
    expect(notes.map((n) => n.trace_id)).toEqual([ids[0], ids[1], ids[2]]);
    expect(notes[0]!.excerpt).toContain("customer:");
    expect(existing.map((m) => m.name).sort()).toEqual(["missed_refund", "tone_mismatch"]);
  });
  it("parses JSON with or without fences", () => {
    expect(parseJson('{"a":1}')).toEqual({ a: 1 });
    expect(parseJson("```json\n{\"a\":1}\n```")).toEqual({ a: 1 });
    expect(parseJson("Here you go: {\"a\":1} thanks")).toEqual({ a: 1 });
    expect(() => parseJson("nope")).toThrow();
  });
});

describe("discover", () => {
  it("turns the model's grouping into validated file proposals with diffs, writing nothing", async () => {
    const r = await discover({ evalsDir: join(cwd, "evals"), ask: fakeAsk });
    expect(r.notes_used).toBe(3);
    expect(r.proposals.map((p) => [p.action, p.name])).toEqual([["create", "ungrounded_policy"], ["update", "tone_mismatch"]]);
    const created = r.proposals[0]!;
    expect(created.path).toBe("failure_modes/ungrounded_policy.yaml");
    expect(created.examples).toEqual([ids[0]]); // the id that is not in the notes was dropped
    expect(created.content).toContain("created: ");
    expect(created.diff).toContain("+name: ungrounded_policy");
    const updated = r.proposals[1]!;
    expect(updated.diff).toContain("-severity: low"); expect(updated.diff).toContain("+severity: med");
    expect(updated.content).toContain("created: 2026-10-20");
    expect(r.unassigned).toEqual([ids[2]]);
    expect(existsSync(join(cwd, "evals", "failure_modes", "ungrounded_policy.yaml"))).toBe(false);
    expect(git(cwd, "status", "--porcelain")).toBe("");
  });
  it("refuses when there are no notes", async () => {
    const empty = mkdtempSync(join(tmpdir(), "litmustest-empty-"));
    git(empty, "init", "-q"); initEvals({ cwd: empty });
    await expect(discover({ evalsDir: join(empty, "evals"), ask: fakeAsk })).rejects.toThrow(/no notes/);
  });
});

describe("POST /api/discover and accept", () => {
  const api = async (path: string, init?: RequestInit) => { const r = await fetch(run.url + path, { ...init, headers: { "content-type": "application/json" } }); return { status: r.status, body: await r.json() }; };
  it("returns proposals without writing, then accepted files land in the tray", async () => {
    const r = await api("/api/discover", { method: "POST", body: JSON.stringify({ batch: "b1" }) });
    expect(r.status).toBe(200); expect(r.body.proposals.length).toBe(2);
    expect((await api("/api/pending")).body.files).toEqual([]);
    for (const p of r.body.proposals) expect((await api("/api/file", { method: "PUT", body: JSON.stringify({ path: p.path, content: p.content }) })).status).toBe(200);
    const pending = (await api("/api/pending")).body;
    expect(pending.files.map((f: { path: string; status: string }) => [f.path.replace(/^.*evals\//, ""), f.status])).toEqual([["failure_modes/tone_mismatch.yaml", "modified"], ["failure_modes/ungrounded_policy.yaml", "added"]]);
  });
  it("the tray also shows a change made on disk by a skill, and discard removes it", async () => {
    mkdirSync(join(cwd, "evals", "failure_modes"), { recursive: true });
    writeFileSync(join(cwd, "evals", "failure_modes", "over_searching.yaml"), "name: over_searching\ndefinition: Repeats a lookup with trivially different arguments instead of using the first result.\nseverity: low\ncreated: 2026-10-27\n");
    const pending = (await api("/api/pending")).body;
    expect(pending.files.some((f: { path: string; status: string }) => f.path.endsWith("over_searching.yaml") && f.status === "added")).toBe(true);
    const d = await api("/api/pending/discard", { method: "POST", body: JSON.stringify({ paths: ["failure_modes/over_searching.yaml"] }) });
    expect(d.status).toBe(200);
    expect(existsSync(join(cwd, "evals", "failure_modes", "over_searching.yaml"))).toBe(false);
    expect((await api("/api/pending")).body.files.length).toBe(2);
  });
});
