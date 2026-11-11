// GET /api/glossary: every term (layer 1). POST /api/glossary/here: rendered "here" sentences (layer 2) for [{id, source, ctx}].
import { factsFor, type Ctx } from "../glossary_facts.ts";
import { findEntry, loadGlossary, renderHere } from "../glossary.ts";
import { labelsFor } from "../calibrate.ts";
import { loadFiles } from "./overview.ts";
import { HttpError, type App, type Reply } from "./app.ts";

type Obj = Record<string, unknown>;
const MAX_ITEMS = 200;

export function glossaryRoute(app: App): Reply {
  const terms = loadGlossary(app.evalsDir).map(({ here, ...e }) => ({ ...e, sources: [...new Set((here ?? []).map((v) => v.source))] }));
  return { status: 200, body: { terms } };
}

/** One facts build per (source, ctx) per request: a page asks for many sentences over the same few sources. */
export function glossaryHereRoute(app: App, body: Obj): Reply {
  const items = (body.items as { id: string; source: string; ctx?: Ctx }[] | undefined) ?? [];
  if (!Array.isArray(items) || items.length > MAX_ITEMS) throw new HttpError(400, `items must be a list of at most ${MAX_ITEMS}`);
  const entries = loadGlossary(app.evalsDir); const f = loadFiles(app.evalsDir); const cache = new Map<string, Obj | null>();
  const out = items.map((it) => {
    const e = findEntry(entries, String(it.id));
    if (!e) return { id: it.id, error: "no such term" };
    const key = `${it.source}|${JSON.stringify(it.ctx ?? {})}`;
    if (!cache.has(key)) cache.set(key, factsFor(app.evalsDir, String(it.source), it.ctx ?? {}, f));
    const facts = cache.get(key);
    const r = facts ? renderHere(e, String(it.source), facts) : null;
    const examples = it.source === "failure_mode" && it.ctx?.mode ? labelExamples(app.evalsDir, String(it.ctx.mode)) : undefined;
    return r ? { id: e.id, source: it.source, here: r.text, next: r.next, examples } : { id: e.id, source: it.source, here: null, next: null, examples };
  });
  return { status: 200, body: { items: out } };
}

/** The review queue's chip popover: the latest Pass and the latest Fail people gave for this failure mode, with their notes. */
function labelExamples(evalsDir: string, mode: string): { pass?: Obj; fail?: Obj } {
  const ls = [...labelsFor(evalsDir, mode).entries()].sort((a, b) => b[1].at.localeCompare(a[1].at));
  const pick = (label: string) => { const x = ls.find(([, l]) => l.label === label && l.note); return x ? { trace_id: x[0], note: x[1].note } : undefined; };
  return { pass: pick("Pass"), fail: pick("Fail") };
}
