// Per-person preferences (docs/stories/explainer.md E4-S1): kept in the user's config directory, never in evals/,
// so one person's Plain language choice is not a repo change. $XDG_CONFIG_HOME/litmustest/prefs.json, else ~/.config.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { parse as parseYaml } from "yaml";
import { HttpError, type App, type Reply } from "./app.ts";

type Obj = Record<string, unknown>;
export interface Prefs { plain_language?: boolean; plain_prompt_seen?: boolean }
const KEYS: Record<keyof Prefs, "boolean"> = { plain_language: "boolean", plain_prompt_seen: "boolean" };

export function prefsPath(): string { return join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "litmustest", "prefs.json"); }
export function readPrefs(file = prefsPath()): Prefs { try { return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Prefs) : {}; } catch { return {}; } }

/** The repo's default for people who have not chosen: explain.plain_language_default, on when unset. */
export function repoPlainDefault(evalsDir: string): boolean {
  try { const c = parseYaml(readFileSync(join(evalsDir, "litmustest.yaml"), "utf8")) as Obj; const v = (c?.explain as Obj | undefined)?.plain_language_default; return typeof v === "boolean" ? v : true; } catch { return true; }
}

/** GET: the person's choices, the repo default and what applies. */
export function prefsRoute(app: App): Reply {
  const p = readPrefs(); const def = repoPlainDefault(app.evalsDir);
  return { status: 200, body: { ...p, plain_language_default: def, plain_language_effective: p.plain_language ?? def, path: prefsPath() } };
}
/** PUT: merge known boolean keys into the prefs file. */
export function putPrefsRoute(app: App, body: Obj): Reply {
  const next: Prefs = { ...readPrefs() };
  for (const [k, v] of Object.entries(body)) {
    if (!(k in KEYS)) throw new HttpError(400, `unknown preference "${k}"`);
    if (typeof v !== "boolean") throw new HttpError(400, `${k} must be true or false`);
    next[k as keyof Prefs] = v;
  }
  const file = prefsPath(); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, JSON.stringify(next, null, 2) + "\n");
  return prefsRoute(app);
}
