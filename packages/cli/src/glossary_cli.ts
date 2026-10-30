// The explainer in the terminal: `litmustest explain <term>` (layer 1, then layer 2 for every matching context)
// and the one-line "here" sentences that --plain prints under table rows.
import { existsSync } from "node:fs";
import type { Comparison } from "./compare.ts";
import { explain } from "./explain/index.ts";
import { SOURCES, type Ctx } from "./glossary_facts.ts";
import { loadGlossary, unlink, type Entry } from "./glossary.ts";
import { loadFiles } from "./server/overview.ts";

const MAX_CONTEXTS = 8;

export function termText(q: string, evalsDir?: string): { text: string; found: boolean } {
  const dir = evalsDir && existsSync(evalsDir) ? evalsDir : undefined;
  const entries = loadGlossary(dir); const x = explain(q, { entries });
  if (!x) {
    const near = entries.filter((e) => e.id.includes(q.toLowerCase()) || e.term.toLowerCase().includes(q.toLowerCase())).slice(0, 5).map((e) => e.id);
    return { found: false, text: `No term "${q}".${near.length ? ` Did you mean: ${near.join(", ")}?` : ""} \`litmustest explain --terms\` lists them all.` };
  }
  const lines = [`${x.term}${x.aliases.length ? ` (${x.aliases.join(", ")})` : ""}`, "", x.shortPlain];
  if (x.why) lines.push("", `Why it matters: ${x.why}`);
  if (x.good) lines.push(`What good looks like: ${x.good}`);
  if (dir) {
    const here = hereLines(entries.find((e) => e.id === x.id)!, dir, entries);
    if (here.length) lines.push("", "In this repo:", ...here.map((l) => `  ${l}`));
  }
  if (x.related.length) lines.push("", `Related: ${x.related.map((r) => r.id).join(", ")}`);
  if (x.learnMore) lines.push(`Learn more: Master Class, chapter ${x.learnMore.chapter}`);
  return { found: true, text: lines.join("\n") };
}

function hereLines(e: Entry, evalsDir: string, entries: Entry[]): string[] {
  const files = loadFiles(evalsDir); const out: string[] = [];
  for (const source of new Set((e.here ?? []).map((v) => v.source))) {
    const contexts = e.origin === "failure_mode" ? [{ mode: e.id }] : SOURCES[source]!.contexts(evalsDir, files);
    for (const ctx of contexts.slice(0, MAX_CONTEXTS)) {
      const x = explain(e.id, { evalsDir, source, ctx, entries, files });
      if (x?.here) out.push(x.next ? `${x.here} Next: ${x.next.say}` : x.here);
    }
  }
  return out;
}

export function termList(evalsDir?: string): string {
  const entries = loadGlossary(evalsDir && existsSync(evalsDir) ? evalsDir : undefined);
  const w = Math.max(...entries.map((e) => e.id.length));
  return entries.map((e) => `${e.id.padEnd(w)}  ${unlink(e.short, entries)}`).join("\n");
}

/** For --plain: the "here" sentence and next step of one term for one row, indented under it. Empty when nothing renders. */
export function plainLines(evalsDir: string, items: { id: string; source: string; ctx: Ctx }[], indent = "    "): string {
  const entries = loadGlossary(evalsDir); const files = loadFiles(evalsDir); const out: string[] = [];
  for (const it of items) {
    const x = explain(it.id, { evalsDir, source: it.source, ctx: it.ctx, entries, files });
    if (x?.here) out.push(`${indent}${x.here}${x.next ? ` Next: ${x.next.say}` : ""}`);
  }
  return out.join("\n");
}

/** The PR comment's "What these numbers mean": one sentence per suite whose gate moved (a significant delta or a failed gate). */
export function meaningBlock(evalsDir: string, c: Comparison, opts: { all?: boolean; collapsed?: boolean } = {}): string {
  const a = String(c.a.run_id), b = String(c.b.run_id);
  const moved = c.suites.filter((s) => opts.all || (s.gate && !s.gate.report_only && (s.significant || s.gate_result?.passed === false)));
  const rows = moved.map((s) => ({ s, line: plainLines(evalsDir, [{ id: "gate", source: "delta", ctx: { a, b, suite: s.name } }], "").trim() })).filter((x) => x.line);
  if (!rows.length) return "";
  const list = rows.map((x) => `- **${x.s.name}**: ${x.line}`).join("\n");
  return opts.collapsed === false ? `### What these numbers mean\n\n${list}\n` : `<details><summary>What these numbers mean</summary>\n\n${list}\n\n</details>\n`;
}

/** doctor's alert kinds, as the term and source that explain them. */
export function alertTerm(kind: string, href: string): { id: string; source: string; ctx: Ctx } | null {
  const parts = href.replace(/^#\//, "").split("/").map(decodeURIComponent);
  if (kind === "Judge stale" && parts[0] === "judges") return { id: "stale", source: "judge", ctx: { judge: parts[1]! } };
  if (kind === "Flaky task" && parts[0] === "tasks") return { id: "flaky", source: "task", ctx: { task: parts[2]! } };
  if (kind === "Broken task" && parts[0] === "tasks") return { id: "likely_broken", source: "task", ctx: { task: parts[2]! } };
  if (kind === "Review queue") return { id: "label", source: "queue", ctx: {} };
  return null;
}
