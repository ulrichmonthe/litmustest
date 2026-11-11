// The explainer in the terminal: `litmustest explain <term>` (layer 1, then layer 2 for every matching context)
// and the one-line "here" sentences that --explain prints under table rows.
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
    const near = closest(q, entries);
    return { found: false, text: `No term "${q}".${near.length ? ` Closest: ${near.join(", ")}.` : ""} \`litmustest explain --list\` lists them all.` };
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

/** For --explain: the "here" sentence and next step of one term for one row, indented under it. Empty when nothing renders. */
export function plainLines(evalsDir: string, items: { id: string; source: string; ctx: Ctx }[], indent = "    "): string {
  const entries = loadGlossary(evalsDir); const files = loadFiles(evalsDir); const out: string[] = [];
  for (const it of items) {
    const x = explain(it.id, { evalsDir, source: it.source, ctx: it.ctx, entries, files });
    if (x?.here) out.push(`${indent}${x.here}${x.next ? ` Next: ${x.next.say}` : ""}`);
  }
  return out.join("\n");
}

/** The PR comment's "What these numbers mean": one sentence per gated suite whose value changed, or whose gate failed. */
export function meaningBlock(evalsDir: string, c: Comparison, opts: { all?: boolean; collapsed?: boolean } = {}): string {
  const a = String(c.a.run_id), b = String(c.b.run_id);
  const moved = c.suites.filter((s) => opts.all || (s.gate && !s.gate.report_only && (s.delta !== 0 || s.a !== s.b || s.gate_result?.passed === false)));
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

/** Up to three terms nearest to what was typed: by edit distance over ids, names and aliases, and by containment. */
export function closest(q: string, entries: Entry[], n = 3): string[] {
  const k = q.toLowerCase();
  const dist = (a: string, b: string) => { const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]); for (let j = 1; j <= b.length; j++) d[0]![j] = j; for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1)); return d[a.length]![b.length]!; };
  const score = (e: Entry) => Math.min(...[e.id, e.term, ...(e.aliases ?? [])].map((x) => x.toLowerCase()).map((x) => (x.includes(k) || k.includes(x) ? Math.abs(x.length - k.length) / 10 : dist(k, x))));
  return entries.map((e) => ({ id: e.id, s: score(e) })).filter((x) => x.s <= Math.max(2, k.length / 2)).sort((a, b) => a.s - b.s || a.id.localeCompare(b.id)).slice(0, n).map((x) => x.id);
}

/** Muted and indented: dim when the terminal shows colour (FORCE_COLOR, or a TTY without NO_COLOR). */
export function muted(text: string, stream: { isTTY?: boolean } = process.stdout): string {
  const colour = process.env.FORCE_COLOR ? process.env.FORCE_COLOR !== "0" : Boolean(stream.isTTY) && !process.env.NO_COLOR;
  return colour && text ? text.split("\n").map((l) => `\x1b[2m${l}\x1b[22m`).join("\n") : text;
}
