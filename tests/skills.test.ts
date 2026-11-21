// The skills are Markdown that tells an agent which commands to run, so a renamed flag breaks them silently.
// This checks every `litmustest <command> --flag` they mention against the CLI's own --help.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..");
const SKILLS = join(ROOT, "plugin", "skills");
const UPSTREAM = ["evals-start", "eval-audit", "error-discovery", "generate-synthetic-data", "write-code-eval", "write-judge-prompt", "validate-evaluator", "evaluate-rag", "build-review-interface"];
const NEW = ["define-task", "build-environment", "triage-failures", "analyze-run", "graduate-suite"];

const help = execFileSync(process.execPath, [join(ROOT, "packages", "cli", "src", "main.ts"), "--help"], { encoding: "utf8" });
// Each usage line is "  litmustest <command> [flags...]"; the flags on that line are the command's flags.
const usage = new Map<string, Set<string>>();
// A command can have more than one usage line (explain <term> and explain [--run]); its flags are the union.
for (const m of help.matchAll(/^ {2}litmustest ([a-z-]+)(.*)$/gm)) usage.set(m[1], new Set([...(usage.get(m[1]) ?? []), ...[...m[2].matchAll(/--[a-z-]+/g)].map((f) => f[0])]));
const GLOBAL = new Set(["--help", "--version"]);

const skills = readdirSync(SKILLS, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
const text = (name: string) => readFileSync(join(SKILLS, name, "SKILL.md"), "utf8");

// Codex resolves a local plugin's source.path against the marketplace root (the directory that holds .agents/), wants it
// to start with ./ and stay inside that root, and reads skills from the path the manifest declares (docs/CODEX.md).
// Not a test of Codex itself, which is not installed here: only that the files agree with each other and the docs' rules.
describe("Codex manifests (untested on Codex)", () => {
  const market = JSON.parse(readFileSync(join(ROOT, ".agents", "plugins", "marketplace.json"), "utf8"));
  const manifest = JSON.parse(readFileSync(join(ROOT, "plugin", ".codex-plugin", "plugin.json"), "utf8"));
  it("the marketplace sits at the repo root and its path reaches the plugin", () => {
    expect(existsSync(join(ROOT, "plugin", ".agents"))).toBe(false);
    const entry = market.plugins[0]; const path: string = entry.source.path;
    expect(path.startsWith("./")).toBe(true); expect(path.split("/")).not.toContain("..");
    expect(existsSync(join(ROOT, path, ".codex-plugin", "plugin.json"))).toBe(true);
    expect(entry.name).toBe(manifest.name);
    expect(["AVAILABLE", "INSTALLED_BY_DEFAULT", "NOT_AVAILABLE"]).toContain(entry.policy.installation);
    expect(["ON_INSTALL", "ON_USE"]).toContain(entry.policy.authentication);
    expect(entry.category).toBeTruthy();
  });
  it("the manifest declares the skills directory and the listing fields within their limits", () => {
    expect(manifest.name).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/); expect(manifest.version).toBeTruthy(); expect(manifest.author.name).toBeTruthy();
    expect(manifest.skills.startsWith("./")).toBe(true);
    expect(readdirSync(join(ROOT, "plugin", manifest.skills)).sort()).toEqual(skills);
    const i = manifest.interface;
    expect(i.displayName.length).toBeLessThanOrEqual(30); expect(i.shortDescription.length).toBeLessThanOrEqual(30); expect(i.longDescription.length).toBeLessThanOrEqual(4000); expect(i.developerName.length).toBeLessThanOrEqual(80);
    expect(i.category).toBeTruthy(); expect(i.capabilities).toEqual([]);
  });
  it("still says untested", () => { expect(manifest.description).toMatch(/UNTESTED on Codex/); expect(manifest.interface.longDescription).toMatch(/Untested on Codex/); });
  it.each(skills)("%s has a name Codex accepts (64 characters at most)", (name) => { expect(name.length).toBeLessThanOrEqual(64); });
});

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

  // Rule 2: reading traces and labelling are human-only. The CLI has `label` and `dispute` so a person can do from a
  // terminal what the review queue does; no skill may tell an agent to run them.
  it.each(skills)("%s never tells an agent to label or dispute", (name) => {
    expect(text(name)).not.toMatch(/litmustest\s+(label|dispute)\b/);
  });
});
