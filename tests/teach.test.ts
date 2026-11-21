// Teach (docs/stories/redesign.md, R3): the rail's counts, grouping notes by hand from the dashboard and the CLI, and
// Promote's capability default.
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { serve, type Running } from "../packages/cli/src/serve.ts";
import { teachSummary } from "../packages/cli/src/server/teach.ts";

const EXAMPLE = join(import.meta.dirname, "..", "examples", "support-agent", "evals");
const MAIN = join(import.meta.dirname, "..", "packages", "cli", "src", "main.ts");
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" });
const fresh = () => { const repo = mkdtempSync(join(tmpdir(), "lt-teach-")); cpSync(EXAMPLE, join(repo, "evals"), { recursive: true }); writeFileSync(join(repo, ".gitignore"), ".litmustest/\n"); git(repo, "init", "-q", "-b", "main"); git(repo, "add", "-A"); git(repo, "commit", "-q", "-m", "seed"); return repo; };
const mode = (repo: string, name: string) => parseYaml(readFileSync(join(repo, "evals", "failure_modes", `${name}.yaml`), "utf8")) as Record<string, unknown>;

let repo: string, server: Running;
const api = async (path: string, init?: RequestInit) => { const r = await fetch(`${server.url}${path}`, { ...init, headers: { "content-type": "application/json" } }); return { status: r.status, body: (await r.json()) as Record<string, any> } };
const post = (path: string, body: unknown) => api(path, { method: "POST", body: JSON.stringify(body) });
beforeAll(async () => { repo = fresh(); server = await serve({ evalsDir: join(repo, "evals"), port: 0, watch: false }); });
afterAll(async () => { await server?.close(); });

describe("the Teach rail", () => {
  it("counts what each step shows, from the files", () => {
    const t = teachSummary(EXAMPLE) as Record<string, any>;
    expect(t.label).toMatchObject({ done: 18, total: 60 });
    expect(t.modes.named).toBe(7);
    expect(t.judges).toMatchObject({ trusted: 1, total: 2, stale: 1 });
    expect(t.group.notes).toBeGreaterThan(0); expect(t.group.loose).toBe(0);
  });
});

describe("grouping notes by hand", () => {
  it("adds the notes' conversations to a failure mode's examples as one validated, pending write", async () => {
    const before = ((mode(repo, "tone_mismatch").examples as string[]) ?? []).length;
    const r = await post("/api/modes/notes", { mode: "tone_mismatch", traces: ["tr_0300", "tr_0300", "tr_0299"] });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const ex = mode(repo, "tone_mismatch").examples as string[];
    expect(ex.length).toBe(before + 2); expect(ex).toContain("tr_0299");
    expect((await api("/api/pending")).body.files.map((f: { path: string }) => f.path)).toContain("evals/failure_modes/tone_mismatch.yaml");
  });
  it("creates a failure mode with the notes, and refuses a name that exists, a bad name or no notes", async () => {
    const r = await post("/api/modes/notes", { traces: ["tr_0298"], create: { name: "scripted_opener", definition: "Fail when the reply opens with a stock upbeat phrase.", severity: "med" } });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(mode(repo, "scripted_opener")).toMatchObject({ name: "scripted_opener", severity: "med", examples: ["tr_0298"] });
    expect((await post("/api/modes/notes", { traces: ["tr_0298"], create: { name: "scripted_opener", definition: "x" } })).status).toBe(409);
    expect((await post("/api/modes/notes", { mode: "Bad Name", traces: ["tr_0298"] })).status).toBe(400);
    expect((await post("/api/modes/notes", { mode: "tone_mismatch", traces: [] })).status).toBe(400);
  });
  it("lists notes with whether each is tagged", async () => {
    const r = await api("/api/teach/notes");
    expect(r.body.notes.length).toBeGreaterThan(0); expect(r.body.notes[0]).toHaveProperty("tagged");
    expect(r.body.modes.map((m: { name: string }) => m.name)).toContain("tone_mismatch");
  });
  it("litmustest mode add-notes writes the same change from the terminal", () => {
    const other = fresh();
    const r = spawnSync(process.execPath, [MAIN, "mode", "add-notes", "tone_mismatch", "tr_0300", "tr_0299", "--dir", join(other, "evals")], { encoding: "utf8", cwd: other });
    expect(r.status, r.stderr).toBe(0); expect(r.stdout).toMatch(/added 2 notes to tone_mismatch/);
    expect(mode(other, "tone_mismatch").examples).toEqual(mode(repo, "tone_mismatch").examples);
    expect(spawnSync(process.execPath, [MAIN, "mode", "add-notes", "tone_mismatch", "--dir", join(other, "evals")], { encoding: "utf8", cwd: other }).status).toBe(2);
  });
});

describe("Promote", () => {
  it("defaults to the capability suite: the conversation failed, so its reference cannot pass yet", async () => {
    const r = await post("/api/traces/tr_0297/promote", {});
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.suite).toBe("capability");
  });
});
