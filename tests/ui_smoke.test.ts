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

// The explainer (docs/EXPLAINER.md): popovers open on click and focus, close on Escape with focus returned,
// and every header, stat label and pill on the screens is either a glossary term or a plain word on this list.
const PLAIN = new Set(["a", "b", "a → b", "actual", "agent", "change", "customer", "expected", "fail", "failed", "failing", "passing", "pass", "high", "med", "low", "human", "item", "last runs", "model", "mode", "none", "path", "source", "status", "suite health", "tool", "trend", "used by", "why", "what happened", "what it tests", "what this means", "to make it pass", "judge's critique", "covered by", "has check", "measured", "not measured in v1", "needs labels", "failing check in b", "no grader", "only a judge failed it", "mixed", "high severity", "review queue", "dev tpr / tnr", "test tpr / tnr", "change", "checks"]);
const ALSO: Record<string, string> = { broke: "flip", fixed: "flip", significant: "confidence_interval", "within noise": "confidence_interval" };

describe("explainer in the browser", () => {
  it("opens on click and focus, closes on Escape, and every label on the screens is defined", async (ctx) => {
    if (!browser) return ctx.skip();
    const cwd = repo((c) => cpSync(EXAMPLE, join(c, "evals"), { recursive: true }));
    const s = await serve({ evalsDir: join(cwd, "evals"), port: 0, watch: false }); servers.push(s);
    const names = new Set(((await (await fetch(`${s.url}/api/glossary`)).json()) as { terms: { id: string; term: string; aliases?: string[] }[] }).terms.flatMap((t) => [t.id, t.term, ...(t.aliases ?? [])].map((x) => x.toLowerCase())));
    const page = await browser!.newPage();

    await page.goto(`${s.url}/#/judges/tone_mismatch`); await page.waitForSelector("button.qhelp");
    const label = await page.getAttribute("button.qhelp", "aria-label");
    await page.click("button.qhelp");
    await page.waitForSelector("#gloss-pop .here:not(.muted)");
    expect(await page.textContent("#gloss-pop")).toMatch(/tone_mismatch/);
    await page.keyboard.press("Escape");
    expect(await page.$("#gloss-pop")).toBeNull();
    expect(await page.evaluate(() => document.activeElement?.getAttribute("aria-label"))).toBe(label);
    await page.focus(".term"); await page.waitForSelector("#gloss-pop");

    await page.goto(`${s.url}/#/overview`); await page.waitForSelector(".plain-line:not(:empty)");
    for (const t of await page.$$eval(".plain-line", (els) => els.map((e) => e.textContent ?? ""))) expect(t).not.toMatch(/\[object|undefined|null|NaN/);

    const undefinedWords = new Set<string>();
    for (const r of ["overview", "review", "modes", "tasks", "compare", "transcripts", "judges", "judges/tone_mismatch", "coverage", "settings", "pending"]) {
      await page.goto(`${s.url}/#/${r}`); await page.waitForFunction(() => !/Loading…/.test(document.querySelector("#page")?.textContent ?? ""));
      await page.waitForTimeout(150);
      for (const raw of await page.$$eval("#page th, #page .stats > div > span:first-child, #page .pareto-head span, #page .pill, #page .kpis > div > span:first-child, #page .eyebrow", (els) => els.map((e) => e.textContent ?? ""))) {
        const first = raw.replace(/\?/g, "").split(" · ")[0]!.trim();
        if (!first || /^[\w-]+:/.test(first) || /^vs /.test(first)) continue;
        const w = first.replace(/pass\^\d+/i, "pass^k").replace(/(^|\s)\d+(?=\s|$)/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
        const one = w.replace(/s$/, "");
        if (!w || PLAIN.has(w) || PLAIN.has(one) || ALSO[w] || names.has(w) || names.has(one)) continue;
        undefinedWords.add(`${r}: "${first}"`);
      }
    }
    expect([...undefinedWords]).toEqual([]);
    await page.close();
  }, 90_000);
});
