// The dashboard has no build step, so nothing else notices a page the router calls but the file no longer defines.
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const UI = join(import.meta.dirname, "..", "packages", "cli", "ui");
// Every module of the dashboard (every .js under ui/); app.js is the entry.
const files = readdirSync(UI, { recursive: true, encoding: "utf8" }).filter((f) => f.endsWith(".js")).map((f) => join(UI, f));
const src = files.map((f) => readFileSync(f, "utf8")).join("\n");

describe("dashboard script", () => {
  it("parses", () => { for (const f of files) execFileSync(process.execPath, ["--check", f]); });
  it("imports only names its modules export", () => {
    const bad: string[] = [];
    for (const f of files) {
      for (const m of readFileSync(f, "utf8").matchAll(/^import \{ ([^}]+) \} from "([^"]+)";/gm)) {
        const target = readFileSync(join(f, "..", m[2]!), "utf8");
        for (const n of m[1]!.split(",").map((x) => x.trim())) if (!new RegExp(`^export (async )?(function\\*? |const |let )${n.replace("$", "\\$")}(?![\\w$])`, "m").test(target)) bad.push(`${f.slice(UI.length + 1)}: ${n} from ${m[2]}`);
      }
    }
    expect(bad).toEqual([]);
  });
  it("defines every render function it calls", () => {
    const called = new Set([...src.matchAll(/\b(render[A-Z]\w*)\(/g)].map((m) => m[1]));
    const defined = new Set([...src.matchAll(/function\s+(render[A-Z]\w*)\s*\(/g)].map((m) => m[1]));
    expect([...called].filter((n) => !defined.has(n))).toEqual([]);
  });
  it("routes every nav entry to a page", () => {
    const routes = [...src.matchAll(/\["[^"]+", "#\/(\w+)"/g)].map((m) => m[1]);
    for (const r of routes) expect(src, `no case for #/${r}`).toContain(`case "${r}":`);
  });
});
