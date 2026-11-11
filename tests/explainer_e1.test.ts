// Epic 1 of docs/stories/explainer.md, one test per acceptance check.
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { explain } from "../packages/cli/src/explain/index.ts";
import { glossaryProblems, loadGlossary, pluginEntries, validateGlossary, type Entry } from "../packages/cli/src/glossary.ts";
import { SchemaSet } from "../packages/cli/src/schemas.ts";
import { validateEvals } from "../packages/cli/src/validate.ts";
import { lintTerms, literals } from "../scripts/lint-terms.ts";

const ROOT = join(import.meta.dirname, "..");
const EXAMPLE = join(ROOT, "examples", "support-agent", "evals");
const copy = () => { const d = mkdtempSync(join(tmpdir(), "litmustest-e1-")); cpSync(EXAMPLE, join(d, "evals"), { recursive: true }); return join(d, "evals"); };
const glossaryErrors = (evals: string) => validateEvals(evals).problems.filter((p) => p.rule === "glossary").map((p) => `${p.file}: ${p.message}`).join("\n");

describe("E1-S1 glossary file and schema", () => {
  it("the schema has the story's fields, and accepts here as one {source, template} with a top-level next", () => {
    const schema = JSON.parse(readFileSync(join(ROOT, "schemas", "glossary.json"), "utf8"));
    for (const f of ["id", "term", "aliases", "short", "why", "good", "here", "next", "related", "learn_more", "audience"]) expect(Object.keys(schema.items.properties)).toContain(f);
    expect(Object.keys(schema.$defs.next.properties)).toEqual(expect.arrayContaining(["when", "say", "action", "link"]));
    const one = [{ id: "refund_window", term: "Refund window", short: "The days after a charge in which a customer can get money back.", good: "14 days.", here: { source: "pending", template: "{count} files are pending on {branch}." }, next: [{ when: "count > 0", say: "Commit them.", action: "pending.commit" }, { say: "Nothing to do." }] }];
    expect(new SchemaSet().check("glossary", one)).toEqual([]);
    const d = copy(); writeFileSync(join(d, "glossary.yaml"), JSON.stringify(one));
    const e = loadGlossary(d).find((x) => x.id === "refund_window")!;
    expect(e.here).toHaveLength(1); expect(e.here![0]!.next![0]!.action).toBe("pending.commit");
    expect(glossaryErrors(d)).toBe("");
  });
  it("litmustest validate checks short length, placeholders, typed digits, the fallback step and actions", () => {
    const d = copy();
    writeFileSync(join(d, "glossary.yaml"), JSON.stringify([{ id: "too_much", term: "Too much", short: Array(22).fill("word").join(" "), here: { source: "judge", template: "Caught 42 of {dev.tpz}." }, next: [{ when: "dev.ran", say: "Do it.", action: "judges.explode" }] }]));
    const errs = glossaryErrors(d);
    expect(errs).toMatch(/glossary\.yaml: too_much: short has 22 words/);
    expect(errs).toMatch(/"dev\.tpz" is not a fact of judge/);
    expect(errs).toMatch(/types the number 42/);
    expect(errs).toMatch(/must end with a step that has no "when"/);
    expect(errs).toMatch(/"judges\.explode" is not a dashboard command/);
  });
  it("problems in the plugin's own glossary point at its file", () => {
    const d = copy(); const ps = glossaryProblems(d);
    expect(ps).toEqual([]);
    const bad: Entry = { ...pluginEntries()[0]!, short: Array(25).fill("x").join(" ") };
    expect(validateGlossary([bad]).map((p) => p.message).join()).toMatch(/at most 20/);
  });
  it("the PRD's seed terms are present and valid", () => {
    const ids = new Set(pluginEntries().map((e) => e.id));
    const seed = ["trace", "label", "failure_mode", "severity", "task", "check", "code_check", "judge", "outcome_check", "reference_solution", "suite", "regression_suite", "capability_suite", "graduation", "trial", "pass_at_1", "pass_hat_k", "flaky", "likely_broken", "infra_error", "confidence_interval", "gate", "calibration", "tpr", "tnr", "dev_set", "test_set", "trusted", "stale", "corrected_rate", "pending_changes"];
    expect(seed.filter((s) => !ids.has(s))).toEqual([]);
    expect(validateGlossary(loadGlossary(EXAMPLE))).toEqual([]);
  });
  it("a repo term with a plugin id is an error; a new repo term is not", () => {
    const d = copy();
    writeFileSync(join(d, "glossary.yaml"), "- id: gate\n  term: Our gate\n  short: Ours.\n");
    expect(glossaryErrors(d)).toMatch(/glossary\.yaml: gate: "gate" is already used by gate \(plugin\)/);
  });
});

describe("E1-S2 explanation resolver", () => {
  it("explain() returns the story's shape", () => {
    const x = explain("recall", { evalsDir: EXAMPLE, source: "judge", ctx: { judge: "tone_mismatch" } })!;
    expect(x.id).toBe("tpr"); expect(x.term).toBe("True positive rate");
    expect(x.short).toBeTruthy(); expect(x.here).toMatch(/tone_mismatch judge caught \d+ of \d+/);
    expect(x.next?.say).toBeTruthy(); expect(x.learnMore?.chapter).toBeGreaterThan(0);
    expect(x.related.map((r) => r.id)).toContain("judge");
  });
  it("is what the server, the CLI and the PR comment call", () => {
    for (const f of ["packages/cli/src/server/glossary_route.ts", "packages/cli/src/glossary_cli.ts"]) expect(readFileSync(join(ROOT, f), "utf8")).toMatch(/import \{ explain \} from "\.\.?\/explain\/index\.ts"/);
    // The PR comment's block is built by meaningBlock -> plainLines -> explain().
    expect(readFileSync(join(ROOT, "packages/cli/src/glossary_cli.ts"), "utf8")).toMatch(/export function plainLines[\s\S]*?explain\(/);
  });
  it("omits here when the file or field is missing, never shows blanks", () => {
    expect(explain("tpr", { evalsDir: EXAMPLE, source: "judge", ctx: { judge: "no_such_judge" } })).not.toHaveProperty("here");
    const d = copy(); rmSync(join(d, "graders", "judges", "tone_mismatch", "calibration.json"));
    const x = explain("tpr", { evalsDir: d, source: "judge", ctx: { judge: "tone_mismatch" } })!;
    expect(x.here ?? "").not.toMatch(/undefined|null|NaN|\{|\}/);
    expect(explain("tpr", {})).not.toHaveProperty("here");
  });
  it("every rate a seed term prints carries its interval, through pct and range only", () => {
    // Enforced by the validator for every template; checked here against the files the plugin ships.
    const raw = parseYaml(readFileSync(join(ROOT, "plugin", "glossary", "terms.yaml"), "utf8")) as Entry[];
    const formatters = new Set(JSON.stringify(raw).match(/\|\s*([a-z]+)\s*\}/g)?.map((m) => m.replace(/[|}\s]/g, "")));
    expect([...formatters].filter((f) => !["pct", "range", "percent", "pts", "prange", "points", "usd"].includes(f))).toEqual([]);
    expect(validateGlossary(loadGlossary(EXAMPLE)).filter((p) => /interval|formatter|print it as/.test(p.message))).toEqual([]);
  });
});

describe("E1-S3 undefined-term lint", () => {
  it("the shipped UI and CLI have no unexplained jargon", () => { expect(lintTerms()).toEqual([]); });
  it("a rendered jargon word with no entry fails with file and line, and comments and identifiers do not", () => {
    const f = join(mkdtempSync(join(tmpdir(), "litmustest-lint-")), "page.js");
    writeFileSync(f, ['// kappa in a comment is fine', 'const kappa = 1;', 'h("p", {}, "Agreement beyond chance");', 'h("span", {}, `Cohen\'s kappa ${kappa}`);', 'x.replace(/kappa/g, "");'].join("\n"));
    const hits = lintTerms([f]);
    expect(hits.map((h) => `${h.line}:${h.word}`)).toEqual(["4:kappa", "4:cohen's kappa"]);
  });
  it("finds literals in templates and skips regex literals", () => {
    expect(literals('a = `one ${b} two`; c = /"x"/; d = "three";').map((l) => l.text)).toEqual(["one   two", "three"]);
  });
  it("runs in CI", () => {
    expect(JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).scripts["lint:terms"]).toBe("node scripts/lint-terms.ts");
    expect(readFileSync(join(ROOT, ".github", "workflows", "test.yml"), "utf8")).toContain("npm run lint:terms");
  });
});
