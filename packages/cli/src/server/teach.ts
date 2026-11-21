// Teach (docs/stories/redesign.md, R3): the four-step rail's counts, and grouping notes by hand.
// Grouping by hand adds the notes' trace ids to a failure mode's `examples` (or creates the mode with them), through
// App.putFile so the write is validated and lands in Pending changes. The CLI's `mode add-notes` calls the same function.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { gatherNotes } from "../discover.ts";
import { HttpError, type App } from "./app.ts";
import { judgeStatus, loadFiles } from "./overview.ts";

type Obj = Record<string, unknown>;
interface Reply { status: number; body: unknown }
const today = () => new Date().toISOString().slice(0, 10);

/** What each step of the rail shows, from the files. */
export function teachSummary(evalsDir: string): Obj {
  const f = loadFiles(evalsDir);
  const threshold = Number((f.config.judges as Obj | undefined)?.trust_threshold ?? 90);
  const batch = f.batches[f.batches.length - 1];
  const items = (batch?.items as { trace_id: string }[] | undefined) ?? [];
  const labelled = new Set(f.labels.map((l) => String(l.trace_id)));
  const notes = gatherNotes(evalsDir).notes.filter((n) => n.label === "Fail");
  const inMode = new Set(f.modes.flatMap((m) => ((m.examples as string[]) ?? []).map(String)));
  const loose = notes.filter((n) => n.failure_mode === "overall" && !inMode.has(n.trace_id));
  const live = f.modes.filter((m) => !m.retired);
  const judges = f.judges.map((j) => judgeStatus(j, threshold).status);
  return {
    label: { batch: batch?.name ?? null, done: items.filter((i) => labelled.has(i.trace_id)).length, total: items.length },
    group: { notes: notes.length, loose: loose.length },
    modes: { named: live.length },
    judges: { trusted: judges.filter((s) => s === "trusted").length, total: judges.length, stale: judges.filter((s) => s === "stale").length },
  };
}

/** Add traces to a failure mode's examples, creating the mode when `create` is given. One validated write. */
export function addNotes(app: App, body: Obj): Reply {
  const traces = [...new Set(((body.traces as unknown[]) ?? []).map(String).filter(Boolean))];
  if (!traces.length) throw new HttpError(400, "traces must name at least one trace id");
  const create = body.create as Obj | undefined;
  const name = String(create?.name ?? body.mode ?? "");
  if (!/^[a-z][a-z0-9_]*$/.test(name)) throw new HttpError(400, "the failure mode needs a snake_case name");
  const path = `failure_modes/${name}.yaml`; const file = join(app.evalsDir, path);
  if (create) {
    if (existsSync(file)) throw new HttpError(409, `${path} already exists; add the notes to it instead`);
    if (!create.definition) throw new HttpError(400, "a new failure mode needs a definition");
    return app.putFile(path, undefined, undefined, { name, definition: String(create.definition), severity: String(create.severity ?? "med"), examples: traces, created: today() });
  }
  if (!existsSync(file)) throw new HttpError(404, `no failure mode ${name}`);
  const data = parseYaml(readFileSync(file, "utf8")) as Obj;
  if (data.retired) throw new HttpError(400, `${name} is retired; add the notes to the mode it was merged into`);
  const examples = [...new Set([...((data.examples as string[]) ?? []).map(String), ...traces])];
  return app.putFile(path, undefined, undefined, { ...data, examples });
}

/** Every Fail note, newest batch first as gatherNotes reads them, with whether it is already tagged with a failure mode. */
export function notesList(evalsDir: string): Obj {
  const f = loadFiles(evalsDir);
  const inMode = new Map<string, string[]>();
  for (const m of f.modes) for (const t of ((m.examples as string[]) ?? []).map(String)) inMode.set(t, [...(inMode.get(t) ?? []), String(m.name)]);
  const notes = gatherNotes(evalsDir).notes.filter((n) => n.label === "Fail").map((n) => ({ trace_id: n.trace_id, note: n.note, failure_mode: n.failure_mode, tagged: n.failure_mode !== "overall", example_of: inMode.get(n.trace_id) ?? [], excerpt: n.excerpt }));
  return { notes, modes: f.modes.filter((m) => !m.retired).map((m) => ({ name: m.name, severity: m.severity, examples: ((m.examples as unknown[]) ?? []).length, labels: f.labels.filter((l) => l.failure_mode === m.name).length })) };
}
