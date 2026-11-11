// The explainer's contract (docs/EXPLAINER.md): the glossary validates, every number it prints comes from a fact,
// facts equal the files, blocked states say what unblocks them, and the CLI, API and PR comment read the same words.
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { compareRuns } from "../packages/cli/src/compare.ts";
import { evaluate, loadGlossary, parseExpr, parseTemplate, pluginEntries, renderHere, renderTemplate, validateGlossary, type Entry } from "../packages/cli/src/glossary.ts";
import { SOURCES, factsFor } from "../packages/cli/src/glossary_facts.ts";
import { meaningBlock, termText } from "../packages/cli/src/glossary_cli.ts";
import { SchemaSet } from "../packages/cli/src/schemas.ts";
import { serve, type Running } from "../packages/cli/src/serve.ts";
import { loadFiles } from "../packages/cli/src/server/overview.ts";
import { validateEvals } from "../packages/cli/src/validate.ts";

const ROOT = join(import.meta.dirname, "..");
const EXAMPLE = join(ROOT, "examples", "support-agent", "evals");
const entries = loadGlossary(EXAMPLE);
const files = loadFiles(EXAMPLE);

/** Every (entry, source, context) the example repo can render. */
const rendered = entries.filter((e) => e.origin === "plugin").flatMap((e) => [...new Set((e.here ?? []).map((v) => v.source))].flatMap((source) => SOURCES[source]!.contexts(EXAMPLE, files).map((ctx) => ({ e, source, ctx, facts: factsFor(EXAMPLE, source, ctx, files) }))));

describe("the plugin glossary", () => {
  it("matches the schema", () => { expect(new SchemaSet().check("glossary", parseYaml(readFileSync(join(ROOT, "plugin", "glossary", "terms.yaml"), "utf8")))).toEqual([]); });
  it("passes every validator rule, with the example's failure modes added", () => { expect(validateGlossary(entries)).toEqual([]); });
  it("covers the seed terms of the PRD", () => {
    const ids = new Set(pluginEntries().map((e) => e.id));
    for (const id of ["trace", "label", "failure_mode", "severity", "task", "check", "code_check", "judge", "outcome_check", "reference_solution", "suite", "regression_suite", "capability_suite", "graduation", "trial", "pass_at_1", "pass_hat_k", "flaky", "likely_broken", "infra_error", "confidence_interval", "gate", "calibration", "tpr", "tnr", "dev_set", "test_set", "trusted", "stale", "corrected_rate", "pending_changes"]) expect(ids, id).toContain(id);
  });
  it("renders something true for most contexts in the example", () => {
    const ok = rendered.filter((r) => r.facts && renderHere(r.e, r.source, r.facts));
    expect(ok.length / rendered.length).toBeGreaterThan(0.8);
  });
});

describe("an explanation never creates a number", () => {
  it("every digit in a rendered sentence comes from a placeholder", () => {
    for (const r of rendered) {
      if (!r.facts) continue;
      const out = renderHere(r.e, r.source, r.facts); if (!out) continue;
      const v = r.e.here!.find((x) => x.source === r.source && (!x.when || evaluate(parseExpr(x.when), r.facts!)) && renderTemplate(x.template, r.facts!) !== null)!;
      const fixed = new Set((r.e.good ?? "").match(/\d+(\.\d+)?/g) ?? []);
      // Strip every placeholder's own output, then no digit may remain except numbers from "good".
      let rest = out.text;
      for (const p of parseTemplate(v.template)) if (p.expr) { const one = renderTemplate(`{${p.src}${p.fmt ? ` | ${p.fmt}` : ""}}`, r.facts!)!; rest = rest.replace(one, " "); }
      for (const d of rest.match(/\d+(\.\d+)?/g) ?? []) expect(fixed.has(d), `${r.e.id}/${r.source} ${JSON.stringify(r.ctx)}: "${d}" in "${out.text}"`).toBe(true);
    }
  });
  it("judge facts equal calibration.json", () => {
    for (const ctx of SOURCES.judge!.contexts(EXAMPLE, files)) {
      const raw = JSON.parse(readFileSync(join(EXAMPLE, "graders", "judges", ctx.judge!, "calibration.json"), "utf8"));
      const f = factsFor(EXAMPLE, "judge", ctx, files) as { dev: Record<string, number>; test: Record<string, number> };
      expect(f.dev.tpr).toBe(raw.dev.tpr); expect(f.dev.tnr).toBe(raw.dev.tnr);
      expect(f.dev.tp).toBe(raw.dev.matrix.tp); expect(f.dev.fn).toBe(raw.dev.matrix.fn);
      if (raw.test) expect(f.test.tpr).toBe(raw.test.tpr);
    }
  });
  it("suite and task facts equal the run summary", () => {
    const last = files.runs[files.runs.length - 1]!;
    const raw = JSON.parse(readFileSync(join(EXAMPLE, "runs", `${last.run_id}.json`), "utf8"));
    for (const ctx of SOURCES.suite!.contexts(EXAMPLE, files)) {
      const f = factsFor(EXAMPLE, "suite", ctx, files) as Record<string, unknown>;
      expect(f.pass_rate).toBe(raw.suites[ctx.suite!].pass_rate);
      expect(f.pass_rate_ci).toEqual({ low: raw.suites[ctx.suite!].ci.low, high: raw.suites[ctx.suite!].ci.high });
      expect(f.n_tasks).toBe(raw.suites[ctx.suite!].n_tasks);
    }
    for (const ctx of SOURCES.task!.contexts(EXAMPLE, files)) {
      const f = factsFor(EXAMPLE, "task", ctx, files) as Record<string, unknown>;
      const trials = raw.tasks[ctx.task!].trials.filter((t: { infra_error: boolean }) => !t.infra_error);
      expect(f.passed).toBe(trials.filter((t: { pass: boolean }) => t.pass).length);
      expect(f.trials).toBe(trials.length);
    }
  });
  it("every rate it prints carries its interval", () => {
    for (const r of rendered) { if (!r.facts) continue; const out = renderHere(r.e, r.source, r.facts); if (out && /\d+%/.test(out.text) && SOURCES[r.source]!.intervals) expect(out.text, `${r.e.id}/${r.source}`).toMatch(/\d+–\d+%|could be|to [+−]?\d/); }
  });
});

describe("blocked states say what unblocks them", () => {
  const blocked: [string, string][] = [["stale", "judge"], ["trusted", "judge"], ["tpr", "judge"], ["tnr", "judge"], ["test_set", "judge"], ["calibration", "judge"], ["flaky", "task"], ["likely_broken", "task"], ["gate", "delta"]];
  for (const [id, source] of blocked) it(`${id} (${source}) always has a next step`, () => {
    const e = entries.find((x) => x.id === id)!;
    for (const ctx of SOURCES[source]!.contexts(EXAMPLE, files)) { const facts = factsFor(EXAMPLE, source, ctx, files); const r = facts && renderHere(e, source, facts); if (r) expect(r.next, `${id} ${JSON.stringify(ctx)}`).not.toBeNull(); }
  });
  it("a stale judge's next step is to re-calibrate", () => {
    const r = renderHere(entries.find((x) => x.id === "stale")!, "judge", factsFor(EXAMPLE, "judge", { judge: "missed_refund" }, files)!)!;
    expect(r.next!.say.toLowerCase()).toMatch(/dev|calibrat|test set/);
  });
});

describe("the validator", () => {
  const base: Entry = { id: "x_rate", term: "X rate", short: "A made-up rate.", good: "90% or higher.", here: [{ source: "judge", template: "Caught {dev.tpr | pct} (could be {dev.tpr_ci | range}).", next: [{ say: "Do nothing." }] }] };
  const problems = (e: Partial<Entry>) => validateGlossary([{ ...base, ...e } as Entry]).map((p) => p.message).join("\n");
  it("accepts a well-formed entry", () => { expect(problems({})).toBe(""); });
  it("rejects a path that is not a fact", () => { expect(problems({ here: [{ source: "judge", template: "Caught {dev.tprr | pct}.", next: [{ say: "x" }] }] })).toMatch(/"dev.tprr" is not a fact/); });
  it("rejects a typed number", () => { expect(problems({ here: [{ source: "judge", template: "Caught 42 of them.", next: [{ say: "x" }] }] })).toMatch(/types the number 42/); });
  it("allows a number that appears in good", () => { expect(problems({ here: [{ source: "judge", template: "The bar is 90%.", next: [{ say: "x" }] }] })).toBe(""); });
  it("rejects a rate without its interval", () => { expect(problems({ here: [{ source: "judge", template: "Caught {dev.tpr | pct}.", next: [{ say: "x" }] }] })).toMatch(/without its interval/); });
  it("rejects the wrong formatter", () => { expect(problems({ here: [{ source: "judge", template: "Caught {dev.tpr} ({dev.tpr_ci | range}).", next: [{ say: "x" }] }] })).toMatch(/print it as \{dev.tpr \| pct\}/); });
  it("rejects arithmetic on rates", () => { expect(problems({ here: [{ source: "judge", template: "{dev.tpr + dev.tnr} {dev.tpr_ci | range}", next: [{ say: "x" }] }] })).toMatch(/arithmetic only on counts/); });
  it("rejects a next list with no fallback", () => { expect(problems({ here: [{ source: "judge", template: "{judge}", next: [{ when: "dev.ran", say: "x" }] }] })).toMatch(/must end with a step that has no "when"/); });
  it("rejects a long short", () => { expect(problems({ short: Array(25).fill("word").join(" ") })).toMatch(/at most 20/); });
  it("rejects an unknown source and a bad chapter", () => { expect(problems({ here: [{ source: "invoices", template: "x" }], learn_more: "master-class#ch-40" })).toMatch(/unknown source/); expect(problems({ learn_more: "master-class#ch-40" })).toMatch(/learn_more/); });
  it("rejects an unlinked term in short, and a duplicate alias", () => {
    const two = validateGlossary([{ ...base, here: undefined }, { id: "judge", term: "Judge", short: "Grades things." }, { id: "y", term: "Y", aliases: ["X rate"], short: "Uses a judge." }]).map((p) => p.message).join("\n");
    expect(two).toMatch(/"X rate" is already used/); expect(two).toMatch(/uses "Judge" without linking it as \[\[judge\]\]/);
  });
});

describe("a repo's own terms", () => {
  let dir: string;
  beforeAll(() => { dir = mkdtempSync(join(tmpdir(), "litmustest-gloss-")); cpSync(EXAMPLE, join(dir, "evals"), { recursive: true }); });
  it("failure modes are terms, and a repo term cannot take a plugin id", () => {
    expect(loadGlossary(join(dir, "evals")).find((e) => e.id === "tone_mismatch")?.origin).toBe("failure_mode");
    writeFileSync(join(dir, "evals", "glossary.yaml"), "- id: tpr\n  term: Our TPR\n  short: Mine.\n");
    expect(validateEvals(join(dir, "evals")).problems.filter((p) => p.rule === "glossary").map((p) => p.message).join("\n")).toMatch(/already used/);
    writeFileSync(join(dir, "evals", "glossary.yaml"), "- id: refund_window\n  term: Refund window\n  short: The days after a charge in which a customer can get money back.\n");
    expect(validateEvals(join(dir, "evals")).problems.filter((p) => p.rule === "glossary")).toEqual([]);
  });
});

describe("surfaces read the same words", () => {
  let run: Running; let cwd: string;
  beforeAll(async () => {
    cwd = mkdtempSync(join(tmpdir(), "litmustest-gloss-srv-"));
    const git = (...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd });
    git("init", "-q", "-b", "main"); cpSync(EXAMPLE, join(cwd, "evals"), { recursive: true }); git("add", "-A"); git("commit", "-q", "-m", "seed");
    run = await serve({ evalsDir: join(cwd, "evals"), port: 0, watch: false });
  });
  afterAll(async () => { await run?.close(); });

  it("GET /api/glossary lists terms; POST /api/glossary/here renders them", async () => {
    const g = await (await fetch(`${run.url}/api/glossary`)).json() as { terms: { id: string; short: string }[] };
    const tpr = g.terms.find((t) => t.id === "tpr")!; expect(tpr.short).toBe(entries.find((e) => e.id === "tpr")!.short);
    const r = await (await fetch(`${run.url}/api/glossary/here`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ items: [{ id: "TPR", source: "judge", ctx: { judge: "tone_mismatch" } }, { id: "nope", source: "judge", ctx: {} }] }) })).json() as { items: { here?: string; error?: string }[] };
    expect(r.items[0]!.here).toMatch(/tone_mismatch/); expect(r.items[1]!.error).toBe("no such term");
  });
  it("litmustest explain prints the popover's text, and finds aliases", () => {
    const out = termText("recall", EXAMPLE); expect(out.found).toBe(true);
    expect(out.text).toContain(entries.find((e) => e.id === "tpr")!.short.replace(/\[\[(\w+)\]\]/g, (_, id) => entries.find((e) => e.id === id)!.term.toLowerCase()));
    expect(out.text).toMatch(/In this repo:/);
    expect(termText("no_such_thing", EXAMPLE).found).toBe(false);
  });
  it("the PR comment block appears when a gate moved and not otherwise", () => {
    const c = compareRuns(EXAMPLE, "run_0040", "run_0041");
    const moved = c.suites.filter((s) => s.gate && !s.gate.report_only && (s.delta !== 0 || s.a !== s.b || s.gate_result?.passed === false));
    const block = meaningBlock(EXAMPLE, c);
    if (moved.length) { expect(block).toMatch(/<details><summary>What these numbers mean/); for (const s of moved) expect(block).toContain(`**${s.name}**`); }
    const calm = { ...c, suites: c.suites.map((s) => ({ ...s, b: s.a, delta: 0, significant: false, gate_result: s.gate_result && { passed: true, reasons: [] } })) };
    expect(meaningBlock(EXAMPLE, calm)).toBe("");
  });
});
