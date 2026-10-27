// Thin git wrapper. The evals/ directory must live in a git repository: the branch is the write-back target.
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";

export class Git {
  readonly root: string;
  constructor(anyPathInside: string) {
    this.root = run(["rev-parse", "--show-toplevel"], anyPathInside).trim();
  }
  run(args: string[]): string { return run(args, this.root); }
  rel(abs: string): string { const r = resolve(abs); let real = r; try { real = realpathSync(r); } catch { try { real = join(realpathSync(dirname(r)), basename(r)); } catch { /* keep */ } } return relative(this.root, real).split("\\").join("/"); }
  branch(): string { return this.run(["rev-parse", "--abbrev-ref", "HEAD"]).trim(); }
  head(): string { try { return this.run(["rev-parse", "--short", "HEAD"]).trim(); } catch { return ""; } }
  isTracked(rel: string): boolean { try { this.run(["ls-files", "--error-unmatch", "--", rel]); return true; } catch { return false; } }
  status(rel: string): "added" | "modified" | "deleted" | "unchanged" {
    const out = this.run(["status", "--porcelain", "--", rel]).trim();
    if (!out) return "unchanged";
    const code = out.slice(0, 2);
    if (code.includes("D")) return "deleted";
    if (code === "??" || code.includes("A")) return "added";
    return "modified";
  }
  diff(rel: string): string {
    if (!this.isTracked(rel)) return this.run(["diff", "--no-index", "--", "/dev/null", rel]);
    return this.run(["diff", "HEAD", "--", rel]);
  }
  /** Create (or switch to) an evals/<slug> branch unless we are already on one. */
  ensureEvalsBranch(slug: string): string {
    const cur = this.branch();
    if (cur.startsWith("evals/")) return cur;
    const name = `evals/${slug}`;
    const exists = this.run(["branch", "--list", name]).trim() !== "";
    this.run(exists ? ["switch", name] : ["switch", "-c", name]);
    return name;
  }
  commit(rels: string[], message: string): string {
    this.run(["add", "-A", "--", ...rels]);
    this.run(["-c", "user.name=litmustest", "-c", "user.email=litmustest@localhost", "commit", "-q", "-m", message, "--", ...rels]);
    return this.head();
  }
  discard(rels: string[]): void {
    for (const r of rels) {
      const tracked = (() => { try { this.run(["cat-file", "-e", `HEAD:${r}`]); return true; } catch { return false; } })();
      if (tracked) this.run(["checkout", "HEAD", "--", r]);
      else this.run(["clean", "-fq", "--", r]);
    }
  }
}

function run(args: string[], cwd: string): string {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    // `git diff --no-index` exits 1 when files differ; that is the normal case for a new file
    if (args[0] === "diff" && err.status === 1 && err.stdout !== undefined) return err.stdout;
    throw new Error(`git ${args.join(" ")}: ${(err.stderr ?? "").trim() || (e as Error).message}`);
  }
}
