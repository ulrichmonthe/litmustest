// The dashboard has no build step, so nothing else notices a page the router calls but the file no longer defines.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const file = join(import.meta.dirname, "..", "packages", "cli", "ui", "app.js");
const src = readFileSync(file, "utf8");

describe("dashboard script", () => {
  it("parses", () => { execFileSync(process.execPath, ["--check", file]); });
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
