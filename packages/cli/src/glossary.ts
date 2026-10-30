// The explainer's glossary: loading, the template language, validation and rendering. docs/EXPLAINER.md is the contract.
// An explanation never creates a number: templates print typed facts (glossary_facts.ts) through the formatter their kind requires.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { SOURCES, type Kind } from "./glossary_facts.ts";

type Obj = Record<string, unknown>;
export interface NextStep { when?: string; say: string; link?: string }
export interface HereVariant { source: string; when?: string; template: string; next?: NextStep[] }
export interface Entry { id: string; term: string; aliases?: string[]; short: string; why?: string; good?: string; here?: HereVariant[]; related?: string[]; learn_more?: string; audience?: string[]; origin?: "plugin" | "repo" | "failure_mode" }
export interface GlossaryProblem { id: string; file: string; message: string }

// ---------------- loading

/** The plugin glossary: inside the published package, or plugin/glossary at the repo root in development. */
export function glossaryDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [join(here, "..", "glossary"), join(here, "..", "..", "..", "plugin", "glossary")];
  for (const c of candidates) if (existsSync(join(c, "terms.yaml"))) return c;
  throw new Error(`glossary not found; looked in ${candidates.join(", ")}`);
}
const readEntries = (file: string): Entry[] => { const d = parseYaml(readFileSync(file, "utf8")); return Array.isArray(d) ? (d as Entry[]) : []; };
export function pluginEntries(): Entry[] { return readEntries(join(glossaryDir(), "terms.yaml")).map((e) => ({ ...e, origin: "plugin" as const })); }

/** Plugin terms, the repo's own terms (evals/glossary.yaml) and one term per failure mode, which reuses the `failure_mode` entry's "here". */
export function loadGlossary(evalsDir?: string): Entry[] {
  const plugin = pluginEntries();
  if (!evalsDir) return plugin;
  const repoFile = join(evalsDir, "glossary.yaml");
  const repo = existsSync(repoFile) ? readEntries(repoFile).map((e) => ({ ...e, origin: "repo" as const })) : [];
  const generic = plugin.find((e) => e.id === "failure_mode");
  const modesDir = join(evalsDir, "failure_modes");
  const taken = new Set([...plugin, ...repo].flatMap((e) => [e.id, ...(e.aliases ?? [])].map((x) => x.toLowerCase())));
  const modes: Entry[] = [];
  if (existsSync(modesDir)) for (const f of readdirSync(modesDir).filter((x) => x.endsWith(".yaml")).sort()) {
    let m: Obj; try { m = parseYaml(readFileSync(join(modesDir, f), "utf8")) as Obj; } catch { continue; }
    if (!m?.name || m.retired || taken.has(String(m.name).toLowerCase())) continue;
    modes.push({ id: String(m.name), term: String(m.name), short: String(m.definition ?? "").trim(), why: generic?.why, here: generic?.here, related: ["failure_mode"], learn_more: generic?.learn_more, origin: "failure_mode" });
  }
  return [...plugin, ...repo, ...modes];
}

export function findEntry(entries: Entry[], q: string): Entry | undefined {
  const k = q.trim().toLowerCase();
  return entries.find((e) => e.id.toLowerCase() === k) ?? entries.find((e) => e.term.toLowerCase() === k || (e.aliases ?? []).some((a) => a.toLowerCase() === k));
}

// ---------------- the expression language

type Node =
  | { t: "num"; v: number } | { t: "str"; v: string } | { t: "lit"; v: null | boolean }
  | { t: "path"; v: string } | { t: "un"; op: "-" | "not"; a: Node } | { t: "bin"; op: string; a: Node; b: Node };

function tokenize(src: string): string[] {
  const out: string[] = []; let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (/\s/.test(c)) { i++; continue; }
    const two = src.slice(i, i + 2);
    if (["<=", ">=", "==", "!="].includes(two)) { out.push(two); i += 2; continue; }
    if ("<>+-*()".includes(c)) { out.push(c); i++; continue; }
    if (c === "'" || c === '"') { const j = src.indexOf(c, i + 1); if (j < 0) throw new Error(`unclosed string in "${src}"`); out.push(src.slice(i, j + 1)); i = j + 1; continue; }
    const m = /^(\d+(\.\d+)?|[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*)/.exec(src.slice(i));
    if (!m) throw new Error(`unexpected "${c}" in "${src}"`);
    out.push(m[0]); i += m[0].length;
  }
  return out;
}

export function parseExpr(src: string): Node {
  const toks = tokenize(src); let p = 0;
  const peek = () => toks[p]; const take = () => toks[p++];
  const or = (): Node => { let a = and(); while (peek() === "or") { take(); a = { t: "bin", op: "or", a, b: and() }; } return a; };
  const and = (): Node => { let a = not(); while (peek() === "and") { take(); a = { t: "bin", op: "and", a, b: not() }; } return a; };
  const not = (): Node => (peek() === "not" ? (take(), { t: "un", op: "not", a: not() }) : cmp());
  const cmp = (): Node => { const a = add(); const op = peek(); if (op && ["<", "<=", ">", ">=", "==", "!="].includes(op)) { take(); return { t: "bin", op, a, b: add() }; } return a; };
  const add = (): Node => { let a = mul(); while (peek() === "+" || peek() === "-") { const op = take()!; a = { t: "bin", op, a, b: mul() }; } return a; };
  const mul = (): Node => { let a = unary(); while (peek() === "*") { take(); a = { t: "bin", op: "*", a, b: unary() }; } return a; };
  const unary = (): Node => (peek() === "-" ? (take(), { t: "un", op: "-", a: unary() }) : primary());
  const primary = (): Node => {
    const k = take();
    if (k === undefined) throw new Error(`unexpected end of "${src}"`);
    if (k === "(") { const e = or(); if (take() !== ")") throw new Error(`missing ")" in "${src}"`); return e; }
    if (/^\d/.test(k)) return { t: "num", v: Number(k) };
    if (k[0] === "'" || k[0] === '"') return { t: "str", v: k.slice(1, -1) };
    if (k === "null") return { t: "lit", v: null };
    if (k === "true" || k === "false") return { t: "lit", v: k === "true" };
    if (/^[A-Za-z_]/.test(k) && !["and", "or", "not"].includes(k)) return { t: "path", v: k };
    throw new Error(`unexpected "${k}" in "${src}"`);
  };
  const e = or();
  if (p < toks.length) throw new Error(`unexpected "${toks[p]}" in "${src}"`);
  return e;
}

export function pathsOf(n: Node): string[] {
  if (n.t === "path") return [n.v];
  if (n.t === "un") return pathsOf(n.a);
  if (n.t === "bin") return [...pathsOf(n.a), ...pathsOf(n.b)];
  return [];
}
const isArith = (n: Node): boolean => (n.t === "bin" && ["+", "-", "*"].includes(n.op)) || (n.t === "un" && n.op === "-");

const lookup = (scope: Obj, path: string): unknown => path.split(".").reduce<unknown>((o, k) => (o && typeof o === "object" ? (o as Obj)[k] : undefined), scope);

export function evaluate(n: Node, scope: Obj): unknown {
  switch (n.t) {
    case "num": case "str": case "lit": return n.v;
    case "path": return lookup(scope, n.v) ?? null;
    case "un": { const a = evaluate(n.a, scope); return n.op === "not" ? !a : a === null ? null : -Number(a); }
    case "bin": {
      if (n.op === "and") return Boolean(evaluate(n.a, scope)) && Boolean(evaluate(n.b, scope));
      if (n.op === "or") return Boolean(evaluate(n.a, scope)) || Boolean(evaluate(n.b, scope));
      const a = evaluate(n.a, scope); const b = evaluate(n.b, scope);
      if (n.op === "==") return a === b; if (n.op === "!=") return a !== b;
      if (a === null || b === null) return n.op === "+" || n.op === "-" || n.op === "*" ? null : false;
      const x = Number(a), y = Number(b);
      switch (n.op) { case "+": return x + y; case "-": return x - y; case "*": return x * y; case "<": return x < y; case "<=": return x <= y; case ">": return x > y; case ">=": return x >= y; }
    }
  }
  return null;
}

// ---------------- templates and formatters

interface Part { text?: string; expr?: Node; src?: string; fmt?: string }
export function parseTemplate(tpl: string): Part[] {
  const parts: Part[] = []; let i = 0;
  while (i < tpl.length) {
    const j = tpl.indexOf("{", i);
    if (j < 0) { parts.push({ text: tpl.slice(i) }); break; }
    if (j > i) parts.push({ text: tpl.slice(i, j) });
    const k = tpl.indexOf("}", j);
    if (k < 0) throw new Error(`unclosed "{" in "${tpl}"`);
    const [src, fmt] = tpl.slice(j + 1, k).split("|").map((s) => s.trim());
    parts.push({ expr: parseExpr(src!), src, fmt: fmt || undefined });
    i = k + 1;
  }
  return parts;
}

/** The formatter each kind must use. Kinds without one print as they are. */
export const FORMATTER_FOR: Partial<Record<Kind, string>> = { rate: "pct", interval: "range", percent: "percent", pts: "pts", pts_interval: "prange", points: "points", usd: "usd" };
const num = (v: number) => { const r = Math.round(v * 10) / 10; return Number.isInteger(r) ? String(r) : r.toFixed(1); };
const signed = (v: number) => (v > 0 ? `+${num(v)}` : v < 0 ? `−${num(-v)}` : "0");
export const FORMATTERS: Record<string, (v: unknown) => string> = {
  pct: (v) => `${num(Number(v))}%`,
  percent: (v) => `${num(Number(v))}%`,
  range: (v) => { const c = v as { low: number; high: number }; return `${Math.round(c.low)}–${Math.round(c.high)}%`; },
  pts: (v) => `${signed(Number(v))} pts`,
  prange: (v) => { const c = v as { low: number; high: number }; return `${signed(c.low)} to ${signed(c.high)} pts`; },
  points: (v) => `${num(Number(v))} pts`,
  usd: (v) => `$${Number(v).toFixed(2)}`,
};
const plain = (v: unknown): string => (Array.isArray(v) ? v.join(", ") : typeof v === "number" ? num(v) : String(v));

/** Render one template; null when any placeholder is missing (the caller falls back to the next variant). */
export function renderTemplate(tpl: string, scope: Obj): string | null {
  let out = "";
  for (const p of parseTemplate(tpl)) {
    if (p.text !== undefined) { out += p.text; continue; }
    const v = evaluate(p.expr!, scope);
    if (v === null || v === undefined || (typeof v === "number" && Number.isNaN(v))) return null;
    out += p.fmt ? FORMATTERS[p.fmt]!(v) : plain(v);
  }
  return out.replace(/\s+/g, " ").trim();
}

export interface Rendered { id: string; source: string; text: string; next: { say: string; link?: string } | null }

/** Layer 2: the first variant for this source whose `when` holds and whose placeholders all resolve, with its first matching next step. */
export function renderHere(entry: Entry, source: string, facts: Obj): Rendered | null {
  for (const v of entry.here ?? []) {
    if (v.source !== source) continue;
    if (v.when && !evaluate(parseExpr(v.when), facts)) continue;
    const text = renderTemplate(v.template, facts);
    if (text === null) continue;
    let next: Rendered["next"] = null;
    for (const n of v.next ?? []) {
      if (n.when && !evaluate(parseExpr(n.when), facts)) continue;
      const say = renderTemplate(n.say, facts);
      if (say === null) continue;
      next = { say, link: n.link ? renderTemplate(n.link, facts) ?? undefined : undefined };
      break;
    }
    return { id: entry.id, source, text, next };
  }
  return null;
}

/** `[[id]]` links in short text, as plain words for the CLI. */
export const unlink = (s: string, entries: Entry[]) => s.replace(/\[\[([a-z0-9_]+)\]\]/g, (_, id: string) => entries.find((e) => e.id === id)?.term.toLowerCase() ?? id);

// ---------------- validation

const MAX_SHORT_WORDS = 20;
const CHAPTERS = 25;

/** Every rule in docs/EXPLAINER.md "What the validator enforces". */
export function validateGlossary(entries: Entry[], file = "glossary"): GlossaryProblem[] {
  const out: GlossaryProblem[] = [];
  const add = (id: string, message: string) => out.push({ id, file, message });
  // Keyed by entry, not id: a repo term that reuses a plugin id is a duplicate too.
  const seen = new Map<string, Entry>();
  for (const e of entries) for (const name of new Set([e.id, e.term, ...(e.aliases ?? [])])) {
    const k = name.toLowerCase(); const owner = seen.get(k);
    if (owner && owner !== e) add(e.id, `"${name}" is already used by ${owner.id}${owner.origin && owner.origin !== e.origin ? ` (${owner.origin})` : ""}`);
    else if (!owner) seen.set(k, e);
  }
  const words = entries.map((e) => ({ id: e.id, names: [e.term, ...(e.aliases ?? [])].filter((n) => n.length > 2) }));
  for (const e of entries) {
    if (!/^[a-z][a-z0-9_]*$/.test(e.id)) add(e.id, "id must be snake_case");
    if (!e.term || !e.short) { add(e.id, "needs term and short"); continue; }
    if (e.origin === "failure_mode") continue; // a failure mode's definition is the team's own words
    const shortWords = e.short.replace(/\[\[[a-z0-9_]+\]\]/g, "x").split(/\s+/).filter(Boolean).length;
    if (shortWords > MAX_SHORT_WORDS) add(e.id, `short has ${shortWords} words; at most ${MAX_SHORT_WORDS}`);
    const unlinked = e.short.replace(/\[\[[a-z0-9_]+\]\]/g, " ");
    for (const w of words) {
      if (w.id === e.id) continue;
      for (const n of w.names) if (new RegExp(`(^|[^A-Za-z0-9_^@])${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}s?($|[^A-Za-z0-9_])`, "i").test(unlinked)) { add(e.id, `short uses "${n}" without linking it as [[${w.id}]]`); break; }
    }
    for (const m of e.short.matchAll(/\[\[([a-z0-9_]+)\]\]/g)) if (!entries.some((x) => x.id === m[1])) add(e.id, `short links [[${m[1]}]], which is not a term`);
    for (const r of e.related ?? []) if (!entries.some((x) => x.id === r)) add(e.id, `related "${r}" is not a term`);
    if (e.learn_more !== undefined) { const m = /^master-class#ch-(\d+)$/.exec(e.learn_more); if (!m || Number(m[1]) < 1 || Number(m[1]) > CHAPTERS) add(e.id, `learn_more must be master-class#ch-1 … ch-${CHAPTERS}`); }
    const allowed = new Set((e.good ?? "").match(/\d+(\.\d+)?/g) ?? []);
    const digits = (where: string, text: string) => { for (const p of safeParts(text, (m) => add(e.id, `${where}: ${m}`))) if (p.text) for (const d of p.text.match(/\d+(\.\d+)?/g) ?? []) if (!allowed.has(d)) add(e.id, `${where} types the number ${d}; numbers come from facts (or from "good")`); };
    for (const v of e.here ?? []) {
      const src = SOURCES[v.source];
      if (!src) { add(e.id, `unknown source "${v.source}"`); continue; }
      const where = `here[${v.source}]`;
      const fieldOk = (path: string) => path in src.fields;
      const checkExpr = (label: string, expr: string) => { let n: Node; try { n = parseExpr(expr); } catch (err) { add(e.id, `${label}: ${(err as Error).message}`); return; } for (const p of pathsOf(n)) if (!fieldOk(p)) add(e.id, `${label}: "${p}" is not a fact of ${v.source}`); };
      if (v.when) checkExpr(`${where}.when`, v.when);
      const printed: string[] = [];
      const checkText = (label: string, text: string) => {
        for (const p of safeParts(text, (m) => add(e.id, `${label}: ${m}`))) {
          if (!p.expr) continue;
          for (const path of pathsOf(p.expr)) if (!fieldOk(path)) add(e.id, `${label}: "${path}" is not a fact of ${v.source}`);
          if (p.fmt && !FORMATTERS[p.fmt]) { add(e.id, `${label}: unknown formatter "${p.fmt}"`); continue; }
          if (isArith(p.expr)) { const kinds = pathsOf(p.expr).map((x) => src.fields[x]); if (kinds.some((k) => k && k !== "count")) add(e.id, `${label}: arithmetic only on counts ("${p.src}")`); if (p.fmt) add(e.id, `${label}: a count needs no formatter ("${p.src}")`); continue; }
          if (p.expr.t !== "path") continue;
          const kind = src.fields[p.expr.v]; if (!kind) continue;
          const want = FORMATTER_FOR[kind];
          if (want && p.fmt !== want) add(e.id, `${label}: ${p.expr.v} is a ${kind}; print it as {${p.expr.v} | ${want}}`);
          if (!want && p.fmt) add(e.id, `${label}: ${p.expr.v} is a ${kind} and takes no formatter`);
          printed.push(p.expr.v);
        }
      };
      checkText(`${where}.template`, v.template); digits(`${where}.template`, v.template);
      for (const p of printed) { const pair = src.intervals?.[p]; if (pair && !printed.includes(pair)) add(e.id, `${where}.template prints ${p} without its interval {${pair} | ${FORMATTER_FOR[src.fields[pair]!]}}`); }
      const next = v.next ?? [];
      next.forEach((n, i) => { const l = `${where}.next[${i}]`; if (n.when) checkExpr(`${l}.when`, n.when); checkText(`${l}.say`, n.say); digits(`${l}.say`, n.say); if (n.link) checkText(`${l}.link`, n.link); });
      if (next.length && next[next.length - 1]!.when) add(e.id, `${where}.next must end with a step that has no "when", so no state is left without a next step`);
    }
  }
  return out;
}
function safeParts(text: string, onError: (m: string) => void): Part[] { try { return parseTemplate(text); } catch (err) { onError((err as Error).message); return []; } }

/** Check the plugin glossary together with a repo's terms; problems in repo terms point at evals/glossary.yaml. */
export function validateRepoGlossary(evalsDir: string): GlossaryProblem[] {
  const all = loadGlossary(evalsDir);
  const pluginIds = new Set(all.filter((e) => e.origin === "plugin").map((e) => e.id));
  return validateGlossary(all, "glossary.yaml").filter((p) => !pluginIds.has(p.id) || p.message.includes("already used"));
}
