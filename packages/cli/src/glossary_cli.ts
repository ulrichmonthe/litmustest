// The explainer in the terminal: `litmustest explain <term>` (layer 1, then layer 2 for every matching context)
// and the one-line "here" sentences that --plain prints under table rows.
import { existsSync } from "node:fs";
import type { Comparison } from "./compare.ts";
import { SOURCES, factsFor, type Ctx } from "./glossary_facts.ts";
import { findEntry, loadGlossary, renderHere, unlink, type Entry } from "./glossary.ts";
import { loadFiles } from "./server/overview.ts";

const MAX_CONTEXTS = 8;

export function termText(q: string, evalsDir?: string): { text: string; found: boolean } {
  const dir = evalsDir && existsSync(evalsDir) ? evalsDir : undefined;
  const entries = loadGlossary(dir); const e = findEntry(entries, q);
  if (!e) {
    const near = entries.filter((x) => x.id.includes(q.toLowerCase()) || x.term.toLowerCase().includes(q.toLowerCase())).slice(0, 5).map((x) => x.id);
    return { found: false, text: `No term "${q}".${near.length ? ` Did you mean: ${near.join(", ")}?` : ""} \`litmustest explain --terms\` lists them all.` };
  }
  const lines = [`${e.term}${e.aliases?.length ? ` (${e.aliases.join(", ")})` : ""}`, "", unlink(e.short, entries)];
  if (e.why) lines.push("", `Why it matters: ${e.why}`);
  if (e.good) lines.push(`What good looks like: ${e.good}`);
  if (dir) {
    const here = hereLines(e, dir);
    if (here.length) lines.push("", "In this repo:", ...here.map((l) => `  ${l}`));
  }
  if (e.related?.length) lines.push("", `Related: ${e.related.join(", ")}`);
  if (e.learn_more) lines.push(`Learn more: Master Class, chapter ${e.learn_more.split("ch-")[1]}`);
  return { found: true, text: lines.join("\n") };
}

function hereLines(e: Entry, evalsDir: string): string[] {
  const f = loadFiles(evalsDir); const out: string[] = [];
  for (const source of new Set((e.here ?? []).map((v) => v.source))) {
    const contexts = e.origin === "failure_mode" ? [{ mode: e.id }] : SOURCES[source]!.contexts(evalsDir, f);
    for (const ctx of contexts.slice(0, MAX_CONTEXTS)) {
      const facts = factsFor(evalsDir, source, ctx, f); const r = facts && renderHere(e, source, facts);
      if (r) out.push(r.next ? `${r.text} Next: ${r.next.say}` : r.text);
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
  const entries = loadGlossary(evalsDir); const f = loadFiles(evalsDir); const out: string[] = [];
  for (const it of items) {
    const e = findEntry(entries, it.id); const facts = e && factsFor(evalsDir, it.source, it.ctx, f);
    const r = e && facts ? renderHere(e, it.source, facts) : null;
    if (r) out.push(`${indent}${r.text}${r.next ? ` Next: ${r.next.say}` : ""}`);
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
