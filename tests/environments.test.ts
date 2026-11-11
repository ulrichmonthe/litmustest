// B1: the Environment seam (inprocess, docker, harbor), the budget, and the outcome readers (sql, fs, http).
// docker and harbor are not installed where these run: both are exercised against fake binaries in tests/fixtures/bin.
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { run } from "../packages/cli/src/run.ts";
import { openEnvironment, spawnGroup } from "../packages/cli/src/environments.ts";
import { compareExpect, getPath, OutcomeInfraError, readState, valueAt, type Fetch } from "../packages/cli/src/outcome.ts";
import { loadTrial } from "../packages/cli/src/server/transcripts.ts";
import { validateEvals } from "../packages/cli/src/validate.ts";
import { SchemaSet } from "../packages/cli/src/schemas.ts";
vi.setConfig({ testTimeout: 120_000 });

const EXAMPLE = join(import.meta.dirname, "..", "examples", "support-agent", "evals");
const FAKE = join(import.meta.dirname, "fixtures", "agents", "fake_agent.mjs");
const FORKER = join(import.meta.dirname, "fixtures", "agents", "forker.mjs");
const BIN = join(import.meta.dirname, "fixtures", "bin");
const judge = async () => JSON.stringify({ critique: "fine", result: "Pass" });
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

/** A copy of the example with the fake agent, and `runs:` replaced by what the test needs. */
function fixture(runs: string, command = `node ${FAKE}`): { repo: string; evals: string } {
  const repo = mkdtempSync(join(tmpdir(), "litmustest-env-")); const evals = join(repo, "evals");
  cpSync(EXAMPLE, evals, { recursive: true });
  for (const f of readdirSync(join(evals, "runs"))) execFileSync("rm", [join(evals, "runs", f)]);
  const cfg = readFileSync(join(evals, "litmustest.yaml"), "utf8").replace(/command: .*\n(\s+\{trial_dir\}\n)?/, `command: ${command}\n`).replace(/runs:\n(  .*\n)+?(?=agent:)/, `runs:\n${runs}`);
  writeFileSync(join(evals, "litmustest.yaml"), cfg);
  execFileSync("git", ["init", "-q"], { cwd: repo });
  return { repo, evals };
}
const saved = { ...process.env };
afterEach(() => { for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]; Object.assign(process.env, saved); });

describe("outcome readers", () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "litmustest-out-"));
    const db = new DatabaseSync(join(dir, "app.sqlite")); db.exec("CREATE TABLE refunds (id INTEGER PRIMARY KEY, status TEXT); INSERT INTO refunds (status) VALUES ('pending'), ('processed');"); db.close();
    mkdirSync(join(dir, "out")); writeFileSync(join(dir, "out", "result.json"), JSON.stringify({ rows: [{ id: 7 }], ok: true })); writeFileSync(join(dir, "out", "bad.json"), "{nope");
  });
  it("walks dotted paths with indexes, and looks up a whole expect key first", () => {
    expect(getPath({ a: { b: [{ c: 1 }, { c: 2 }] } }, "a.b[1].c")).toBe(2); expect(getPath({ a: [[1, 2]] }, "a[0][1]")).toBe(2); expect(getPath({ a: 1 }, "a.b")).toBeUndefined();
    expect(valueAt({ "refunds.status": "x", refunds: { status: "y" } }, "refunds.status")).toBe("x"); expect(valueAt({ refunds: { status: "y" } }, "refunds.status")).toBe("y");
    expect(compareExpect({ "a.b": 1, c: [1] }, { a: { b: 2 }, c: [1] })).toEqual([{ path: "a.b", expected: 1, actual: 2 }]);
  });
  it("without read, and for backend page, the state is trial.state", async () => {
    expect(await readState({ backend: "sql", expect: {} }, dir, { state: { a: 1 } })).toEqual({ state: { a: 1 }, reader: "trial" });
    expect((await readState({ backend: "page", expect: {} }, dir, { state: { a: 1 } })).reader).toBe("trial");
  });
  it("sql: one read-only query per expect key; a missing file or a bad query is a failed check with a note", async () => {
    const check = { backend: "sql", read: { file: "app.sqlite", queries: { "refunds.status": "SELECT status FROM refunds ORDER BY id DESC LIMIT 1", "refunds.count": "SELECT COUNT(*) FROM refunds", none: "SELECT status FROM refunds WHERE id = 99", broken: "SELECT nope FROM nowhere" } } };
    const r = await readState(check, dir, { state: { refunds: { status: "lie" } } });
    expect(r.reader).toBe("sql"); expect(r.state).toEqual({ "refunds.status": "processed", "refunds.count": 2, none: null }); expect(r.note).toContain("query for broken failed");
    await expect(readState({ read: { file: "app.sqlite", queries: { x: "DELETE FROM refunds" } } }, dir, {})).resolves.toMatchObject({ note: expect.stringContaining("query for x failed") }); // read-only
    expect((await readState(check, dir, {})).state).toMatchObject({ "refunds.count": 2 });
    expect(await readState({ read: { file: "gone.sqlite", queries: { a: "SELECT 1" } } }, dir, {})).toMatchObject({ state: {}, note: "gone.sqlite is not in the trial directory" });
    await expect(readState({ read: { file: "../app.sqlite", queries: { a: "SELECT 1" } } }, join(dir, "out"), {})).rejects.toThrow(/inside the trial directory/);
    // no trial directory (a reference solution): falls back to the state it carries
    expect(await readState(check, null, { state: { refunds: { status: "processed" } } })).toEqual({ state: { refunds: { status: "processed" } }, reader: "trial" });
  });
  it("fs: a JSON file is the state, or a list of paths is tested for existence", async () => {
    expect((await readState({ backend: "fs", read: { file: "out/result.json" } }, dir, {})).state).toEqual({ rows: [{ id: 7 }], ok: true });
    expect((await readState({ backend: "fs", read: { exists: ["out/result.json", "out/nope.txt"] } }, dir, {})).state).toEqual({ exists: [true, false] });
    expect((await readState({ backend: "fs", read: { file: "out/bad.json" } }, dir, {})).note).toContain("is not JSON");
  });
  it("http: the JSON response is the state; placeholders are filled; the network failing is an infra error, a 4xx is not", async () => {
    const calls: { url: string; headers?: Record<string, string> }[] = [];
    const f = (status: number, body: string): Fetch => async (url, init) => { calls.push({ url, headers: init?.headers }); return { ok: status < 400, status, text: async () => body }; };
    const check = { backend: "http", read: { url: "http://svc/orders/{task}?dir={trial_dir}", headers: { authorization: "Bearer ${ORDERS_TOKEN}" } } };
    const r = await readState(check, dir, {}, { fetch: f(200, '{"status":"shipped"}'), env: { ORDERS_TOKEN: "tok" }, vars: { task: "t1" } });
    expect(r).toEqual({ state: { status: "shipped" }, reader: "http" }); expect(calls[0]).toEqual({ url: `http://svc/orders/t1?dir=${dir}`, headers: { authorization: "Bearer tok" } });
    expect((await readState(check, dir, {}, { fetch: f(404, "no") })).state).toEqual({ http_status: 404 });
    await expect(readState(check, dir, {}, { fetch: f(503, "") })).rejects.toBeInstanceOf(OutcomeInfraError);
    await expect(readState(check, dir, {}, { fetch: async () => { throw new Error("ECONNREFUSED"); } })).rejects.toMatchObject({ kind: "network" });
    await expect(readState(check, dir, {}, { fetch: f(200, "<html>") })).rejects.toMatchObject({ kind: "harness" });
  });
  it("the schema accepts read per backend and refuses a mismatch", () => {
    const s = new SchemaSet(); const base = { id: "end_state", type: "outcome", expect: { a: 1 } };
    expect(s.check("check.outcome", { ...base, read: { file: "a.sqlite", queries: { a: "select 1" } } })).toEqual([]); // backend defaults to sql
    expect(s.check("check.outcome", { ...base, backend: "fs", read: { exists: ["a"] } })).toEqual([]);
    expect(s.check("check.outcome", { ...base, backend: "http", read: { url: "http://x" } })).toEqual([]);
    expect(s.check("check.outcome", { ...base, backend: "http", read: { file: "x" } }).length).toBeGreaterThan(0);
    expect(s.check("check.outcome", { ...base, backend: "page", read: { url: "http://x" } }).length).toBeGreaterThan(0);
    expect(s.check("check.outcome", { ...base, backend: "sql", read: { file: "a", queries: { a: "DROP TABLE x" } } }).length).toBeGreaterThan(0);
  });
});

describe("the runner reads the end state itself", () => {
  let evals: string;
  beforeAll(() => { evals = fixture("  trials: 2\n  concurrency: 4\n  environment: inprocess\n  resources:\n    timeout_s: 60\n").evals; });
  it("a task with read: queries passes on what is in the trial's database, and fails when trial.json claims a state the database does not hold", async () => {
    process.env.FAKE_LIE = "pro_refund_in_window_business";
    const r = await run({ evalsDir: evals, tasks: ["duplicate_charge_business", "pro_refund_in_window_business"], trials: 1, judgeAsk: judge, runId: "run_sql" });
    const honest = r.trials.find((t) => t.task === "duplicate_charge_business")!.grades.find((g) => g.check === "end_state")!;
    expect(honest).toMatchObject({ pass: true, reader: "sql", observed: { "refunds.status": "processed", "refunds.amount_cents": 1999, "confirmations.sent": 1 } });
    const liar = r.trials.find((t) => t.task === "pro_refund_in_window_business")!; const g = liar.grades.find((x) => x.check === "end_state")!;
    expect(g.pass).toBe(false); expect(g.reason).toContain(`refunds.status: expected "processed", got "none"`); expect(g.reason).toContain("read by the runner: sql");
    expect(liar.infra_error).toBe(false); expect(liar.failed_checks).toContain("end_state");
    // the Transcript end-state panel shows what the runner read, not what trial.json claimed
    const t = loadTrial(evals, "run_sql", "pro_refund_in_window_business", 1);
    expect((t.trialData!.state as any).refunds.status).toBe("processed");
    expect(t.outcome.find((o) => o.path === "refunds.status")).toMatchObject({ expected: "processed", actual: "none", reference: "processed", reader: "sql" });
    expect(loadTrial(evals, "run_sql", "duplicate_charge_business", 1).outcome.every((o) => o.reader === "sql" && o.actual === o.expected)).toBe(true);
  });
  it("dry-run and validate --deep compare a read: check against the reference's state", async () => {
    const r = await run({ evalsDir: evals, tasks: ["duplicate_charge_business"], dryRun: true, trials: 1, judgeAsk: judge, runId: "run_sql_dry" });
    expect(r.trials[0]!.grades.find((g) => g.check === "end_state")).toMatchObject({ pass: true, reader: "trial" });
    const v = validateEvals(evals, { deep: true });
    expect(v.problems.filter((p) => p.level === "error")).toEqual([]);
    expect(v.problems.filter((p) => p.rule === "outcome_reader_not_run").length).toBe(2);
  });
  it("validate refuses a sql reader with an expect key that has no query", () => {
    const f = join(evals, "tasks", "regression", "duplicate_charge_business.yaml"); const before = readFileSync(f, "utf8");
    writeFileSync(f, before.replace("      confirmations.sent: 1\n", "      confirmations.sent: 1\n      tickets.status: resolved\n"));
    try { expect(validateEvals(evals).problems.some((p) => p.rule === "outcome_query_per_expect" && p.message.includes("tickets.status"))).toBe(true); } finally { writeFileSync(f, before); }
  });
  it("an http reader that cannot reach its service makes the trial an infra error, not a failure", async () => {
    const f = join(evals, "tasks", "regression", "invoice_copy_business.yaml"); const before = readFileSync(f, "utf8");
    writeFileSync(f, before.replace("checks:\n", "checks:\n  - id: remote_state\n    type: outcome\n    backend: http\n    read:\n      url: http://127.0.0.1:1/state/{task}\n    expect:\n      ok: true\n"));
    try {
      const down = await run({ evalsDir: evals, tasks: ["invoice_copy_business"], trials: 1, judgeAsk: judge, runId: "run_http_down", fetch: async () => { throw new Error("connect ECONNREFUSED"); } });
      expect(down.trials[0]).toMatchObject({ infra_error: true, infra_error_kind: "network" }); expect(down.trials[0]!.infra_message).toContain("end state not read");
      expect((down.summary as any).suites.regression.infra_errors).toBe(1);
      const up = await run({ evalsDir: evals, tasks: ["invoice_copy_business"], trials: 1, judgeAsk: judge, runId: "run_http_up", fetch: async (url) => ({ ok: true, status: 200, text: async () => JSON.stringify({ ok: url.endsWith("/state/invoice_copy_business") }) }) });
      expect(up.trials[0]!.grades.find((g) => g.check === "remote_state")).toMatchObject({ pass: true, reader: "http", observed: { ok: true } });
    } finally { writeFileSync(f, before); }
  });
});

describe("inprocess environment", () => {
  it("kills the whole process group on timeout, grandchildren included", async () => {
    const out = mkdtempSync(join(tmpdir(), "litmustest-fork-"));
    const r = await spawnGroup(["node", FORKER], { FORKER_OUT: out }, out, 1500);
    expect(r.timedOut).toBe(true);
    const pid = Number(readFileSync(join(out, "grandchild.pid"), "utf8"));
    await new Promise((res) => setTimeout(res, 300));
    expect(alive(pid)).toBe(false);
  });
  it("warns that cpus and memory are not enforced in process, and reconciles the concurrency default at 4", async () => {
    const { evals } = fixture("  trials: 1\n  environment: inprocess\n  resources:\n    cpus: 1\n    memory_mb: 512\n    timeout_s: 60\n");
    const r = await run({ evalsDir: evals, tasks: ["invoice_copy_business"], trials: 1, judgeAsk: judge, runId: "run_res" });
    expect(r.warnings.some((w) => w.includes("not enforced by the inprocess environment"))).toBe(true);
    const schema = JSON.parse(readFileSync(join(import.meta.dirname, "..", "schemas", "config.json"), "utf8"));
    expect(schema.properties.runs.properties.concurrency.default).toBe(4);
  });
});

describe("runs.budget_usd", () => {
  it("stops starting trials once the recorded cost reaches the budget and says what was skipped", async () => {
    // the fake agent reports $0.006 a trial: the fourth trial takes the spend to 0.024, past 0.02
    const { evals } = fixture("  trials: 3\n  concurrency: 1\n  budget_usd: 0.02\n  environment: inprocess\n  resources:\n    timeout_s: 60\n");
    const r = await run({ evalsDir: evals, tasks: ["invoice_copy_business", "invoice_copy_frustrated", "duplicate_charge_business"], trials: 3, judgeAsk: judge, runId: "run_budget" });
    const s = r.summary as any;
    expect(r.trials.length).toBe(4);
    expect(s.budget).toEqual({ limit_usd: 0.02, spent_usd: 0.024, trials_skipped: 5, tasks_skipped: [expect.any(String)] });
    expect(Object.keys(s.tasks).length).toBe(2); expect(s.suites.regression.n_tasks).toBe(2); expect(s.suites.regression.n_trials).toBe(4);
    expect(r.warnings.some((w) => /budget of \$0\.02 reached.*5 trials not run/.test(w))).toBe(true);
    expect(validateEvals(evals).problems.filter((p) => p.level === "error")).toEqual([]);
    const free = await run({ evalsDir: evals, tasks: ["invoice_copy_business"], trials: 1, judgeAsk: judge, runId: "run_budget_dry", dryRun: true });
    expect((free.summary as any).budget).toBeUndefined();
  });
});

describe("docker environment (against a fake docker binary)", () => {
  const withFake = (state: string) => { process.env.PATH = `${BIN}${delimiter}${process.env.PATH}`; process.env.FAKE_DOCKER_LOG = join(state, "docker.log"); process.env.FAKE_DOCKER_STATE = state; };
  const logOf = (state: string) => readFileSync(join(state, "docker.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as string[]);
  const RUNS = "  trials: 1\n  concurrency: 2\n  environment: docker\n  resources:\n    cpus: 1.5\n    memory_mb: 512\n    timeout_s: 60\n  docker:\n    image: support-agent:test\n    network: none\n    mounts:\n      - fixtures:/fixtures:ro\n    workdir: /app\n    pass_env:\n      - SECRET_FOR_AGENT\n      - NOT_SET_ANYWHERE\n";
  it("runs each trial in its own container with the limits, the mounts and the LITMUSTEST_* variables", async () => {
    const { repo, evals } = fixture(RUNS); withFake(repo); process.env.SECRET_FOR_AGENT = "s3cret";
    const r = await run({ evalsDir: evals, tasks: ["duplicate_charge_business"], trials: 1, judgeAsk: judge, runId: "run_dk" });
    expect(r.trials[0]).toMatchObject({ infra_error: false, pass: true });
    const calls = logOf(repo); expect(calls[0]![0]).toBe("version");
    const a = calls.find((c) => c[0] === "run")!; const dir = join(repo, ".litmustest", "transcripts", "run_dk", "duplicate_charge_business", "1");
    const after = (flag: string) => a.flatMap((x, i) => (x === flag ? [a[i + 1]!] : []));
    expect(a.slice(0, 4)).toEqual(["run", "--rm", "--name", "lt_run_dk_duplicate_charge_business_1"]);
    expect(after("--cpus")).toEqual(["1.5"]); expect(after("--memory")).toEqual(["512m"]); expect(after("--network")).toEqual(["none"]); expect(after("-w")).toEqual(["/app"]);
    expect(after("-v")).toEqual([`${dir}:/trial`, `${evals}:/evals:ro`, `${join(repo, "fixtures")}:/fixtures:ro`]);
    const e = after("-e");
    expect(e).toContain("LITMUSTEST_TRIAL_DIR=/trial"); expect(e).toContain("LITMUSTEST_TASK=duplicate_charge_business"); expect(e).toContain("LITMUSTEST_EVALS=/evals"); expect(e).toContain("LITMUSTEST_RUN=run_dk");
    expect(e).toContain("LITMUSTEST_TASK_FILE=/evals/tasks/regression/duplicate_charge_business.yaml");
    expect(e).toContain("SECRET_FOR_AGENT"); expect(e.join(" ")).not.toContain("s3cret"); expect(e).not.toContain("NOT_SET_ANYWHERE"); // passed by name, never by value
    expect(a.slice(-4)).toEqual(["support-agent:test", "sh", "-lc", `node ${FAKE}`]);
    expect(existsSync(join(dir, "trial.json"))).toBe(true); expect(r.warnings.some((w) => w.includes("not enforced"))).toBe(false);
  });
  it("fills {trial_dir} with /trial, builds the image once when build is set, and names a reset container apart", async () => {
    const { repo, evals } = fixture("  trials: 2\n  environment: docker\n  docker:\n    build:\n      context: .\n      dockerfile: env/Dockerfile\n", `node ${FAKE} --trial-dir {trial_dir} --task-file {task_file}\n  reset: "true"`);
    withFake(repo);
    await run({ evalsDir: evals, tasks: ["invoice_copy_business"], trials: 2, judgeAsk: judge, runId: "run_dkb" });
    const calls = logOf(repo); const builds = calls.filter((c) => c[0] === "build");
    expect(builds).toEqual([["build", "-t", "litmustest/support_agent:run_dkb", "-f", join(repo, "env", "Dockerfile"), repo]]);
    const runs = calls.filter((c) => c[0] === "run"); expect(runs.length).toBe(4);
    expect(runs.some((c) => c.includes("lt_run_dkb_invoice_copy_business_1_reset") && c.at(-1) === "true")).toBe(true);
    expect(runs.find((c) => c.includes("lt_run_dkb_invoice_copy_business_2"))!.slice(-4)).toEqual(["litmustest/support_agent:run_dkb", "sh", "-lc", `node ${FAKE} --trial-dir /trial --task-file /evals/tasks/regression/invoice_copy_business.yaml`]);
  });
  it("kills the container on timeout and tags the trial as a timeout", async () => {
    const { repo, evals } = fixture(RUNS); withFake(repo); process.env.FAKE_HANG = "invoice_copy_business";
    const r = await run({ evalsDir: evals, tasks: ["invoice_copy_business"], trials: 1, judgeAsk: judge, runId: "run_dkt", timeoutMs: 1500 });
    expect(r.trials[0]).toMatchObject({ infra_error: true, infra_error_kind: "timeout" });
    await new Promise((res) => setTimeout(res, 300));
    expect(logOf(repo)).toContainEqual(["kill", "lt_run_dkt_invoice_copy_business_1"]);
  });
  it("reads exit 137 as out of memory and exit 125 as a harness failure", async () => {
    const { repo, evals } = fixture(RUNS); withFake(repo);
    process.env.FAKE_DOCKER_EXIT = "137";
    const oom = await run({ evalsDir: evals, tasks: ["invoice_copy_business"], trials: 1, judgeAsk: judge, runId: "run_dko" });
    expect(oom.trials[0]).toMatchObject({ infra_error: true, infra_error_kind: "oom" }); expect(oom.trials[0]!.infra_message).toContain("out of memory at 512 MB");
    process.env.FAKE_DOCKER_EXIT = "125";
    expect((await run({ evalsDir: evals, tasks: ["invoice_copy_business"], trials: 1, judgeAsk: judge, runId: "run_dkh" })).trials[0]).toMatchObject({ infra_error: true, infra_error_kind: "harness" });
  });
  it("a missing binary, a dead daemon, a failed build or no image is one clear error for the run, not an infra failure per trial", async () => {
    const { repo, evals } = fixture(RUNS);
    process.env.LITMUSTEST_DOCKER = "docker-is-not-installed-here";
    await expect(run({ evalsDir: evals, tasks: ["invoice_copy_business"], trials: 1, judgeAsk: judge, runId: "run_dkm" })).rejects.toThrow(/was not found on PATH/);
    expect(existsSync(join(evals, "runs", "run_dkm.json"))).toBe(false);
    delete process.env.LITMUSTEST_DOCKER; withFake(repo); process.env.FAKE_DOCKER_DOWN = "1";
    await expect(run({ evalsDir: evals, tasks: ["invoice_copy_business"], trials: 1, judgeAsk: judge, runId: "run_dkd" })).rejects.toThrow(/Cannot connect to the Docker daemon/);
    const none = fixture("  trials: 1\n  environment: docker\n");
    await expect(run({ evalsDir: none.evals, tasks: ["invoice_copy_business"], trials: 1, judgeAsk: judge, runId: "run_dkn" })).rejects.toThrow(/no image or build/);
    delete process.env.FAKE_DOCKER_DOWN; process.env.FAKE_DOCKER_BUILD_FAILS = "1";
    const b = fixture("  trials: 1\n  environment: docker\n  docker:\n    build:\n      context: .\n"); withFake(b.repo);
    await expect(run({ evalsDir: b.evals, tasks: ["invoice_copy_business"], trials: 1, judgeAsk: judge, runId: "run_dkf" })).rejects.toThrow(/docker build failed/);
  });
});

describe("harbor environment (against a fake harbor binary)", () => {
  const RUNS = "  trials: 1\n  environment: harbor\n  resources:\n    cpus: 2\n    memory_mb: 2048\n    timeout_s: 90\n  harbor:\n    image: support-agent:test\n    pass_env:\n      - SECRET_FOR_AGENT\n";
  const withFake = (state: string) => { process.env.PATH = `${BIN}${delimiter}${process.env.PATH}`; process.env.FAKE_HARBOR_LOG = join(state, "harbor.log"); };
  const logOf = (state: string) => readFileSync(join(state, "harbor.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as { argv: string[]; toml: string; solve: string });
  it("runs a trial as a one-trial oracle job and brings trial.json back from the artifacts directory", async () => {
    const { repo, evals } = fixture(RUNS); withFake(repo); process.env.SECRET_FOR_AGENT = "s3cret";
    const r = await run({ evalsDir: evals, tasks: ["duplicate_charge_business"], trials: 1, judgeAsk: judge, runId: "run_hb" });
    expect(r.trials[0]).toMatchObject({ infra_error: false, pass: true });
    expect(r.trials[0]!.grades.find((g) => g.check === "end_state")).toMatchObject({ pass: true, reader: "sql" }); // support.sqlite came back too
    const dir = join(repo, ".litmustest", "transcripts", "run_hb", "duplicate_charge_business", "1");
    expect(existsSync(join(dir, "trial.json"))).toBe(true); expect(existsSync(join(dir, ".harbor"))).toBe(false);
    const c = logOf(repo)[0]!;
    expect(c.argv.slice(0, 2)).toEqual(["run", "-p"]); expect(c.argv.slice(3)).toEqual(["-a", "oracle", "-n", "1", "-k", "1", "-o", expect.stringContaining(".harbor"), "--job-name", "job", "-y"]);
    expect(c.toml).toContain(`schema_version = "1.4"`); expect(c.toml).toContain(`name = "litmustest/duplicate-charge-business"`);
    expect(c.toml).toContain(`docker_image = "support-agent:test"`); expect(c.toml).toContain("cpus = 2"); expect(c.toml).toContain("memory_mb = 2048"); expect(c.toml).toMatch(/\[agent\]\ntimeout_sec = 90\.0/);
    expect(c.toml).toContain('SECRET_FOR_AGENT = "${SECRET_FOR_AGENT}"'); expect(c.toml + c.solve).not.toContain("s3cret");
    expect(c.solve).toContain("export LITMUSTEST_TRIAL_DIR='/logs/artifacts'"); expect(c.solve).toContain("export LITMUSTEST_TASK_FILE='/solution/task.yaml'"); expect(c.solve).toContain(`\nnode ${FAKE}\n`);
  });
  it("maps a Harbor agent timeout to a timeout and a crash to an infra error with the agent's own stderr", async () => {
    const { repo, evals } = fixture(RUNS); withFake(repo);
    process.env.FAKE_HARBOR_TIMEOUT = "1";
    expect((await run({ evalsDir: evals, tasks: ["invoice_copy_business"], trials: 1, judgeAsk: judge, runId: "run_hbt" })).trials[0]).toMatchObject({ infra_error: true, infra_error_kind: "timeout" });
    delete process.env.FAKE_HARBOR_TIMEOUT; process.env.FAKE_CRASH = "invoice_copy_business";
    const crash = await run({ evalsDir: evals, tasks: ["invoice_copy_business"], trials: 1, judgeAsk: judge, runId: "run_hbc" });
    expect(crash.trials[0]).toMatchObject({ infra_error: true, infra_error_kind: "harness" });
  });
  it("a missing binary or image is one clear error for the run", async () => {
    const { evals } = fixture(RUNS); process.env.LITMUSTEST_HARBOR = "harbor-is-not-installed-here";
    await expect(run({ evalsDir: evals, tasks: ["invoice_copy_business"], trials: 1, judgeAsk: judge, runId: "run_hbm" })).rejects.toThrow(/was not found on PATH/);
    const none = fixture("  trials: 1\n  environment: harbor\n");
    await expect(run({ evalsDir: none.evals, tasks: ["invoice_copy_business"], trials: 1, judgeAsk: judge, runId: "run_hbn" })).rejects.toThrow(/runs\.harbor\.image is not set/);
    expect(() => openEnvironment("kubernetes", { repo: "", evalsDir: "", runId: "r", runs: {} })).toThrow(/not one of inprocess, docker, harbor/);
  });
});
