// GET /api/glossary: every term (layer 1). POST /api/glossary/here: rendered "here" sentences (layer 2) for [{id, source, ctx}].
import { explain } from "../explain/index.ts";
import type { Ctx } from "../glossary_facts.ts";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { loadGlossary, loadPages } from "../glossary.ts";
import { labelsFor } from "../calibrate.ts";
import { loadFiles } from "./overview.ts";
import { HttpError, type App, type Reply } from "./app.ts";

type Obj = Record<string, unknown>;
const MAX_ITEMS = 200;

export function glossaryRoute(app: App): Reply {
  const terms = loadGlossary(app.evalsDir).map(({ here, ...e }) => ({ ...e, sources: [...new Set((here ?? []).map((v) => v.source))] }));
  const cfg = existsSync(join(app.evalsDir, "litmustest.yaml")) ? (parseYaml(readFileSync(join(app.evalsDir, "litmustest.yaml"), "utf8")) as Obj) : {};
  return { status: 200, body: { terms, pages: loadPages(), learn_more_url: (cfg?.explain as Obj | undefined)?.learn_more_url ?? null } };
}

/** One glossary and file load per request: a page asks for many sentences over the same few sources. */
export function glossaryHereRoute(app: App, body: Obj): Reply {
  const items = (body.items as { id: string; source: string; ctx?: Ctx }[] | undefined) ?? [];
  if (!Array.isArray(items) || items.length > MAX_ITEMS) throw new HttpError(400, `items must be a list of at most ${MAX_ITEMS}`);
  const entries = loadGlossary(app.evalsDir); const files = loadFiles(app.evalsDir);
  const out = items.map((it) => {
    const x = explain(String(it.id), { evalsDir: app.evalsDir, source: String(it.source), ctx: it.ctx ?? {}, entries, files });
    if (!x) return { id: it.id, error: "no such term" };
    const examples = it.source === "failure_mode" && it.ctx?.mode ? labelExamples(app.evalsDir, String(it.ctx.mode)) : undefined;
    return { ...x, here: x.here ?? null, next: x.next ?? null, examples };
  });
  return { status: 200, body: { items: out } };
}

/** The review queue's chip popover: the latest Pass and the latest Fail people gave for this failure mode, with their notes. */
function labelExamples(evalsDir: string, mode: string): { pass?: Obj; fail?: Obj } {
  const ls = [...labelsFor(evalsDir, mode).entries()].sort((a, b) => b[1].at.localeCompare(a[1].at));
  const pick = (label: string) => { const x = ls.find(([, l]) => l.label === label && l.note); return x ? { trace_id: x[0], note: x[1].note } : undefined; };
  return { pass: pick("Pass"), fail: pick("Fail") };
}
