// Where a trial's command runs. The runner owns the trial directory, the grading and the summary; an environment
// only starts the command, enforces the timeout and reports how it ended. `inprocess` spawns it on this machine,
// `docker` runs it in a fresh container with the trial directory mounted at /trial, and `harbor` hands it to the
// Harbor CLI as a one-trial job whose oracle agent runs the command (docs/DECISIONS.md #2).
import { spawn } from "node:child_process";
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

type Obj = Record<string, unknown>;
export interface ExecResult { code: number | null; signal: string | null; stdout: string; stderr: string; timedOut: boolean; ms: number; /** set when the environment itself knows why the command died */ kind?: "oom" | "harness" }
export interface TrialRef { run: string; task: string; n: number; dir: string }
export interface EnvironmentContext { repo: string; evalsDir: string; runId: string; project?: string; runs: Obj }
export interface Environment {
  readonly name: string;
  /** True when the command line goes to a shell inside the environment; false when it is split and run without one. */
  readonly shell: boolean;
  /** Once per run, before any trial: find the binary, build the image. A failure here is an error for the whole run, never an infra failure per trial. */
  setup(): Promise<void>;
  /** A host path as the command sees it (the trial directory is /trial inside a container). */
  path(trial: TrialRef, hostPath: string): string;
  prepare(trial: TrialRef): Promise<void>;
  /** Run one command line for a trial. `label` names what it is (agent, reset) where the environment needs a name. */
  exec(trial: TrialRef, command: string, env: Record<string, string>, cwd: string, timeoutMs: number, label?: string): Promise<ExecResult>;
  cleanup(trial: TrialRef): Promise<void>;
  /** Things the person should know about how this environment treats the config. */
  warnings(): string[];
}

/** Split a command line on spaces, respecting single and double quotes. No shell. */
export function splitCommand(cmd: string): string[] {
  const out: string[] = []; let cur = ""; let q: string | null = null; let had = false;
  for (const ch of cmd) {
    if (q) { if (ch === q) q = null; else cur += ch; continue; }
    if (ch === '"' || ch === "'") { q = ch; had = true; continue; }
    if (/\s/.test(ch)) { if (cur || had) { out.push(cur); cur = ""; had = false; } continue; }
    cur += ch;
  }
  if (cur || had) out.push(cur);
  return out;
}

// Children run in their own process group so a timeout can kill the whole tree. A detached group does not get the
// terminal's Ctrl-C, so the runner forwards its own exit to every group still alive.
const live = new Set<number>();
const killGroup = (pid: number) => { try { process.kill(process.platform === "win32" ? pid : -pid, "SIGKILL"); } catch { /* already gone */ } };
const onExit = () => { for (const pid of live) killGroup(pid); };
const onSignal = (sig: NodeJS.Signals) => { onExit(); process.exit(sig === "SIGINT" ? 130 : 143); };
function track(pid: number) { if (!live.size) { process.once("exit", onExit); process.once("SIGINT", onSignal); process.once("SIGTERM", onSignal); } live.add(pid); }
function untrack(pid: number) { live.delete(pid); if (!live.size) { process.off("exit", onExit); process.off("SIGINT", onSignal); process.off("SIGTERM", onSignal); } }

/** Spawn argv without a shell in its own process group; on timeout kill the group (and call onTimeout first). */
export function spawnGroup(argv: string[], env: Record<string, string>, cwd: string, timeoutMs: number, onTimeout?: () => void): Promise<ExecResult> {
  return new Promise((resolveP) => {
    const started = Date.now(); let stdout = "", stderr = ""; let timedOut = false; let settled = false;
    const child = spawn(argv[0]!, argv.slice(1), { cwd, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" });
    const pid = child.pid; if (pid) track(pid);
    const timer = setTimeout(() => { timedOut = true; try { onTimeout?.(); } catch { /* best effort */ } if (pid) killGroup(pid); else child.kill("SIGKILL"); }, timeoutMs);
    const done = (r: ExecResult) => { if (settled) return; settled = true; clearTimeout(timer); if (pid) untrack(pid); resolveP(r); };
    child.stdout.on("data", (d) => (stdout += d)); child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (e) => done({ code: null, signal: null, stdout, stderr: stderr + `\n${e.message}`, timedOut, ms: Date.now() - started }));
    child.on("close", (code, signal) => done({ code, signal, stdout: stdout.slice(-20000), stderr: stderr.slice(-20000), timedOut, ms: Date.now() - started }));
  });
}

class InProcess implements Environment {
  readonly name = "inprocess"; readonly shell = false;
  private ctx: EnvironmentContext;
  constructor(ctx: EnvironmentContext) { this.ctx = ctx; }
  async setup() { /* nothing to build */ }
  path(_t: TrialRef, p: string) { return p; }
  async prepare() { /* the runner already made the trial directory */ }
  exec(_t: TrialRef, command: string, env: Record<string, string>, cwd: string, timeoutMs: number) { return spawnGroup(splitCommand(command), env, cwd, timeoutMs); }
  async cleanup() { /* the trial directory is the transcript; it stays */ }
  warnings() {
    const r = (this.ctx.runs.resources as Obj | undefined) ?? {};
    return r.cpus !== undefined || r.memory_mb !== undefined ? ["runs.resources.cpus and memory_mb are not enforced by the inprocess environment; set runs.environment: docker to apply them"] : [];
  }
}

/** docker: one fresh container per trial. Config under runs.docker; cpus and memory from runs.resources. */
class Docker implements Environment {
  readonly name = "docker"; readonly shell = true;
  private cfg: Obj; private image = ""; private bin: string; private ctx: EnvironmentContext;
  constructor(ctx: EnvironmentContext) { this.ctx = ctx; this.cfg = (ctx.runs.docker as Obj | undefined) ?? {}; this.bin = process.env.LITMUSTEST_DOCKER ?? "docker"; }
  async setup() {
    if (!this.cfg.image && !this.cfg.build) throw new Error("runs.environment is docker but runs.docker has no image or build (see docs/SCHEMAS.md#config)");
    const v = await spawnGroup([this.bin, "version", "--format", "{{.Server.Version}}"], {}, this.ctx.repo, 30_000);
    if (v.code === null) throw new Error(`runs.environment is docker but the '${this.bin}' command was not found on PATH. Install Docker, or set runs.environment: inprocess.`);
    if (v.code !== 0) throw new Error(`docker is installed but not usable: ${v.stderr.trim().split("\n").pop() || `exit ${v.code}`}. Is the daemon running?`);
    if (this.cfg.build) {
      const b = this.cfg.build as Obj; const context = resolve(this.ctx.repo, String(b.context ?? "."));
      this.image = `litmustest/${this.ctx.project ?? "agent"}:${this.ctx.runId}`;
      const r = await spawnGroup([this.bin, "build", "-t", this.image, ...(b.dockerfile ? ["-f", resolve(this.ctx.repo, String(b.dockerfile))] : []), context], {}, this.ctx.repo, 30 * 60_000);
      if (r.code !== 0) throw new Error(`docker build failed: ${r.stderr.trim().split("\n").slice(-3).join(" | ") || `exit ${r.code}`}`);
    } else this.image = String(this.cfg.image);
  }
  containerName(t: TrialRef, label = "agent") { return `lt_${t.run}_${t.task}_${t.n}${label === "agent" ? "" : `_${label}`}`.replace(/[^A-Za-z0-9_.-]/g, "_"); }
  path(t: TrialRef, p: string) {
    const under = (root: string, mount: string) => { const rel = relative(root, p); return rel === "" ? mount : !rel.startsWith("..") && !resolve(root, rel).startsWith("..") && !/^([A-Za-z]:|\/)/.test(rel) ? `${mount}/${rel.split(sep).join("/")}` : null; };
    return under(t.dir, "/trial") ?? under(this.ctx.evalsDir, "/evals") ?? p;
  }
  async prepare() { /* the container is created by exec */ }
  async exec(t: TrialRef, command: string, env: Record<string, string>, _cwd: string, timeoutMs: number, label = "agent"): Promise<ExecResult> {
    const res = (this.ctx.runs.resources as Obj | undefined) ?? {}; const name = this.containerName(t, label);
    const args = ["run", "--rm", "--name", name];
    if (res.cpus !== undefined) args.push("--cpus", String(res.cpus));
    if (res.memory_mb !== undefined) args.push("--memory", `${res.memory_mb}m`);
    if (this.cfg.network) args.push("--network", String(this.cfg.network));
    args.push("-v", `${t.dir}:/trial`, "-v", `${this.ctx.evalsDir}:/evals:ro`);
    for (const m of (this.cfg.mounts as string[] | undefined) ?? []) { const [host, ...rest] = m.split(":"); args.push("-v", [resolve(this.ctx.repo, host!), ...rest].join(":")); }
    if (this.cfg.workdir) args.push("-w", String(this.cfg.workdir));
    for (const [k, v] of Object.entries(env)) args.push("-e", `${k}=${v}`);
    for (const k of (this.cfg.pass_env as string[] | undefined) ?? []) if (process.env[k] !== undefined) args.push("-e", k); // name only: the value never appears in the argument list
    args.push(this.image, "sh", "-lc", command);
    const r = await spawnGroup([this.bin, ...args], {}, this.ctx.repo, timeoutMs, () => { spawn(this.bin, ["kill", name], { stdio: "ignore", detached: true }).unref(); });
    if (r.timedOut) return r;
    if (r.code === 137) return { ...r, kind: "oom", stderr: `${r.stderr}\ncontainer killed (exit 137): out of memory${res.memory_mb ? ` at ${res.memory_mb} MB` : ""}` };
    if (r.code === 125) return { ...r, kind: "harness" }; // docker run itself failed: bad image, bad flag, daemon gone
    return r;
  }
  async cleanup() { /* --rm removes the container */ }
  warnings() { return []; }
}

const shq = (v: string) => `'${v.replace(/'/g, `'\\''`)}'`;
const toml = (v: string) => JSON.stringify(v); // a TOML basic string takes the same escapes as JSON for what we write

/**
 * harbor: each trial becomes a generated Harbor task run once with Harbor's `oracle` agent, whose job is to run
 * solution/solve.sh inside the task's container. solve.sh is the agent command; the trial directory is /logs/artifacts,
 * which Harbor mounts back to the host, and the wrapper copies what lands there into the litmustest trial directory.
 * Harbor's verifier only records whether trial.json exists; litmustest does the grading.
 */
class Harbor implements Environment {
  readonly name = "harbor"; readonly shell = true;
  private cfg: Obj; private bin: string; private ctx: EnvironmentContext;
  constructor(ctx: EnvironmentContext) { this.ctx = ctx; this.cfg = (ctx.runs.harbor as Obj | undefined) ?? {}; this.bin = process.env.LITMUSTEST_HARBOR ?? "harbor"; }
  async setup() {
    if (!this.cfg.image) throw new Error("runs.environment is harbor but runs.harbor.image is not set: name the container image the agent runs in (see docs/SCHEMAS.md#config)");
    const v = await spawnGroup([this.bin, "--version"], {}, this.ctx.repo, 30_000);
    if (v.code === null) throw new Error(`runs.environment is harbor but the '${this.bin}' command was not found on PATH. Install it (uv tool install harbor), or set runs.environment: docker or inprocess.`);
  }
  path(t: TrialRef, p: string) {
    const rel = relative(t.dir, p);
    if (rel === "") return "/logs/artifacts";
    if (!rel.startsWith("..") && !/^([A-Za-z]:|\/)/.test(rel)) return `/logs/artifacts/${rel.split(sep).join("/")}`;
    return p.endsWith(`${sep}${t.task}.yaml`) ? "/solution/task.yaml" : p; // the task file rides along in solution/; the rest of evals/ must be in the image
  }
  async prepare() { /* the task directory is written by exec */ }
  async exec(t: TrialRef, command: string, env: Record<string, string>, _cwd: string, timeoutMs: number, label = "agent"): Promise<ExecResult> {
    const started = Date.now(); const res = (this.ctx.runs.resources as Obj | undefined) ?? {};
    const work = join(t.dir, ".harbor", label); rmSync(work, { recursive: true, force: true });
    const task = join(work, "task"); const jobs = join(work, "jobs");
    for (const d of ["solution", "tests", "environment"]) mkdirSync(join(task, d), { recursive: true });
    const passEnv = ((this.cfg.pass_env as string[] | undefined) ?? []).filter((k) => process.env[k] !== undefined);
    writeFileSync(join(task, "task.toml"), [
      `schema_version = "1.4"`, "", "[task]", `name = ${toml(`litmustest/${t.task.replace(/[^A-Za-z0-9]+/g, "-")}`)}`, `version = "1.0.0"`, "",
      "[metadata]", `litmustest_run = ${toml(t.run)}`, `litmustest_trial = ${t.n}`, "",
      "[agent]", `timeout_sec = ${Math.ceil(timeoutMs / 1000)}.0`, "", "[verifier]", "timeout_sec = 60.0", "",
      "[environment]", `docker_image = ${toml(String(this.cfg.image))}`, ...(res.cpus !== undefined ? [`cpus = ${res.cpus}`] : []), ...(res.memory_mb !== undefined ? [`memory_mb = ${res.memory_mb}`] : []), "",
      "[solution.env]", ...passEnv.map((k) => `${k} = ${toml(`\${${k}}`)}`), "", // a template Harbor resolves from the host: the value is never written to disk
    ].join("\n"));
    writeFileSync(join(task, "instruction.md"), `Run by litmustest: task ${t.task}, trial ${t.n} of run ${t.run}. The oracle agent runs the configured agent command; litmustest grades what it leaves in /logs/artifacts/trial.json.\n`);
    writeFileSync(join(task, "environment", "Dockerfile"), `FROM ${this.cfg.image}\n`);
    writeFileSync(join(task, "solution", "solve.sh"), ["#!/bin/sh", "set -e", "mkdir -p /logs/artifacts", ...Object.entries(env).map(([k, v]) => `export ${k}=${shq(v)}`), ...(this.cfg.workdir ? [`cd ${shq(String(this.cfg.workdir))}`] : []), command, ""].join("\n"), { mode: 0o755 });
    const taskFile = env.LITMUSTEST_TASK_FILE_HOST; if (taskFile && existsSync(taskFile)) copyFileSync(taskFile, join(task, "solution", "task.yaml"));
    writeFileSync(join(task, "tests", "test.sh"), ["#!/bin/sh", "mkdir -p /logs/verifier", "if [ -f /logs/artifacts/trial.json ]; then echo 1 > /logs/verifier/reward.txt; else echo 0 > /logs/verifier/reward.txt; fi", ""].join("\n"), { mode: 0o755 });
    const args = ["run", "-p", task, "-a", "oracle", "-n", "1", "-k", "1", "-o", jobs, "--job-name", "job", "-y", ...(this.cfg.backend ? ["-e", String(this.cfg.backend)] : [])];
    // Harbor enforces the agent timeout itself; the outer timer only covers a hung CLI (image pull, environment start)
    const r = await spawnGroup([this.bin, ...args], {}, this.ctx.repo, timeoutMs + 10 * 60_000);
    const jobDir = join(jobs, "job");
    const trialDir = existsSync(jobDir) ? readdirSync(jobDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => join(jobDir, e.name)).find((d) => existsSync(join(d, "result.json")) || existsSync(join(d, "agent"))) : undefined;
    const ms = Date.now() - started;
    if (!trialDir) return { ...r, ms, code: r.code === 0 ? 1 : r.code, kind: "harness", stderr: `${r.stderr}\nharbor left no trial directory under ${jobDir}` };
    const read = (f: string) => (existsSync(join(trialDir, f)) ? readFileSync(join(trialDir, f), "utf8") : "");
    if (existsSync(join(trialDir, "artifacts"))) cpSync(join(trialDir, "artifacts"), t.dir, { recursive: true, filter: (src) => !src.endsWith("manifest.json") });
    let exception: Obj | null = null;
    try { exception = ((JSON.parse(read("result.json") || "{}") as Obj).exception_info as Obj | null) ?? null; } catch { /* no result: fall through to the exit code */ }
    const exit = Number(read("agent/exit-code.txt").trim() || 0);
    const timedOut = r.timedOut || /timeout/i.test(String(exception?.exception_type ?? ""));
    const stderr = [exception ? `${exception.exception_type}: ${exception.exception_message}` : "", read("exception.txt").slice(-4000), r.stderr.slice(-4000)].filter(Boolean).join("\n");
    return { code: timedOut ? null : exit || (exception ? 1 : 0), signal: null, stdout: read("agent/oracle.txt").slice(-20000) || r.stdout, stderr, timedOut, ms, ...(exception && !exit && !timedOut ? { kind: "harness" as const } : {}) };
  }
  async cleanup(t: TrialRef) { rmSync(join(t.dir, ".harbor"), { recursive: true, force: true }); }
  warnings() { return []; }
}

export function openEnvironment(name: string, ctx: EnvironmentContext): Environment {
  if (name === "inprocess") return new InProcess(ctx);
  if (name === "docker") return new Docker(ctx);
  if (name === "harbor") return new Harbor(ctx);
  throw new Error(`runs.environment '${name}' is not one of inprocess, docker, harbor`);
}
