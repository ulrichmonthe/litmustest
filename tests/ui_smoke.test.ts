// Loads every dashboard route in a real browser and fails on a script error, a page that never renders, or a control under 44px.
// Uses the installed Chrome through playwright-core (no browser download); skipped where no Chrome is found.
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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

// Preferences go to $XDG_CONFIG_HOME/litmustest/prefs.json; tests must never touch the person's real one.
process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "litmustest-xdg-"));

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
    await v.click(); await page.waitForFunction(() => /What it means here/.test(document.querySelector("#explain-panel")?.textContent ?? ""));
    expect(await page.textContent("#explain-panel")).toMatch(/tone_mismatch judge caught \d+ of \d+/);
    expect(await page.$("#gloss-peek")).toBeNull();
    await page.keyboard.press("Escape"); expect(await page.isHidden("#explain-panel")).toBe(true);
    expect(await page.evaluate(() => (document.activeElement as HTMLElement)?.dataset.term)).toBe("tpr");
    await page.close();
  }, 60_000);

  it("E2-S2: on touch there is no peek; a tap opens the explanation", async (ctx) => {
    if (!browser) return ctx.skip();
    const page = await open("judges/tone_mismatch", { hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });
    await page.locator('#page .term[data-term="tpr"]').first().tap(); await page.waitForTimeout(600);
    expect(await page.$("#gloss-peek")).toBeNull();
    expect(await page.isVisible("#explain-panel")).toBe(true);
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

describe("explainer, Epic 3 (docs/stories/explainer.md)", () => {
  let s: Running; let cwd: string;
  beforeAll(async () => {
    if (!browser) return;
    cwd = repo((c) => cpSync(EXAMPLE, join(c, "evals"), { recursive: true }));
    // A Learn more URL, and one edit waiting in the Pending changes tray.
    const cfg = join(cwd, "evals", "litmustest.yaml"); writeFileSync(cfg, readFileSync(cfg, "utf8") + "explain:\n  learn_more_url: https://example.com/guide\n");
    git(cwd, "commit", "-qam", "learn more url");
    const fm = join(cwd, "evals", "failure_modes", "tone_mismatch.yaml"); writeFileSync(fm, readFileSync(fm, "utf8").replace("severity: med", "severity: high"));
    s = await serve({ evalsDir: join(cwd, "evals"), port: 0, watch: false }); servers.push(s);
  });
  const open = async (route: string, opts: Parameters<Browser["newPage"]>[0] = { viewport: { width: 1440, height: 900 } }) => {
    const page = await browser!.newPage(opts); await page.goto(`${s.url}/#/${route}`);
    await page.waitForFunction(() => !/Loading…/.test(document.querySelector("#page")?.textContent ?? "") && document.querySelector("#page h1"));
    await page.waitForTimeout(250); return page;
  };
  const panelText = (page: import("playwright-core").Page) => page.textContent("#explain-panel");
  const waitPanel = (page: import("playwright-core").Page, re: RegExp) => page.waitForFunction((src) => new RegExp(src).test(document.querySelector("#explain-panel")?.textContent ?? ""), re.source);
  const box = async (page: import("playwright-core").Page, sel: string) => (await page.locator(sel).first().boundingBox())!;

  it("E3-S1: click, tap or Enter opens one 320px docked panel that reflows the page, with every section", async (ctx) => {
    if (!browser) return ctx.skip();
    const page = await open("judges/tone_mismatch");
    const v = page.locator('#page .term[data-term="tpr"][data-kind="value"]').first();
    await v.click(); await waitPanel(page, "Learn more");
    const pb = await box(page, "#explain-panel"); const main = await box(page, "#page");
    expect(Math.round(pb.width)).toBe(320);
    expect(main.x + main.width).toBeLessThanOrEqual(pb.x + 1); // the page sits beside the panel, not under it
    const t = await panelText(page);
    for (const part of ["True positive rate", "What it means here", "Next step", "Related", "Learn more: Master Class, chapter"]) expect(t).toContain(part);
    expect(await page.getAttribute("#explain-panel .more a", "href")).toMatch(/^https:\/\/example\.com\/guide#ch-\d+$/);
    expect(await page.locator("#explain-panel .chips .chip").count()).toBeGreaterThan(0);
    // another term updates the same panel
    await page.locator('#page .term[data-term="tnr"][data-kind="value"]').first().click(); await waitPanel(page, "True negative rate");
    expect(await page.locator(".explain-panel").count()).toBe(1);
    // the close button, Escape and ? all close it and return focus to the term that opened it
    await page.click(".panel-close"); expect(await page.isHidden("#explain-panel")).toBe(true);
    expect(await page.evaluate(() => (document.activeElement as HTMLElement)?.dataset.term)).toBe("tnr");
    await page.keyboard.press("Enter"); await waitPanel(page, "True negative rate");
    await page.keyboard.press("Escape"); expect(await page.isHidden("#explain-panel")).toBe(true);
    await page.keyboard.press("Enter"); await waitPanel(page, "True negative rate");
    await page.keyboard.press("?"); expect(await page.isHidden("#explain-panel")).toBe(true);
    expect(await page.evaluate(() => (document.activeElement as HTMLElement)?.dataset.term)).toBe("tnr");
    // it survives navigation: the same term stays if the screen has it, else the panel clears to page mode
    await page.locator('#page .term[data-term="tpr"][data-kind="value"]').first().click(); await waitPanel(page, "True positive rate");
    await page.evaluate(() => { location.hash = "#/judges/missed_refund"; }); await waitPanel(page, "missed_refund judge");
    await page.evaluate(() => { location.hash = "#/coverage"; }); await waitPanel(page, "This page");
    expect(await page.isVisible("#explain-panel")).toBe(true);
    await page.close();
  }, 90_000);

  it("E3-S1: below 900px it is a bottom sheet of at most 60% of the screen", async (ctx) => {
    if (!browser) return ctx.skip();
    const page = await open("judges/tone_mismatch", { viewport: { width: 800, height: 900 } });
    await page.locator('#page .term[data-term="tpr"][data-kind="value"]').first().click(); await waitPanel(page, "Learn more");
    const pb = await box(page, "#explain-panel");
    expect(pb.height).toBeLessThanOrEqual(0.6 * 900 + 1); expect(Math.round(pb.y + pb.height)).toBe(900); expect(Math.round(pb.width)).toBe(800);
    await page.close();
  }, 60_000);

  it("E3-S2: ? and the verdict strip open page mode with three terms from pages.yaml; one click switches to it", async (ctx) => {
    if (!browser) return ctx.skip();
    const page = await open("overview");
    await page.keyboard.press("?"); await waitPanel(page, "This page");
    const items = page.locator("#explain-panel .panel-list li"); expect(await items.count()).toBe(3);
    await page.waitForFunction(() => [...document.querySelectorAll("#explain-panel .panel-list li p")].every((p) => /\d|\w{3}/.test(p.textContent ?? "")));
    const pages = ((await (await fetch(`${s.url}/api/glossary`)).json()) as { pages: Record<string, string[]>; terms: { id: string; term: string }[] });
    const names = (await items.locator("button").allTextContents()); const allowed = pages.pages.overview!.map((id) => pages.terms.find((t) => t.id === id)!.term);
    for (const n of names) expect(allowed).toContain(n);
    await items.first().locator("button").click(); await waitPanel(page, "What it means here");
    await page.keyboard.press("Escape");
    await page.click(".explain-page"); await waitPanel(page, "This page");
    await page.keyboard.press("Escape");
    // ? typed into a text field is a character, not a shortcut
    await page.goto(`${s.url}/#/review`); await page.waitForSelector("textarea, input.text"); await page.focus("textarea"); await page.keyboard.press("?");
    expect(await page.isHidden("#explain-panel")).toBe(true);
    await page.close();
  }, 90_000);

  it("E3-S3 and E3-S4: Pending changes explains itself and its next step is the page's own Commit and Open PR", async (ctx) => {
    if (!browser) return ctx.skip();
    for (const width of [1280, 1440]) {
      const page = await open("pending", { viewport: { width, height: 900 } });
      for (const id of ["branch", "pending_changes", "diff_old", "diff_new", "diff_hunk"]) expect(await page.locator(`#page .term[data-term="${id}"]`).count(), id).toBeGreaterThan(0);
      await page.locator('#page .term[data-term="pending_changes"]').first().click(); await waitPanel(page, "Next step");
      const buttons = await page.locator("#explain-panel .panel-actions button").allTextContents();
      expect(buttons[0]).toMatch(/^Commit 1 file to evals\//); expect(buttons).toContain("Open PR");
      expect(await page.locator('#explain-panel a[href="#/pending"]').count()).toBe(0); // never a link to the page you are on
      // the panel never covers the diff
      const pb = await box(page, "#explain-panel"); const diff = await box(page, "pre.code-block");
      expect(diff.x + diff.width, `width ${width}`).toBeLessThanOrEqual(pb.x + 1);
      if (width === 1440) {
        await page.locator('#page .term[data-term="branch"]').first().click(); await waitPanel(page, "What it means here");
        expect(await panelText(page)).toMatch(/pull request/); expect(await panelText(page)).toMatch(/switch to an evals branch with git/);
        await page.locator('#page .term[data-term="diff_hunk"]').first().click(); await waitPanel(page, "starts a changed block");
        // the panel's Commit runs the same handler as the page's button: the tray empties
        await page.locator('#page .term[data-term="pending_changes"]').first().click(); await waitPanel(page, "Next step");
        page.once("dialog", (d) => d.accept());
        await page.locator('#explain-panel .panel-actions button[data-action="pending.commit"]').click();
        await page.waitForFunction(() => /Committed [0-9a-f]+ on evals\//.test(document.querySelector("#page")?.textContent ?? ""));
        expect(execFileSync("git", ["status", "--porcelain", "--", "evals"], { cwd, encoding: "utf8" }).trim()).toBe("");
        expect(execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd, encoding: "utf8" }).trim()).toMatch(/^evals\//);
      }
      await page.close();
    }
  }, 120_000);

  it("E3-S3: every disabled button has an explanation beside it that says what unblocks it", async (ctx) => {
    if (!browser) return ctx.skip();
    const missing: string[] = [];
    for (const r of [...ROUTES_ALL, "judges/missed_refund"]) {
      const page = await open(r);
      const groups = await page.$$eval("#page button:disabled", (els) => els.map((b) => { const box = b.closest(".alert") ?? b.closest(".save-row") ?? b.closest(".verdict") ?? b.closest(".card, section") ?? b.parentElement!; return { button: b.textContent?.trim(), triggers: [...box.querySelectorAll(".term")].map((t) => { const spec = (t as HTMLElement & { _spec?: { id: string; source?: string; ctx?: object } })._spec; return spec?.source ? spec : null; }).filter(Boolean) }; }));
      for (const g of groups) {
        let ok = false;
        for (const spec of g.triggers as { id: string; source: string; ctx: object }[]) { const r2 = (await (await fetch(`${s.url}/api/glossary/here`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ items: [spec] }) })).json()) as { items: { next?: { say: string } }[] }; if (r2.items[0]?.next?.say) { ok = true; break; } }
        if (!ok) missing.push(`${r}: "${g.button}"`);
      }
      await page.close();
    }
    expect(missing).toEqual([]);
  }, 180_000);
});

describe("explainer, Epic 4 (docs/stories/explainer.md)", () => {
  const fresh = () => { process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "litmustest-xdg-")); return join(process.env.XDG_CONFIG_HOME, "litmustest", "prefs.json"); };
  const start = async (extraConfig = "") => {
    const cwd = repo((c) => { cpSync(EXAMPLE, join(c, "evals"), { recursive: true }); if (extraConfig) writeFileSync(join(c, "evals", "litmustest.yaml"), readFileSync(join(c, "evals", "litmustest.yaml"), "utf8") + extraConfig); });
    const s = await serve({ evalsDir: join(cwd, "evals"), port: 0, watch: false }); servers.push(s); return { s, cwd };
  };
  const open = async (url: string) => { const page = await browser!.newPage({ viewport: { width: 1440, height: 900 } }); await page.goto(url); await page.waitForFunction(() => !/Loading…/.test(document.querySelector("#page")?.textContent ?? "") && document.querySelector("#page h1")); await page.waitForTimeout(400); return page; };
  const plainLines = (page: import("playwright-core").Page) => page.locator("#page .plain-line:not(:empty)").count();

  it("E4-S1: toggles in Settings and the panel header; on shows sentences inline, off only in the panel; stored per person, not in evals/", async (ctx) => {
    if (!browser) return ctx.skip();
    const file = fresh(); const { s, cwd } = await start();
    const page = await open(`${s.url}/#/overview`);
    expect(await plainLines(page)).toBeGreaterThan(0); // default when unset: on
    await page.goto(`${s.url}/#/settings`); await page.waitForSelector("#plain-setting");
    await page.uncheck("#plain-setting"); await page.waitForTimeout(300);
    expect(JSON.parse(readFileSync(file, "utf8")).plain_language).toBe(false);
    await page.goto(`${s.url}/#/overview`); await page.waitForTimeout(600);
    expect(await plainLines(page)).toBe(0);
    await page.locator('#page .term[data-term="corrected_rate"]').first().click();
    await page.waitForFunction(() => /What it means here/.test(document.querySelector("#explain-panel")?.textContent ?? "")); // still in the panel
    await page.check("#plain-panel"); await page.waitForFunction(() => document.querySelectorAll("#page .plain-line:not(:empty)").length > 0);
    expect(JSON.parse(readFileSync(file, "utf8")).plain_language).toBe(true);
    expect(execFileSync("git", ["status", "--porcelain"], { cwd, encoding: "utf8" }).trim()).toBe(""); // nothing written to the repo
    await page.close();
  }, 90_000);

  it("E4-S1: a repo sets the default for newcomers; a person's own choice wins", async (ctx) => {
    if (!browser) return ctx.skip();
    fresh(); const { s } = await start("explain:\n  plain_language_default: false\n");
    const p = (await (await fetch(`${s.url}/api/prefs`)).json()) as { plain_language_default: boolean; plain_language_effective: boolean };
    expect(p).toMatchObject({ plain_language_default: false, plain_language_effective: false });
    const page = await open(`${s.url}/#/overview`); expect(await plainLines(page)).toBe(0);
    await fetch(`${s.url}/api/prefs`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ plain_language: true }) });
    await page.reload(); await page.waitForFunction(() => document.querySelectorAll("#page .plain-line:not(:empty)").length > 0);
    expect((await fetch(`${s.url}/api/prefs`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ colour: "blue" }) })).status).toBe(400);
    await page.close();
  }, 90_000);

  it("E4-S1: the first panel a newcomer opens offers, once, to turn Plain language off", async (ctx) => {
    if (!browser) return ctx.skip();
    const file = fresh(); const { s } = await start();
    const page = await open(`${s.url}/#/overview`);
    const t = page.locator('#page .term[data-term="corrected_rate"]').first();
    await t.click(); await page.waitForSelector("#plain-off-once");
    await page.keyboard.press("Escape"); await t.click(); await page.waitForTimeout(300);
    expect(await page.$("#plain-off-once")).toBeNull(); // once only
    // a second newcomer uses it
    fresh(); const page2 = await open(`${s.url}/#/overview`);
    await page2.locator('#page .term[data-term="corrected_rate"]').first().click(); await page2.click("#plain-off-once");
    await page2.waitForFunction(() => document.querySelectorAll("#page .plain-line:not(:empty)").length === 0);
    expect(JSON.parse(readFileSync(join(process.env.XDG_CONFIG_HOME!, "litmustest", "prefs.json"), "utf8"))).toMatchObject({ plain_language: false, plain_prompt_seen: true });
    void file; await page.close(); await page2.close();
  }, 90_000);
});
