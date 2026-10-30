// npm run lint:terms (docs/stories/explainer.md E1-S3): fail when text the dashboard or the CLI prints uses eval jargon
// that has no glossary entry. Scans string and template literals (not identifiers or comments) and HTML text.
import { readFileSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { parse as parseYaml } from "yaml";
import { pluginEntries } from "../packages/cli/src/glossary.ts";

const ROOT = join(import.meta.dirname, "..");
/** What a person reads: the dashboard, and the CLI files whose strings are printed. */
export const SCANNED = [
  "packages/cli/ui/app.js", "packages/cli/ui/index.html",
  ...["main.ts", "compare.ts", "coverage_cli.ts", "glossary_cli.ts", "explain.ts", "explain_run.ts", "graduate.ts", "ci.ts", "run.ts", "calibrate.ts"].map((f) => `packages/cli/src/${f}`),
];

export interface Literal { text: string; line: number }
/** String and template literals with their line, skipping comments and regex literals. Template ${…} parts are dropped. */
export function literals(src: string): Literal[] {
  const out: Literal[] = []; let i = 0; let line = 1; let prev = "";
  const at = (j: number) => src[j] ?? "";
  while (i < src.length) {
    const c = src[i]!;
    if (c === "\n") { line++; i++; continue; }
    if (c === "/" && at(i + 1) === "/") { while (i < src.length && src[i] !== "\n") i++; continue; }
    if (c === "/" && at(i + 1) === "*") { const j = src.indexOf("*/", i + 2); const end = j < 0 ? src.length : j + 2; line += (src.slice(i, end).match(/\n/g) ?? []).length; i = end; continue; }
    if (c === "/" && /^$|[(,=:[!&|?{};+\-*%<>~^]$/.test(prev)) { // a regex literal
      i++; let cls = false; while (i < src.length && src[i] !== "\n") { const d = src[i]!; if (d === "\\") { i += 2; continue; } if (d === "[") cls = true; else if (d === "]") cls = false; else if (d === "/" && !cls) { i++; break; } i++; }
      while (/[a-z]/i.test(at(i))) i++; prev = "x"; continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      const start = line; let text = ""; i++; let depth = 0;
      while (i < src.length) {
        const d = src[i]!;
        if (d === "\\") { text += at(i + 1); i += 2; continue; }
        if (d === "\n") line++;
        if (c === "`" && d === "$" && at(i + 1) === "{" && depth === 0) { depth = 1; i += 2; text += " "; continue; }
        if (depth) { if (d === "{") depth++; else if (d === "}") depth--; i++; continue; }
        if (d === c) { i++; break; }
        text += d; i++;
      }
      out.push({ text, line: start }); prev = "x"; continue;
    }
    if (!/\s/.test(c)) prev = c;
    i++;
  }
  return out;
}

export interface Hit { file: string; line: number; word: string; text: string }
export function lintTerms(files = SCANNED): Hit[] {
  const known = new Set(pluginEntries().flatMap((e) => [e.id, e.term, ...(e.aliases ?? [])].map((x) => x.toLowerCase())));
  const jargon = (parseYaml(readFileSync(join(ROOT, "plugin", "glossary", "jargon.yaml"), "utf8")) as string[]).map((w) => w.toLowerCase()).filter((w) => !known.has(w));
  const res = jargon.map((w) => ({ w, re: new RegExp(`(^|[^a-z0-9_-])${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^a-z0-9_])`, "i") }));
  const hits: Hit[] = [];
  for (const file of files) {
    const src = readFileSync(isAbsolute(file) ? file : join(ROOT, file), "utf8");
    const texts = file.endsWith(".html") ? src.split("\n").map((t, n) => ({ text: t.replace(/<[^>]*>/g, " "), line: n + 1 })) : literals(src);
    for (const t of texts) {
      if (/^[a-z0-9_.:/#?=&-]*$/i.test(t.text.replace(/\s+/g, ""))) continue; // an identifier, a path or an enum value, not prose
      // A multi-line literal (the CLI help) reports the line the word is on, not the line the literal starts on.
      t.text.split("\n").forEach((part, k) => { for (const { w, re } of res) if (re.test(part)) hits.push({ file, line: t.line + k, word: w, text: part.trim().slice(0, 80) }); });
    }
  }
  return hits;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const hits = lintTerms();
  for (const h of hits) process.stderr.write(`${h.file}:${h.line}: "${h.word}" has no glossary entry: ${h.text}\n`);
  if (hits.length) { process.stderr.write(`\n${hits.length} unexplained term${hits.length > 1 ? "s" : ""}. Add an entry to plugin/glossary/terms.yaml (or an alias), or reword.\n`); process.exitCode = 1; }
  else process.stdout.write(`lint:terms: ${SCANNED.length} files, no unexplained jargon (${relative(ROOT, join(ROOT, "plugin", "glossary", "jargon.yaml"))})\n`);
}
