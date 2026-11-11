// Loads every dashboard route in a real browser and fails on a script error, a page that never renders, or a control under 44px.
// Uses the installed Chrome through playwright-core (no browser download); skipped where no Chrome is found.
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { initEvals } from "../packages/cli/src/init.ts";
import { serve, type Running } from "../packages/cli/src/serve.ts";

const EXAMPLE = join(import.meta.dirname, "..", "examples", "support-agent", "evals");
const git = (cwd: string, ...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd, encoding: "utf8" });
const ROUTES = ["overview", "review", "modes", "tasks", "compare", "transcripts", "judges", "coverage", "settings", "pending"];

function repo(fill: (cwd: string) => void): string {
  const cwd = mkdtempSync(join(tmpdir(), "litmustest-ui-"));
  git(cwd, "init", "-q", "-b", "main"); fill(cwd);
  writeFileSync(join(cwd, ".gitignore"), ".litmustest/\n");
  git(cwd, "add", "-A"); git(cwd, "commit", "-q", "-m", "seed");
  return cwd;
}

let browser: Browser | undefined;
const servers: Running[] = [];
beforeAll(async () => {
  try { browser = await chromium.launch({ channel: "chrome" }); }
  catch (e) { if (process.env.CI) throw e; browser = undefined; } // GitHub's runners have Chrome; never skip there.
});
afterAll(async () => { await browser?.close(); for (const s of servers) await s.close(); });

async function visit(url: string, hashes: string[]): Promise<Record<string, string[]>> {
  const page = await browser!.newPage(); const problems: Record<string, string[]> = {}; let current = "";
  const note = (m: string) => { (problems[current] ??= []).push(m); };
  page.on("pageerror", (e) => note(e.message));
  // Fonts come from Google; an offline runner failing to fetch them is not a dashboard bug.
  page.on("console", (m) => { if (m.type() === "error" && !/fonts\.(googleapis|gstatic)/.test(m.location().url + m.text())) note(m.text()); });
  page.on("response", (r) => { if (r.url().includes("/api/") && r.status() >= 500) note(`${r.status()} ${new URL(r.url()).pathname}`); });
  for (const h of hashes) {
    current = h;
    await page.goto(`${url}/#/${h}`);
    try { await page.waitForFunction(() => { const p = document.querySelector("#page"); return p && !/Loading…/.test(p.textContent ?? "") && p.querySelector("h1"); }, null, { timeout: 5000 }); }
    catch { note(`never rendered: ${(await page.textContent("#page"))?.slice(0, 120)}`); continue; }
    // The router catches a throwing page and shows an error page with its own heading.
    const title = (await page.textContent("#page h1"))?.trim() ?? "";
    if (/Something went wrong|Cannot reach|not found/i.test(title)) note(`${title}: ${(await page.textContent("#page .empty"))?.slice(0, 160)}`);
    // BRAND.md: every control is at least 44px tall. Links inside running text are exempt; a checkbox's target is its label.
    for (const c of await page.evaluate(() => [...document.querySelectorAll("#page button, #page a[href], #page select, #page input, #page textarea, nav a")].filter((el) => !el.closest("p, .banner")).map((el) => (el as HTMLInputElement).type === "checkbox" && el.closest("label") ? el.closest("label")! : el).map((el) => ({ h: el.getBoundingClientRect().height, w: el.getBoundingClientRect().width, t: (el.textContent || el.getAttribute("aria-label") || el.tagName).trim().slice(0, 30) })).filter((b) => b.w > 0 && b.h > 0 && b.h < 43.5))) note(`control under 44px: "${c.t}" ${Math.round(c.h)}px`);
  }
  await page.close();
  return problems;
}

describe("dashboard smoke", () => {
  it("renders every route on the example", async (ctx) => {
    if (!browser) return ctx.skip();
    const cwd = repo((c) => cpSync(EXAMPLE, join(c, "evals"), { recursive: true }));
    const s = await serve({ evalsDir: join(cwd, "evals"), port: 0, watch: false }); servers.push(s);
    const t = (await (await fetch(`${s.url}/api/transcripts`)).json()) as { run: { run_id: string }; tasks: { id: string; suite: string }[] };
    const task = t.tasks[0];
    const deep = [`tasks/${task.suite}/${task.id}`, `transcripts/${t.run.run_id}/${task.id}/1`, "judges/tone_mismatch", "modes/tone_mismatch"];
    expect(await visit(s.url, [...ROUTES, ...deep])).toEqual({});
  }, 60_000);

  it("renders every route on a fresh init", async (ctx) => {
    if (!browser) return ctx.skip();
    const cwd = repo((c) => initEvals({ cwd: c }));
    const s = await serve({ evalsDir: join(cwd, "evals"), port: 0, watch: false }); servers.push(s);
    expect(await visit(s.url, ROUTES)).toEqual({});
  }, 60_000);
});
