// Epic 3 of docs/stories/explainer.md, the checks that need no browser (tests/ui_smoke.test.ts has the rest).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ACTIONS } from "../packages/cli/src/explain/actions.ts";
import { loadGlossary, loadPages, pluginEntries, SCREENS, validateGlossary, validatePages } from "../packages/cli/src/glossary.ts";
import { commitBranch } from "../packages/cli/src/server/git.ts";

const ROOT = join(import.meta.dirname, "..");
const app = readFileSync(join(ROOT, "packages", "cli", "ui", "app.js"), "utf8");

describe("E3-S2 pages.yaml", () => {
  it("names at least three known terms for every screen", () => {
    const pages = loadPages();
    expect(validatePages(pages, pluginEntries())).toEqual([]);
    for (const s of SCREENS) expect(pages[s]!.length, s).toBeGreaterThanOrEqual(3);
  });
});

describe("E3-S3 next steps are actions", () => {
  it("every action the glossary names is a command some screen registers", () => {
    const named = new Set(pluginEntries().flatMap((e) => (e.here ?? []).flatMap((v) => (v.next ?? []).flatMap((n) => [n.action ?? []].flat()))));
    for (const a of named) { expect(Object.keys(ACTIONS)).toContain(a); expect(app, a).toContain(`command("${a}"`); }
  });
  it("page buttons run the registered command, so the panel and the page share one handler", () => {
    for (const [cmd, v] of [["pending.commit", "commit"], ["pending.openPr", "openPr"], ["pending.discard", "discard"], ["judges.runDev", "runDev"], ["judges.runTest", "runTest"], ["tasks.graduate", "grad"]]) {
      expect(app).toMatch(new RegExp(`const ${v} = (command\\("${cmd.replace(".", "\\.")}"|\\{)`));
      expect(app, `${v}.run`).toContain(`onclick: ${v}.run`);
    }
  });
  it("the Pending changes step offers Commit and Open PR, and commits land where the label says", () => {
    const e = loadGlossary().find((x) => x.id === "pending_changes")!;
    expect(e.here![0]!.next![0]!.action).toEqual(["pending.commit", "pending.openPr"]);
    expect(commitBranch("feat/age-levels-p0", ["evals/failure_modes/tone_mismatch.yaml"])).toMatch(/^evals\/\d{4}-\d{2}-\d{2}-tone-mismatch$/);
    expect(commitBranch("evals/mine", ["x"])).toBe("evals/mine");
    expect(validateGlossary(loadGlossary())).toEqual([]);
  });
});

describe("E3-S4 Pending changes terms", () => {
  it("the branch explanation says why edits go to a branch and how to change it; each diff marker is one line", () => {
    const g = pluginEntries(); const branch = g.find((e) => e.id === "branch")!;
    const text = JSON.stringify(branch);
    expect(text).toMatch(/pull request/); expect(text).toMatch(/switch to/);
    for (const id of ["diff_old", "diff_new", "diff_hunk"]) { const d = g.find((e) => e.id === id)!; expect(d.short.split("\n")).toHaveLength(1); expect(d.short).toContain(d.term); }
  });
});
