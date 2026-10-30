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

// The explainer (docs/EXPLAINER.md): every header, stat label and pill on the screens is either a glossary term or a plain word on this list.
const PLAIN = new Set(["a", "b", "a → b", "actual", "agent", "change", "customer", "expected", "fail", "failed", "failing", "passing", "pass", "high", "med", "low", "human", "item", "last runs", "model", "mode", "none", "path", "source", "status", "suite health", "tool", "trend", "used by", "why", "what happened", "what it tests", "what this means", "to make it pass", "judge's critique", "covered by", "has check", "measured", "not measured in v1", "needs labels", "failing check in b", "no grader", "only a judge failed it", "mixed", "high severity", "review queue", "dev tpr / tnr", "test tpr / tnr", "checks"]);
const ALSO: Record<string, string> = { broke: "flip", fixed: "flip", significant: "confidence_interval", "within noise": "confidence_interval" };
const ROUTES_ALL = ["overview", "review", "modes", "tasks", "compare", "transcripts", "judges", "judges/tone_mismatch", "coverage", "settings", "pending"];
/** Pills that are not status words: the explain card's own kind label and the AI pill. */
const NOT_STATUS = /^(AI|Claude|Sample data)/i;

describe("explainer, Epic 2 (docs/stories/explainer.md)", () => {
  let s: Running; let names: Set<string>; let shorts: Map<string, string>;
  beforeAll(async () => {
    if (!browser) return;
    const cwd = repo((c) => cpSync(EXAMPLE, join(c, "evals"), { recursive: true }));
    s = await serve({ evalsDir: join(cwd, "evals"), port: 0, watch: false }); servers.push(s);
    const g = (await (await fetch(`${s.url}/api/glossary`)).json()) as { terms: { id: string; term: string; short: string; aliases?: string[] }[] };
    names = new Set(g.terms.flatMap((t) => [t.id, t.term, ...(t.aliases ?? [])].map((x) => x.toLowerCase())));
    shorts = new Map(g.terms.map((t) => [t.id, t.short.replace(/\[\[(\w+)\]\]/g, (_, id) => g.terms.find((x) => x.id === id)!.term.toLowerCase())]));
  });
  const open = async (route: string, opts: Parameters<Browser["newPage"]>[0] = {}) => {
    const page = await browser!.newPage(opts); await page.goto(`${s.url}/#/${route}`);
    await page.waitForFunction(() => !/Loading…/.test(document.querySelector("#page")?.textContent ?? "") && document.querySelector("#page h1"));
    await page.waitForTimeout(200); return page;
  };

  it("E2-S1: terms are dotted line-strong, words underline once per screen, values and pills are triggers, no ? icons", async (ctx) => {
    if (!browser) return ctx.skip();
    const problems: string[] = [];
    for (const r of ROUTES_ALL) {
      const page = await open(r);
      const res = await page.evaluate((notStatus) => {
        const out: string[] = [];
        const lineStrong = getComputedStyle(document.documentElement).getPropertyValue("--line-strong").trim();
        for (const t of document.querySelectorAll("#page .term")) {
          const cs = getComputedStyle(t); if (!cs.textDecorationStyle.includes("dotted")) out.push(`not dotted: ${t.textContent}`);
          const probe = document.createElement("span"); probe.style.color = lineStrong; document.body.append(probe); const want = getComputedStyle(probe).color; probe.remove();
          if (cs.textDecorationColor !== want) out.push(`underline is ${cs.textDecorationColor}, not line-strong: ${t.textContent}`);
        }
        const words = [...document.querySelectorAll('#page .term[data-kind="word"]')].map((t) => (t as HTMLElement).dataset.term);
        for (const w of new Set(words)) if (words.filter((x) => x === w).length > 1) out.push(`word "${w}" underlined more than once`);
        for (const p of document.querySelectorAll("#page .pill")) if (!p.closest(".term, button, a") && !new RegExp(notStatus, "i").test(p.textContent ?? "")) out.push(`pill is not a trigger: ${p.textContent}`);
        for (const v of document.querySelectorAll("#page .big .n, #page .stats > div > span:last-child, #page .kpis > div > span:nth-child(2)")) if (/\d/.test(v.textContent ?? "") && !v.querySelector(".term") && !v.closest(".term")) out.push(`number is not a trigger: ${v.textContent}`);
        if (document.querySelector(".qhelp")) out.push("a ? button is still there");
        for (const el of document.querySelectorAll("#page button, #page span")) if (el.textContent?.trim() === "?") out.push("a ? icon is still there");
        return out;
      }, NOT_STATUS.source);
      problems.push(...res.map((x) => `${r}: ${x}`)); await page.close();
    }
    expect([...new Set(problems)]).toEqual([]);
  }, 120_000);

  it("E2-S2: hover 400ms or focus peeks the short definition, one or two lines, no controls, described by", async (ctx) => {
    if (!browser) return ctx.skip();
    const page = await open("judges/tone_mismatch", { viewport: { width: 1280, height: 900 } });
    const t = page.locator('#page .term[data-term="tpr"]').first();
    await t.hover(); await page.waitForTimeout(250);
    expect(await page.$("#gloss-peek")).toBeNull(); // not before 400ms
    await page.waitForTimeout(300);
    const peek = page.locator("#gloss-peek");
    expect(await peek.textContent()).toBe(`${shorts.get("tpr")} Click for more`);
    expect(await peek.locator("a, button").count()).toBe(0);
    const [pb, tb] = [await peek.boundingBox(), await t.boundingBox()];
    expect(pb!.height).toBeLessThanOrEqual(2 * 16 + 8); // two lines at most
    expect(pb!.y).toBeGreaterThanOrEqual(tb!.y + tb!.height); // under the term, never over it
    await page.mouse.move(5, 5); await page.waitForTimeout(50);
    expect(await page.$("#gloss-peek")).toBeNull(); // closes when the pointer leaves
    const id = await t.getAttribute("aria-describedby");
    expect(await page.textContent(`#${id}`)).toBe(shorts.get("tpr"));
    // keyboard focus peeks; moving focus closes it
    await page.keyboard.press("Tab"); for (let i = 0; i < 80 && !(await page.evaluate(() => document.activeElement?.classList.contains("term"))); i++) await page.keyboard.press("Tab");
    await page.waitForSelector("#gloss-peek");
    await page.keyboard.press("Tab"); await page.waitForTimeout(50);
    if (!(await page.evaluate(() => document.activeElement?.classList.contains("term")))) expect(await page.$("#gloss-peek")).toBeNull();
    // click opens the full explanation; Escape closes it and returns focus
    const v = page.locator('#page .term[data-term="tpr"][data-kind="value"]').first();
    await v.click(); await page.waitForSelector("#gloss-pop .here:not(.muted)");
    expect(await page.textContent("#gloss-pop .here")).toMatch(/tone_mismatch judge caught \d+ of \d+/);
    expect(await page.$("#gloss-peek")).toBeNull();
    await page.keyboard.press("Escape"); expect(await page.$("#gloss-pop")).toBeNull();
    expect(await page.evaluate(() => (document.activeElement as HTMLElement)?.dataset.term)).toBe("tpr");
    await page.close();
  }, 60_000);

  it("E2-S2: on touch there is no peek; a tap opens the explanation", async (ctx) => {
    if (!browser) return ctx.skip();
    const page = await open("judges/tone_mismatch", { hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });
    await page.locator('#page .term[data-term="tpr"]').first().tap(); await page.waitForTimeout(600);
    expect(await page.$("#gloss-peek")).toBeNull();
    expect(await page.$("#gloss-pop")).not.toBeNull();
    await page.close();
  }, 60_000);

  it("every header, stat label and pill is a glossary term or a plain word", async (ctx) => {
    if (!browser) return ctx.skip();
    const undefinedWords = new Set<string>();
    for (const r of ROUTES_ALL) {
      const page = await open(r);
      for (const raw of await page.$$eval("#page th, #page .stats > div > span:first-child, #page .pareto-head span, #page .pill, #page .kpis > div > span:first-child, #page .eyebrow", (els) => els.map((e) => e.textContent ?? ""))) {
        const first = raw.split(" · ")[0]!.trim();
        if (!first || /^[\w-]+:/.test(first) || /^vs /.test(first)) continue;
        const w = first.replace(/pass\^\d+/i, "pass^k").replace(/(^|\s)\d+(?=\s|$)/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
        const one = w.replace(/s$/, "");
        if (!w || PLAIN.has(w) || PLAIN.has(one) || ALSO[w] || names.has(w) || names.has(one)) continue;
        undefinedWords.add(`${r}: "${first}"`);
      }
      await page.close();
    }
    expect([...undefinedWords]).toEqual([]);
  }, 120_000);
});
