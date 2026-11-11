// The dashboard's writes as commands. Each one is a thin call into the same App method (or route function) the HTTP
// route uses, so validation, side effects (a judge going stale) and the Pending changes tray behave identically.
// tests/parity.test.ts holds the table of routes to commands and fails when a write route has no entry.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { App, HttpError, type Reply } from "./server/app.ts";
import { dispute, setTriage } from "./server/transcripts.ts";
import { prefsRoute, putPrefsRoute } from "./server/prefs.ts";
import { commentRoute, promoteTrace, setExpectedFlip } from "./server/promote.ts";

type Obj = Record<string, unknown>;
interface Args { values: Map<string, string[]>; flags: Set<string>; positional: string[]; one: (k: string) => string | undefined }

class Usage extends Error {}

function parse(rest: string[], valued: string[], bool: string[] = []): Args {
  const values = new Map<string, string[]>(); const flags = new Set<string>(); const positional: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (bool.includes(a)) { flags.add(a); continue; }
    if (valued.includes(a)) { const v = rest[++i]; if (v === undefined) throw new Usage(`${a} needs a value`); values.set(a, [...(values.get(a) ?? []), v]); continue; }
    if (a.startsWith("--")) throw new Usage(`unknown flag ${a}`);
    positional.push(a);
  }
  return { values, flags, positional, one: (k) => values.get(k)?.at(-1) };
}

const out = (s: string) => process.stdout.write(s + "\n");
const err = (s: string) => process.stderr.write(s + "\n");
const today = () => new Date().toISOString().slice(0, 10);
const open = (a: Args) => new App(a.one("--dir") ?? "evals");
function who(app: App): string { try { return app.git.run(["config", "user.name"]).trim(); } catch { return ""; } }

/** Print a Reply the way every write command does: what was saved and where, or the refusal with its problems. */
function report(cmd: string, r: Reply, ok: (body: Obj) => string, json = false): number {
  const body = (r.body ?? {}) as Obj;
  if (json) { out(JSON.stringify(body, null, 2)); return r.status === 200 ? 0 : 1; }
  const problems = (body.problems as { level?: string; file?: string; message: string }[] | undefined) ?? [];
  if (r.status !== 200) {
    err(`${cmd}: ${String(body.message ?? `refused (${r.status})`)}`);
    for (const p of problems) err(`  ${p.file ? p.file + ": " : ""}${p.message}`);
    if (body.command) err(`  run it yourself: ${String(body.command)}`);
    return 1;
  }
  out(ok(body));
  for (const s of (body.side_effects as string[] | undefined) ?? []) out(`  also changed ${s}`);
  for (const p of problems) out(`  ${String(p.level ?? "note").padEnd(7)} ${p.message}`);
  return 0;
}
const saved = (b: Obj) => `saved ${String(b.path)} (pending on ${String(b.branch)})`;

/** Labelling is a person's judgement (CLAUDE.md rule 2). Without a terminal the command needs a named annotator. */
function annotatorFor(cmd: string, a: Args, app: App): string | null {
  const named = a.one("--annotator");
  if (named) return named;
  if (!process.stdin.isTTY) { err(`${cmd}: a label is a person's judgement. Run this from a terminal, or pass --annotator <name> to say who decided. Skills and agents never label.`); return null; }
  const name = who(app);
  if (!name) { err(`${cmd}: no annotator: pass --annotator <name> or set git config user.name`); return null; }
  return name;
}

function verdictOf(v: string | undefined): "Pass" | "Fail" | null { const x = String(v ?? "").toLowerCase(); return x === "pass" ? "Pass" : x === "fail" ? "Fail" : null; }

/** The newest review batch that holds the trace, so a label from the terminal lands in the file the review queue would use. */
function batchOf(app: App, trace: string): string | undefined {
  const dir = join(app.evalsDir, "batches"); if (!existsSync(dir)) return undefined;
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".yaml")).sort().reverse()) {
    try { const b = parseYaml(readFileSync(join(dir, f), "utf8")) as Obj; if (((b.items as Obj[]) ?? []).some((i) => i.trace_id === trace)) return f.replace(/\.yaml$/, ""); } catch { /* reported by validate */ }
  }
  return undefined;
}

function runLabel(rest: string[]): number {
  const a = parse(rest, ["--dir", "--mode", "--note", "--batch", "--annotator"], ["--json"]);
  const [trace, v] = a.positional; const label = verdictOf(v);
  if (!trace || !label) throw new Usage("usage: litmustest label <trace> pass|fail [--mode m]... [--note s] [--batch b] [--annotator name]");
  const modes = a.values.get("--mode") ?? [];
  if (modes.length && label === "Pass") throw new Usage("--mode names what went wrong; it goes with fail");
  const app = open(a);
  const annotator = annotatorFor("label", a, app); if (!annotator) return 2;
  for (const m of modes) if (!existsSync(join(app.evalsDir, "failure_modes", `${m}.yaml`))) { err(`label: failure mode '${m}' does not exist; create it with litmustest mode new`); return 1; }
  const batch = a.one("--batch") ?? batchOf(app, trace) ?? "cli";
  const base: Obj = { trace_id: trace, annotator, ...(a.one("--note") ? { note: a.one("--note") } : {}) };
  // The same lines the review queue posts: one overall verdict, then one Fail per failure mode chosen.
  const lines: Obj[] = [{ ...base, failure_mode: "overall", label }, ...modes.map((m) => ({ ...base, failure_mode: m, label: "Fail" }))];
  const written: Obj[] = [];
  for (const l of lines) {
    const r = app.appendLabel(batch, l);
    if (r.status !== 200) return report("label", r, () => "", a.flags.has("--json"));
    written.push((r.body as Obj).label as Obj);
  }
  if (a.flags.has("--json")) { out(JSON.stringify({ path: `labels/${batch}.jsonl`, labels: written }, null, 2)); return 0; }
  out(`appended ${written.length} label${written.length > 1 ? "s" : ""} to labels/${batch}.jsonl as ${annotator}: ${trace} ${label}${modes.length ? ` (${modes.join(", ")})` : ""}`);
  return 0;
}

function trialArgs(a: Args, usage: string): { run: string; task: string; n: number; rest: string[] } {
  const [run, task, n, ...more] = a.positional;
  if (!run || !task || !/^\d+$/.test(n ?? "")) throw new Usage(usage);
  return { run, task, n: Number(n), rest: more };
}

function runTriage(rest: string[]): number {
  const a = parse(rest, ["--dir", "--note", "--by"], ["--json"]);
  const t = trialArgs(a, "usage: litmustest triage <run> <task> <n> agent|grader|task|infra [--note s] [--by name]");
  const app = open(a);
  const r = setTriage(app, t.run, t.task, t.n, { verdict: t.rest[0], note: a.one("--note"), by: a.one("--by") ?? (who(app) || "cli") });
  return report("triage", r, (b) => `${t.task} trial ${t.n} of ${t.run}: ${t.rest[0]}. ${saved(b)}`, a.flags.has("--json"));
}

function runDispute(rest: string[]): number {
  const a = parse(rest, ["--dir", "--note", "--annotator"], ["--json"]);
  const usage = "usage: litmustest dispute <run> <task> <n> <check> pass|fail [--note s] [--annotator name]";
  const t = trialArgs(a, usage); const [check, v] = t.rest; const label = verdictOf(v);
  if (!check || !label) throw new Usage(usage);
  const app = open(a);
  const annotator = annotatorFor("dispute", a, app); if (!annotator) return 2;
  const r = dispute(app, t.run, t.task, t.n, { check, label, note: a.one("--note"), annotator });
  return report("dispute", r, (b) => `disputed ${check} on ${t.task} trial ${t.n}: ${label} for ${String(b.failure_mode)} as ${annotator}. Trace ${String(b.trace_id)} and ${String(b.path)} are pending; recalibrate the judge once the labels are committed.`, a.flags.has("--json"));
}

function runMode(rest: string[]): number {
  const a = parse(rest, ["--dir", "--definition", "--severity", "--owner"], ["--json"]);
  const [sub, name, into] = a.positional;
  const usage = "usage: litmustest mode new <name> --definition s --severity high|med|low [--owner o] | mode set <name> [--definition s] [--severity x] [--owner o] | mode merge <name> <into> | mode retire <name>";
  if (!sub || !name || !["new", "set", "merge", "retire"].includes(sub)) throw new Usage(usage);
  const app = open(a); const path = `failure_modes/${name}.yaml`; const exists = existsSync(join(app.evalsDir, path));
  const json = a.flags.has("--json");
  if (sub === "new") {
    if (exists) { err(`mode: ${path} already exists; use litmustest mode set`); return 1; }
    if (!a.one("--definition") || !a.one("--severity")) throw new Usage("mode new needs --definition and --severity");
    const data: Obj = { name, definition: a.one("--definition"), severity: a.one("--severity"), ...(a.one("--owner") ? { owner: a.one("--owner") } : {}), created: today() };
    return report("mode", app.putFile(path, undefined, undefined, data), saved, json);
  }
  if (!exists) { err(`mode: no failure mode ${name}`); return 1; }
  const cur = app.getFile(path).body as { data: Obj; hash: string };
  const data: Obj = { ...cur.data };
  if (sub === "set") {
    const changes = (["definition", "severity", "owner"] as const).filter((k) => a.one(`--${k}`) !== undefined);
    if (!changes.length) throw new Usage("mode set needs at least one of --definition, --severity, --owner");
    for (const k of changes) data[k] = a.one(`--${k}`);
  } else {
    if (data.retired) { err(`mode: ${name} was already retired on ${String(data.retired)}`); return 1; }
    if (sub === "merge") {
      if (!into) throw new Usage("usage: litmustest mode merge <name> <into>");
      const target = join(app.evalsDir, "failure_modes", `${into}.yaml`);
      if (into === name || !existsSync(target)) { err(`mode: cannot merge into '${into}': no such failure mode`); return 1; }
      if ((parseYaml(readFileSync(target, "utf8")) as Obj).retired) { err(`mode: ${into} is retired; merge into a live mode`); return 1; }
    }
    // Same key order as the Failure modes page writes, so the diff is the same either way.
    data.retired = today(); if (sub === "merge") data.merged_into = into;
  }
  return report("mode", app.putFile(path, undefined, cur.hash, data), (b) => `${sub === "set" ? "saved" : sub === "merge" ? `merged ${name} into ${into}:` : `retired ${name}:`} ${String(b.path)} (pending on ${String(b.branch)})${sub === "set" ? "" : ". Existing labels keep resolving; no new check may reference it."}`, json);
}

/** a.b.0.c = value on a plain object; numeric segments index arrays. */
function setPath(root: Obj, key: string, value: unknown, unset = false): void {
  const parts = key.split("."); let cur: Record<string, unknown> | unknown[] = root;
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i]!; const container = cur as Record<string, unknown>;
    if (container[p] === null || typeof container[p] !== "object") { if (unset) return; container[p] = /^\d+$/.test(parts[i + 1]!) ? [] : {}; }
    cur = container[p] as Record<string, unknown>;
  }
  const last = parts.at(-1)!;
  if (!unset) (cur as Record<string, unknown>)[last] = value;
  else if (Array.isArray(cur)) cur.splice(Number(last), 1);
  else delete (cur as Record<string, unknown>)[last];
}

function runSet(rest: string[]): number {
  const a = parse(rest, ["--dir", "--from", "--unset"], ["--json"]);
  const [path, ...pairs] = a.positional; const from = a.one("--from"); const unset = a.values.get("--unset") ?? [];
  const usage = "usage: litmustest set <path> --from <file|-> | set <path> key=value... [--unset key]...";
  if (!path || (from === undefined) === (pairs.length + unset.length === 0)) throw new Usage(usage);
  const app = open(a); const json = a.flags.has("--json");
  if (from !== undefined) {
    // The whole file, as an editor would save it. No base hash: the person ran the command now, on the file as it is.
    const content = readFileSync(from === "-" ? 0 : from, "utf8");
    return report("set", app.putFile(path, content), saved, json);
  }
  if (!/\.(ya?ml|json)$/.test(path)) throw new Usage("key=value edits work on YAML and JSON files; use --from for anything else");
  const cur = app.getFile(path).body as { data: Obj | null; hash: string; path: string };
  if (cur.data === null || typeof cur.data !== "object" || Array.isArray(cur.data)) { err(`set: ${cur.path} does not parse as an object; fix it with --from`); return 1; }
  const data = structuredClone(cur.data);
  for (const p of pairs) {
    const eq = p.indexOf("="); if (eq < 1) throw new Usage(`'${p}' is not key=value`);
    let value: unknown; try { value = parseYaml(p.slice(eq + 1)); } catch { value = p.slice(eq + 1); }
    setPath(data, p.slice(0, eq), value);
  }
  for (const k of unset) setPath(data, k, undefined, true);
  return report("set", app.putFile(path, undefined, cur.hash, data), saved, json);
}

function runPending(rest: string[]): number {
  const a = parse(rest, ["--dir", "--message", "--slug", "--title", "--body"], ["--json", "--diff", "--all"]);
  const [sub = "status", ...paths] = a.positional; const json = a.flags.has("--json");
  if (!["status", "commit", "pr", "discard"].includes(sub)) throw new Usage("usage: litmustest pending [status|commit|pr|discard]");
  const app = open(a);
  if (sub === "status") {
    const st = app.pendingState().body as { branch: string; commit_branch: string; files: { path: string; status: string; diff: string; affected_views: string[] }[] };
    if (json) { out(JSON.stringify(st, null, 2)); return 0; }
    if (!st.files.length) { out(`nothing pending on ${st.branch}`); return 0; }
    out(`${st.files.length} pending change${st.files.length > 1 ? "s" : ""} on ${st.branch}; a commit lands on ${st.commit_branch}`);
    for (const f of st.files) { out(`  ${f.status.padEnd(9)} ${f.path}${f.affected_views.length ? `  (${f.affected_views.join(", ")})` : ""}`); if (a.flags.has("--diff")) out(f.diff); }
    return 0;
  }
  if (sub === "commit") return report("pending", app.commit(a.one("--message"), a.one("--slug")), (b) => `committed ${(b.files as string[]).length} file${(b.files as string[]).length > 1 ? "s" : ""} to ${String(b.branch)} at ${String(b.commit)}: ${String(b.message)}`, json);
  if (sub === "pr") return report("pending", app.openPr(a.one("--title"), a.one("--body")), (b) => `opened ${String(b.url)} from ${String(b.branch)}`, json);
  if (!paths.length && !a.flags.has("--all")) throw new Usage("pending discard throws work away: name the paths, or pass --all");
  return report("pending", app.discard(paths.length ? paths : undefined), (b) => `discarded ${(b.discarded as string[]).join(", ")}`, json);
}

function runPrefs(rest: string[]): number {
  const a = parse(rest, ["--dir"], ["--json"]);
  const app = open(a); const patch: Obj = {};
  for (const p of a.positional) { const [k, v] = p.split("="); if (!k || (v !== "true" && v !== "false")) throw new Usage(`'${p}' is not key=true or key=false`); patch[k] = v === "true"; }
  const r = a.positional.length ? putPrefsRoute(app, patch) : prefsRoute(app);
  return report("prefs", r, (b) => `${Object.entries(b).filter(([k]) => k !== "path").map(([k, v]) => `${k}: ${String(v)}`).join("\n")}\n(${String(b.path)}; yours, never in evals/)`, a.flags.has("--json"));
}

function runPromote(rest: string[]): number {
  const a = parse(rest, ["--dir", "--suite", "--id"], ["--json"]);
  const [trace] = a.positional; if (!trace) throw new Usage("usage: litmustest promote <trace> [--suite regression] [--id task_id]");
  const r = promoteTrace(open(a), trace, { ...(a.one("--suite") ? { suite: a.one("--suite") } : {}), ...(a.one("--id") ? { id: a.one("--id") } : {}) });
  return report("promote", r, (b) => {
    const files = (b.files as { path: string }[]).map((f) => f.path); const probs = (b.reference_problems as string[]) ?? []; const ungraded = (b.ungraded_modes as string[]) ?? [];
    return [`promoted ${trace} to task ${String(b.task)} in ${String(b.suite)} (pending on ${String(b.branch)}): ${files.join(", ")}`,
      `  checks: ${(b.checks as string[]).join(", ")}`,
      ...ungraded.map((m) => `  no grader yet for ${m}: draft one with litmustest draft-judge ${m} or draft-check ${m}`),
      ...(probs.length ? ["  the reference was drafted from what the agent did and does not pass its own checks yet; edit it to what the agent should have done:", ...probs.map((p) => `    ${p}`)] : ["  the drafted reference passes its checks"])].join("\n");
  }, a.flags.has("--json"));
}

function runFlip(rest: string[]): number {
  const a = parse(rest, ["--dir", "--note", "--by"], ["--json", "--expected", "--undo"]);
  const [runA, runB, task] = a.positional;
  if (!runA || !runB || !task || a.flags.has("--expected") === a.flags.has("--undo")) throw new Usage("usage: litmustest flip <A> <B> <task> --expected [--note s] [--by name] | flip <A> <B> <task> --undo");
  const app = open(a);
  const r = setExpectedFlip(app, { a: runA, b: runB, task, expected: a.flags.has("--expected"), note: a.one("--note"), by: a.one("--by") ?? (who(app) || "cli") });
  return report("flip", r, (b) => `${task} between ${runA} and ${runB}: ${a.flags.has("--expected") ? "marked expected" : "no longer marked expected"}. ${saved(b)}. An expected flip explains a change; it does not waive a gate.`, a.flags.has("--json"));
}

/** compare A B --comment [--pr N]: post the comparison to the pull request, as the Run compare page's button does. */
export function postComparison(evalsDir: string, a: string, b: string, pr?: string): number {
  return report("compare", commentRoute(new App(evalsDir), { a, b, ...(pr ? { pr } : {}) }), (body) => `posted the comparison of ${a} and ${b} on pull request ${String(body.pr)}`);
}

/** discover --apply [--only a,b]: save the proposed failure-mode files through the validated write, one line per file. */
export function applyProposals(app: App, proposals: { path: string; content: string }[], only?: string[]): string[] {
  const nameOf = (path: string) => path.replace(/^.*\//, "").replace(/\.yaml$/, ""); const lines: string[] = [];
  for (const o of only ?? []) if (!proposals.some((p) => nameOf(p.path) === o)) lines.push(`--only ${o}: not among the proposals`);
  for (const p of proposals) {
    if (only && !only.includes(nameOf(p.path))) { lines.push(`skipped ${p.path}`); continue; }
    const res = app.putFile(p.path, p.content);
    lines.push(`${res.status === 200 ? "saved  " : "refused"} ${p.path}${res.status !== 200 ? `: ${(res.body as { message: string }).message}` : ""}`);
  }
  return lines;
}

const COMMANDS: Record<string, (rest: string[]) => number> = { label: runLabel, triage: runTriage, dispute: runDispute, mode: runMode, set: runSet, pending: runPending, prefs: runPrefs, promote: runPromote, flip: runFlip };

/** Run a write command; undefined when `cmd` is not one of them. Exit 2 is a usage error, 1 a refused write. */
export function writeCommand(cmd: string, rest: string[]): number | undefined {
  const fn = COMMANDS[cmd]; if (!fn) return undefined;
  try { return fn(rest); }
  catch (e) {
    if (e instanceof Usage) { err(`${cmd}: ${e.message}`); return 2; }
    if (e instanceof HttpError) { err(`${cmd}: ${e.message}`); return 1; }
    err(`${cmd}: ${(e as Error).message}`); return 1;
  }
}
