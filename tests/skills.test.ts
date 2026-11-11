// The skills are Markdown that tells an agent which commands to run, so a renamed flag breaks them silently.
// This checks every `litmustest <command> --flag` they mention against the CLI's own --help.
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..");
const SKILLS = join(ROOT, "plugin", "skills");
const UPSTREAM = ["evals-start", "eval-audit", "error-discovery", "generate-synthetic-data", "write-code-eval", "write-judge-prompt", "validate-evaluator", "evaluate-rag", "build-review-interface"];
const NEW = ["define-task", "build-environment", "triage-failures", "analyze-run", "graduate-suite"];

const help = execFileSync(process.execPath, [join(ROOT, "packages", "cli", "src", "main.ts"), "--help"], { encoding: "utf8" });
// Each usage line is "  litmustest <command> [flags...]"; the flags on that line are the command's flags.
const usage = new Map<string, Set<string>>();
for (const m of help.matchAll(/^ {2}litmustest ([a-z-]+)(.*)$/gm)) usage.set(m[1], new Set([...m[2].matchAll(/--[a-z-]+/g)].map((f) => f[0])));
const GLOBAL = new Set(["--help", "--version"]);

const skills = readdirSync(SKILLS, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
const text = (name: string) => readFileSync(join(SKILLS, name, "SKILL.md"), "utf8");

describe("plugin skills", () => {
  it("ships the fourteen skills of the spec", () => { expect(skills).toEqual([...UPSTREAM, ...NEW].sort()); });

  it.each(skills)("%s has frontmatter naming it", (name) => {
    const fm = /^---\n([\s\S]*?)\n---\n/.exec(text(name))?.[1] ?? "";
    expect(fm).toMatch(new RegExp(`^name: ${name}$`, "m"));
    expect(fm).toMatch(/^description: .{40,}/m);
  });

  it.each(UPSTREAM)("%s carries the Apache attribution", (name) => { expect(text(name)).toContain("Modified from ai-evals-course/evals-skills (Apache 2.0)"); });
  it.each(NEW)("%s is ours and carries none", (name) => { expect(text(name)).not.toContain("Modified from ai-evals-course"); });

  it.each(skills)("%s only uses commands and flags the CLI has", (name) => {
    const wrong: string[] = [];
    // Only code is a command: fenced blocks and inline spans. Prose says "the litmustest runner".
    const md = text(name); const code = [...md.matchAll(/```[a-z]*\n([\s\S]*?)```/g)].map((m) => m[1]).join("\n") + "\n" + [...md.replace(/```[\s\S]*?```/g, "").matchAll(/`([^`\n]+)`/g)].map((m) => m[1]).join("\n");
    // A command runs to the end of its line; a pipe or && starts another command.
    for (const m of code.matchAll(/(?:^|[\s(])litmustest ([a-z][a-z-]*)([^\n|&]*)/gm)) {
      const flags = usage.get(m[1]);
      if (!flags) { wrong.push(`litmustest ${m[1]}`); continue; }
      for (const f of m[2].matchAll(/--[a-z][a-z-]*/g)) if (!flags.has(f[0]) && !GLOBAL.has(f[0])) wrong.push(`litmustest ${m[1]} ${f[0]}`);
    }
    expect([...new Set(wrong)]).toEqual([]);
  });
});
