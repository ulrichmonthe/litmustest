// The one resolver every surface uses (docs/stories/explainer.md E1-S2): a term plus the current repo state in,
// an explanation out. The server's panel, `litmustest explain`, --plain rows and the PR comment all call this.
import { factsFor, type Ctx } from "../glossary_facts.ts";
import { findEntry, loadGlossary, renderHere, unlink, type Entry } from "../glossary.ts";
import { loadFiles, type Files } from "../server/overview.ts";

export interface Explanation {
  id: string;
  term: string;
  aliases: string[];
  /** Layer 1: what it means. `[[id]]` links are kept for surfaces that link them; `shortPlain` has them as words. */
  short: string;
  shortPlain: string;
  why?: string;
  good?: string;
  /** Layer 2: what it means here. Absent when no source was asked for or its file or a field is missing; never blank. */
  here?: string;
  next?: { say: string; action?: string[]; link?: string };
  learnMore?: { ref: string; chapter: number };
  related: { id: string; term: string }[];
  source?: string;
}

export interface ExplainContext {
  /** The repo's evals/ directory; without it only layer 1 is resolved. */
  evalsDir?: string;
  /** Which read model the "here" sentence comes from, and its context (judge, suite, task…). */
  source?: string;
  ctx?: Ctx;
  /** Loaded once per request by callers that resolve many terms. */
  entries?: Entry[];
  files?: Files;
}

export function explain(termId: string, c: ExplainContext = {}): Explanation | null {
  const entries = c.entries ?? loadGlossary(c.evalsDir);
  const e = findEntry(entries, termId); if (!e) return null;
  const out: Explanation = { id: e.id, term: e.term, aliases: e.aliases ?? [], short: e.short, shortPlain: unlink(e.short, entries), why: e.why, good: e.good, related: (e.related ?? []).map((id) => ({ id, term: entries.find((x) => x.id === id)?.term ?? id })) };
  if (e.learn_more) out.learnMore = { ref: e.learn_more, chapter: Number(e.learn_more.split("ch-")[1]) };
  if (c.evalsDir && c.source) {
    const facts = factsFor(c.evalsDir, c.source, c.ctx ?? {}, c.files ?? loadFiles(c.evalsDir));
    const r = facts ? renderHere(e, c.source, facts) : null;
    if (r) { out.here = r.text; out.source = c.source; if (r.next) out.next = r.next; }
  }
  return out;
}
