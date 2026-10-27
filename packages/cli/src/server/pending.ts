// The Pending changes set: files the server has written since the last commit or discard.
// Persisted under .litmustest/pending.json so a restart keeps the tray. Diffs come from git.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Git } from "./git.ts";

export interface PendingFile { path: string; status: "added" | "modified" | "deleted" | "unchanged"; diff: string; affected_views: string[]; written_at: string }
export interface PendingState { branch: string; files: PendingFile[] }

export const VIEWS_FOR = (rel: string): string[] => {
  const p = rel.replace(/^.*?evals\//, "");
  if (p === "litmustest.yaml") return ["Settings"];
  if (p.startsWith("failure_modes/")) return ["Failure modes", "Review queue", "Overview"];
  if (p.startsWith("graders/judges/")) return ["Judges", "Tasks & suites"];
  if (p.startsWith("graders/code/")) return ["Tasks & suites"];
  if (p.startsWith("tasks/") || p.startsWith("refs/") || p.startsWith("suites/")) return ["Tasks & suites", "Overview"];
  if (p.startsWith("labels/")) return ["Review queue", "Judges"];
  if (p.startsWith("batches/") || p.startsWith("datasets/")) return ["Review queue"];
  if (p.startsWith("runs/")) return ["Overview", "Run compare"];
  return [];
};

export class Pending {
  private file: string;
  private git: Git;
  private evalsDir: string;
  private written = new Map<string, string>(); // repo-relative path -> written_at
  constructor(git: Git, evalsDir: string) {
    this.git = git; this.evalsDir = evalsDir;
    this.file = join(evalsDir, "..", ".litmustest", "pending.json");
    if (existsSync(this.file)) {
      try { for (const [k, v] of Object.entries(JSON.parse(readFileSync(this.file, "utf8")) as Record<string, string>)) this.written.set(k, v); } catch { /* start empty */ }
    }
  }
  private save(): void { mkdirSync(dirname(this.file), { recursive: true }); writeFileSync(this.file, JSON.stringify(Object.fromEntries(this.written), null, 2)); }
  track(abs: string): void { this.written.set(this.git.rel(abs), new Date().toISOString()); this.save(); }
  paths(): string[] { return [...this.written.keys()]; }
  /** Every uncommitted change under evals/: what the server wrote, plus what a skill or an editor changed on disk. */
  state(): PendingState {
    const files: PendingFile[] = [];
    const evalsRel = this.git.rel(this.evalsDir);
    const changed = new Map<string, "added" | "modified" | "deleted">();
    for (const line of this.git.run(["status", "--porcelain", "--untracked-files=all", "--", evalsRel]).split("\n")) {
      if (!line.trim()) continue;
      const code = line.slice(0, 2); const rel = line.slice(3).trim().replace(/^"|"$/g, "");
      changed.set(rel, code.includes("D") ? "deleted" : code === "??" || code.includes("A") ? "added" : "modified");
    }
    for (const rel of this.written.keys()) if (!changed.has(rel)) this.written.delete(rel); // reverted or committed outside the server
    for (const [rel, status] of changed) {
      let diff = "";
      try { diff = status === "deleted" ? this.git.run(["diff", "HEAD", "--", rel]) : this.git.diff(rel); } catch { diff = ""; }
      files.push({ path: rel, status, diff, affected_views: VIEWS_FOR(rel), written_at: this.written.get(rel) ?? "" });
    }
    this.save();
    return { branch: this.git.branch(), files: files.sort((a, b) => a.path.localeCompare(b.path)) };
  }
  clear(rels?: string[]): void { if (!rels) this.written.clear(); else for (const r of rels) this.written.delete(r); this.save(); }
}
