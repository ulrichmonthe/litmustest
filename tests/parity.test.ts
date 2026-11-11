// "If something works in the dashboard but not the CLI, that is a bug" (CLAUDE.md). Two checks:
// 1. every write route in serve.ts has a row in ROUTES below naming its command, and that command is in --help;
// 2. the same action done over HTTP in one copy of a repo and from the CLI in another leaves the same files changed
//    with the same content (timestamps aside), because both call the same App method.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { run } from "../packages/cli/src/run.ts";
import { serve, type Running } from "../packages/cli/src/serve.ts";
import { App } from "../packages/cli/src/server/app.ts";
import { applyProposals } from "../packages/cli/src/write_cli.ts";
vi.setConfig({ testTimeout: 120_000 });

const ROOT = join(import.meta.dirname, "..");
const MAIN = join(ROOT, "packages", "cli", "src", "main.ts");
const EXAMPLE = join(ROOT, "examples", "support-agent", "evals");
const FAKE = join(import.meta.dirname, "fixtures", "agents", "fake_agent.mjs");

/** Every PUT and POST route of the local server, and the command that does the same thing. `flags` must be in --help.
 *  A route added to serve.ts without a row here fails the first test: add the command, then the row. */
const ROUTES: Record<string, { cli: string; flags?: string[] }> = {
  "PUT /api/prefs": { cli: "prefs" },
  "POST /api/glossary/here": { cli: "explain" }, // a read with a body: what a term means here
  "POST /api/graduate": { cli: "graduate", flags: ["--apply", "--only"] },
  "POST /api/transcripts/:run/:task/:n/triage": { cli: "triage", flags: ["--note", "--by"] },
  "POST /api/transcripts/:run/:task/:n/explain": { cli: "explain", flags: ["--run", "--task", "--all"] },
  "POST /api/transcripts/:run/:task/:n/dispute": { cli: "dispute", flags: ["--note", "--annotator"] },
  "POST /api/discover": { cli: "discover", flags: ["--batch", "--apply", "--only"] },
  "POST /api/judges/:name/calibrate": { cli: "calibrate", flags: ["--split", "--force"] },
  "POST /api/judges/:name/draft": { cli: "draft-judge" },
  "POST /api/checks/:name/draft": { cli: "draft-check" },
  "PUT /api/file": { cli: "set", flags: ["--from", "--unset"] },
  "POST /api/labels": { cli: "label", flags: ["--mode", "--note", "--batch", "--annotator"] },
  "POST /api/pending/commit": { cli: "pending", flags: ["--message", "--slug"] },
  "POST /api/pending/pr": { cli: "pending", flags: ["--title", "--body"] },
  "POST /api/pending/discard": { cli: "pending", flags: ["--all"] },
};

/** The write routes as serve.ts declares them: `path === "/api/x" && req.method === "POST"` and the regex form. */
function writeRoutes(): string[] {
  const src = readFileSync(join(ROOT, "packages", "cli", "src", "serve.ts"), "utf8"); const out: string[] = [];
  for (const m of src.matchAll(/path === "(\/api\/[^"]+)" && req\.method === "(PUT|POST|PATCH|DELETE)"/g)) out.push(`${m[2]} ${m[1]}`);
  for (const m of src.matchAll(/= \/\^(\\\/api\\\/[^$]+)\$\/\.exec\(path\)\) && req\.method === "(PUT|POST|PATCH|DELETE)"/g)) {
    const names = m[1]!.startsWith("\\/api\\/transcripts") ? [":run", ":task", ":n"] : [":name"]; let i = 0;
    out.push(`${m[2]} ${m[1]!.replace(/\\\//g, "/").replace(/\(\[\^\/\]\+\)|\(\\d\+\)/g, () => names[i++] ?? ":x")}`);
  }
  return out;
}

const help = execFileSync(process.execPath, [MAIN, "--help"], { encoding: "utf8" });
const usage = new Map<string, Set<string>>();
for (const m of help.matchAll(/^ {2}litmustest ([a-z-]+)(.*)$/gm)) usage.set(m[1]!, new Set([...(usage.get(m[1]!) ?? []), ...[...m[2]!.matchAll(/--[a-z-]+/g)].map((f) => f[0])]));

describe("route to command table", () => {
  it("finds the write routes in serve.ts", () => { const r = writeRoutes(); expect(r.length).toBeGreaterThanOrEqual(15); expect(r).toContain("POST /api/transcripts/:run/:task/:n/triage"); expect(r).toContain("PUT /api/file"); });
  it("has a command for every write route", () => { expect(writeRoutes().filter((r) => !ROUTES[r])).toEqual([]); });
  it("names no route that is gone", () => { const live = new Set(writeRoutes()); expect(Object.keys(ROUTES).filter((r) => !live.has(r))).toEqual([]); });
  it.each(Object.entries(ROUTES))("%s -> a command and flags that --help lists", (_route, { cli, flags }) => {
    expect(usage.has(cli), `litmustest ${cli}`).toBe(true);
    expect((flags ?? []).filter((f) => !usage.get(cli)!.has(f))).toEqual([]);
  });
});

// ---- the same action, both ways
const git = (cwd: string, ...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd, encoding: "utf8" }).trim();
let viaHttp: string; let viaCli: string; let srv: Running;
const api = async (path: string, method: string, body: unknown) => { const r = await fetch(srv.url + path, { method, body: JSON.stringify(body), headers: { "content-type": "application/json" } }); return { status: r.status, body: await r.json() }; };
const cli = (repo: string, ...args: string[]) => { const r = spawnSync(process.execPath, [MAIN, ...args, "--dir", join(repo, "evals")], { encoding: "utf8", input: "", cwd: repo }); return { code: r.status, out: r.stdout, err: r.stderr }; };
/** Every uncommitted file under the repo with its content, timestamps and dates blanked. */
function changed(repo: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of git(repo, "status", "--porcelain", "--untracked-files=all").split("\n").filter(Boolean)) {
    const rel = line.slice(3).trim(); const abs = join(repo, rel);
    out[rel] = existsSync(abs) ? readFileSync(abs, "utf8").replace(/\d{4}-\d\d-\d\d(T[\d:.]+Z)?/g, "<when>") : "<deleted>";
  }
  return out;
}
const same = () => { const h = changed(viaHttp); expect(Object.keys(h).length).toBeGreaterThan(0); expect(changed(viaCli)).toEqual(h); };

beforeAll(async () => {
  const seed = mkdtempSync(join(tmpdir(), "litmustest-parity-")); const evals = join(seed, "evals");
  cpSync(EXAMPLE, evals, { recursive: true });
  for (const f of readdirSync(join(evals, "runs"))) execFileSync("rm", [join(evals, "runs", f)]);
  writeFileSync(join(evals, "litmustest.yaml"), readFileSync(join(evals, "litmustest.yaml"), "utf8").replace(/command: .*\n(\s+\{trial_dir\}\n)?/, `command: node ${FAKE}\n`));
  writeFileSync(join(seed, ".gitignore"), ".litmustest/\n");
  const judge = async () => JSON.stringify({ critique: "tone fits", result: "Pass" });
  for (const id of ["p1", "p2", "p3"]) await run({ evalsDir: evals, tasks: ["vat_invoice_business", "vat_invoice_frustrated", "duplicate_charge_business", "refund_ghost_account_frustrated"], trials: 1, judgeAsk: judge, runId: `run_${id}` });
  // Two identical repos, transcripts included: one driven over HTTP, one from the terminal.
  viaHttp = mkdtempSync(join(tmpdir(), "litmustest-parity-http-")); viaCli = mkdtempSync(join(tmpdir(), "litmustest-parity-cli-"));
  for (const r of [viaHttp, viaCli]) { cpSync(seed, r, { recursive: true }); git(r, "init", "-q", "-b", "main"); git(r, "config", "user.name", "t"); git(r, "config", "user.email", "t@t"); git(r, "add", "-A"); git(r, "commit", "-q", "-m", "seed"); }
  srv = await serve({ evalsDir: join(viaHttp, "evals"), port: 0, watch: false });
});
afterAll(async () => { await srv.close(); });

describe("the same write from the dashboard and from the terminal", () => {
  it("label: one overall line and one Fail per failure mode", async () => {
    const base = { batch: "2026-10-22", trace_id: "tr_0300", annotator: "ulrich", note: "curt reply" };
    expect((await api("/api/labels", "POST", { ...base, failure_mode: "overall", label: "Fail" })).status).toBe(200);
    expect((await api("/api/labels", "POST", { ...base, failure_mode: "tone_mismatch", label: "Fail" })).status).toBe(200);
    const r = cli(viaCli, "label", "tr_0300", "fail", "--mode", "tone_mismatch", "--note", "curt reply", "--annotator", "ulrich", "--batch", "2026-10-22");
    expect(r.code, r.err).toBe(0); expect(r.out).toMatch(/appended 2 labels to labels\/2026-10-22\.jsonl as ulrich/);
    same();
    // With no --batch the label lands in the newest batch that holds the trace, the file the review queue would use.
    const item = (readFileSync(join(viaCli, "evals", "batches", "2026-10-27.yaml"), "utf8").match(/trace_id: (\S+)/) ?? [])[1]!;
    expect((await api("/api/labels", "POST", { batch: "2026-10-27", trace_id: item, annotator: "ulrich", failure_mode: "overall", label: "Pass" })).status).toBe(200);
    expect(cli(viaCli, "label", item, "pass", "--annotator", "ulrich").out).toMatch(/labels\/2026-10-27\.jsonl/);
    same();
  });
  it("triage: the verdict lands in the run summary", async () => {
    expect((await api("/api/transcripts/run_p3/refund_ghost_account_frustrated/1/triage", "POST", { verdict: "task", note: "ambiguous", by: "t" })).status).toBe(200);
    const r = cli(viaCli, "triage", "run_p3", "refund_ghost_account_frustrated", "1", "task", "--note", "ambiguous");
    expect(r.code, r.err).toBe(0); expect(r.out).toMatch(/saved runs\/run_p3\.json/);
    same();
    expect(cli(viaCli, "triage", "run_p3", "refund_ghost_account_frustrated", "1", "weather").code).toBe(1);
  });
  it("dispute: the trial becomes a trace and the label is appended for the judge's failure mode", async () => {
    expect((await api("/api/transcripts/run_p3/duplicate_charge_business/1/dispute", "POST", { check: "tone", label: "Fail", note: "breezy", annotator: "ulrich" })).status).toBe(200);
    const r = cli(viaCli, "dispute", "run_p3", "duplicate_charge_business", "1", "tone", "fail", "--note", "breezy", "--annotator", "ulrich");
    expect(r.code, r.err).toBe(0); expect(r.out).toMatch(/tone_mismatch as ulrich/);
    same();
    expect(cli(viaCli, "dispute", "run_p3", "duplicate_charge_business", "1", "end_state", "pass", "--annotator", "u").code).toBe(1);
  });
  it("failure modes: new, set, merge and retire", async () => {
    const put = (name: string, data: unknown) => api("/api/file", "PUT", { path: `failure_modes/${name}.yaml`, data });
    const get = async (name: string) => (await (await fetch(`${srv.url}/api/file?path=failure_modes/${name}.yaml`)).json()).data;
    const today = new Date().toISOString().slice(0, 10);
    expect((await put("slow_reply", { name: "slow_reply", definition: "The agent takes more turns than the request needs.", severity: "low", owner: "support", created: today })).status).toBe(200);
    expect((await put("slow_reply", { ...(await get("slow_reply")), severity: "med" })).status).toBe(200);
    expect((await put("slow_reply", { ...(await get("slow_reply")), retired: today, merged_into: "over_searching" })).status).toBe(200);
    expect((await put("old_mode", { name: "old_mode", definition: "A failure mode nobody tracks any more, kept for its labels.", severity: "low", created: today })).status).toBe(200);
    expect((await put("old_mode", { ...(await get("old_mode")), retired: today })).status).toBe(200);
    expect(cli(viaCli, "mode", "new", "slow_reply", "--definition", "The agent takes more turns than the request needs.", "--severity", "low", "--owner", "support").code).toBe(0);
    expect(cli(viaCli, "mode", "set", "slow_reply", "--severity", "med").code).toBe(0);
    expect(cli(viaCli, "mode", "merge", "slow_reply", "over_searching").out).toMatch(/merged slow_reply into over_searching/);
    expect(cli(viaCli, "mode", "new", "old_mode", "--definition", "A failure mode nobody tracks any more, kept for its labels.", "--severity", "low").code).toBe(0);
    expect(cli(viaCli, "mode", "retire", "old_mode").out).toMatch(/retired old_mode/);
    expect(cli(viaCli, "mode", "retire", "old_mode").err).toMatch(/already retired/);
    same();
    const bad = cli(viaCli, "mode", "new", "x_mode", "--definition", "too short", "--severity", "low");
    expect(bad.code).toBe(1); expect(bad.err).toMatch(/definition/); expect(existsSync(join(viaCli, "evals", "failure_modes", "x_mode.yaml"))).toBe(false);
    expect(cli(viaCli, "mode", "merge", "over_searching", "ghost").code).toBe(1);
  });
  it("set: editing a judge's model marks its trusted calibration stale, as the Judges page does", async () => {
    const path = "graders/judges/tone_mismatch/judge.yaml";
    const cur = (await (await fetch(`${srv.url}/api/file?path=${path}`)).json()) as { data: Record<string, unknown>; hash: string };
    const h = await api("/api/file", "PUT", { path, data: { ...cur.data, model: "claude-opus-5-5" }, base_hash: cur.hash });
    expect(h.status).toBe(200); expect(h.body.side_effects).toEqual(["graders/judges/tone_mismatch/calibration.json"]);
    const r = cli(viaCli, "set", path, "model=claude-opus-5-5");
    expect(r.code, r.err).toBe(0); expect(r.out).toMatch(/also changed graders\/judges\/tone_mismatch\/calibration\.json/);
    expect(JSON.parse(readFileSync(join(viaCli, "evals", "graders", "judges", "tone_mismatch", "calibration.json"), "utf8")).status).toBe("stale");
    same();
  });
  it("set: refuses what the server refuses and leaves the disk alone", () => {
    const before = changed(viaCli);
    const direct = cli(viaCli, "set", "graders/judges/tone_mismatch/calibration.json", "status=trusted");
    expect(direct.code).toBe(1); expect(direct.err).toMatch(/litmustest calibrate only/);
    const broken = cli(viaCli, "set", "suites/regression.yaml", "tasks.0=ghost_task");
    expect(broken.code).toBe(1); expect(broken.err).toMatch(/ghost_task/);
    const shape = cli(viaCli, "set", "litmustest.yaml", "runs.trials=many");
    expect(shape.code).toBe(1);
    expect(cli(viaCli, "set", "../outside.yaml", "a=1").code).toBe(1);
    expect(changed(viaCli)).toEqual(before);
  });
  it("set --from saves a whole file, and nested keys and --unset edit one", () => {
    const repo = viaCli; const before = readFileSync(join(repo, "evals", "litmustest.yaml"), "utf8");
    const r = cli(repo, "set", "litmustest.yaml", "runs.trials=3", "explain.plain_language_default=false");
    expect(r.code, r.err).toBe(0);
    const after = readFileSync(join(repo, "evals", "litmustest.yaml"), "utf8"); expect(after).toMatch(/trials: 3/); expect(after).toMatch(/plain_language_default: false/);
    expect(cli(repo, "set", "litmustest.yaml", "--unset", "explain.plain_language_default").code).toBe(0);
    expect(readFileSync(join(repo, "evals", "litmustest.yaml"), "utf8")).not.toMatch(/plain_language_default/);
    const tmp = join(mkdtempSync(join(tmpdir(), "litmustest-from-")), "config.yaml"); writeFileSync(tmp, before);
    expect(cli(repo, "set", "litmustest.yaml", "--from", tmp).code).toBe(0);
    expect(readFileSync(join(repo, "evals", "litmustest.yaml"), "utf8")).toBe(before);
  });
  it("graduate --apply --only moves just the named task", async () => {
    expect((await api("/api/graduate", "POST", { tasks: ["vat_invoice_business"] })).status).toBe(200);
    const r = cli(viaCli, "graduate", "--apply", "--only", "vat_invoice_business,not_a_task");
    expect(r.code, r.err).toBe(0); expect(r.out).toMatch(/moved 1: vat_invoice_business/); expect(r.out).toMatch(/--only not_a_task: not ready to graduate/);
    const moved = changed(viaCli); expect(Object.keys(moved).some((f) => f.includes("vat_invoice_business"))).toBe(true); expect(Object.keys(moved).some((f) => f.includes("vat_invoice_frustrated"))).toBe(false);
    expect(readFileSync(join(viaCli, "evals", "suites", "regression.yaml"), "utf8")).toMatch(/vat_invoice_business/);
    same();
  });
  it("pending: status lists what the tray lists, commit lands on an evals/ branch, discard needs a target", async () => {
    const tray = (await (await fetch(`${srv.url}/api/pending`)).json()) as { files: { path: string; status: string }[] };
    const st = JSON.parse(cli(viaCli, "pending", "status", "--json").out) as { files: { path: string; status: string }[] };
    expect(st.files.map((f) => `${f.status} ${f.path}`)).toEqual(tray.files.map((f) => `${f.status} ${f.path}`));
    expect(cli(viaCli, "pending").out).toMatch(new RegExp(`${st.files.length} pending changes on main; a commit lands on evals/`));
    expect(cli(viaCli, "pending", "discard").code).toBe(2);
    const d = cli(viaCli, "pending", "discard", "failure_modes/old_mode.yaml");
    expect(d.code, d.err).toBe(0); expect(git(viaCli, "status", "--porcelain", "--", "evals/failure_modes/old_mode.yaml")).toBe("");
    const h = await api("/api/pending/discard", "POST", { paths: ["failure_modes/old_mode.yaml"] }); expect(h.status).toBe(200);
    same();
    const hc = await api("/api/pending/commit", "POST", { message: "evals: parity", slug: "parity" }); expect(hc.status).toBe(200);
    const c = cli(viaCli, "pending", "commit", "--message", "evals: parity", "--slug", "parity");
    expect(c.code, c.err).toBe(0); expect(c.out).toMatch(/to evals\/parity at [a-f0-9]{7}/);
    expect(git(viaCli, "rev-parse", "--abbrev-ref", "HEAD")).toBe("evals/parity"); expect(git(viaHttp, "rev-parse", "--abbrev-ref", "HEAD")).toBe("evals/parity");
    expect(git(viaCli, "show", "--stat", "--format=%s", "HEAD")).toBe(git(viaHttp, "show", "--stat", "--format=%s", "HEAD"));
    expect(cli(viaCli, "pending").out).toMatch(/nothing pending on evals\/parity/);
    expect(cli(viaCli, "pending", "commit").code).toBe(1);
    const pr = cli(viaCli, "pending", "pr"); expect(pr.code).toBe(1); expect(pr.err).toMatch(/run it yourself: git push -u origin evals\/parity/);
  });
});

describe("human-only and plumbing", () => {
  it("label and dispute refuse without a terminal unless --annotator says who decided", () => {
    const before = changed(viaCli);
    const l = cli(viaCli, "label", "tr_0287", "fail"); expect(l.code).toBe(2); expect(l.err).toMatch(/person's judgement/);
    const d = cli(viaCli, "dispute", "run_p3", "duplicate_charge_business", "1", "tone", "pass"); expect(d.code).toBe(2); expect(d.err).toMatch(/--annotator/);
    expect(cli(viaCli, "label", "tr_0287", "pass", "--mode", "tone_mismatch", "--annotator", "u").code).toBe(2);
    expect(cli(viaCli, "label", "tr_0287", "fail", "--mode", "ghost_mode", "--annotator", "u").code).toBe(1);
    expect(changed(viaCli)).toEqual(before);
  });
  it("discover --apply --only saves just the named proposals", () => {
    const app = new App(join(viaCli, "evals"));
    const mode = (name: string) => ({ path: `failure_modes/${name}.yaml`, content: `name: ${name}\ndefinition: A proposed failure mode long enough to pass the schema.\nseverity: low\ncreated: 2026-11-01\n` });
    const lines = applyProposals(app, [mode("prop_a"), mode("prop_b")], ["prop_b", "prop_z"]);
    expect(lines).toEqual(["--only prop_z: not among the proposals", "skipped failure_modes/prop_a.yaml", "saved   failure_modes/prop_b.yaml"]);
    expect(existsSync(join(viaCli, "evals", "failure_modes", "prop_a.yaml"))).toBe(false);
    expect(cli(viaCli, "pending", "status").out).toMatch(/added\s+evals\/failure_modes\/prop_b\.yaml/);
  });
  it("prefs reads and writes the person's file, not the repo", () => {
    const home = mkdtempSync(join(tmpdir(), "litmustest-prefs-"));
    const r = spawnSync(process.execPath, [MAIN, "prefs", "plain_language=false", "--json", "--dir", join(viaCli, "evals")], { encoding: "utf8", env: { ...process.env, XDG_CONFIG_HOME: home } });
    expect(r.status, r.stderr).toBe(0); expect(JSON.parse(r.stdout).plain_language).toBe(false);
    expect(JSON.parse(readFileSync(join(home, "litmustest", "prefs.json"), "utf8"))).toEqual({ plain_language: false });
    expect(spawnSync(process.execPath, [MAIN, "prefs", "theme=true", "--dir", join(viaCli, "evals")], { encoding: "utf8", env: { ...process.env, XDG_CONFIG_HOME: home } }).status).toBe(1);
  });
  it("a reader that closes the pipe early is not a crash (litmustest explain | head)", async () => {
    const child = spawn(process.execPath, [MAIN, "explain", "--no-model", "--all", "--dir", EXAMPLE], { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = ""; child.stderr.on("data", (c) => (stderr += c));
    child.stdout.once("data", () => child.stdout.destroy());
    const code = await new Promise<number | null>((r) => child.on("close", r));
    expect(stderr).not.toMatch(/EPIPE/); expect(code).toBe(0);
  });
});
