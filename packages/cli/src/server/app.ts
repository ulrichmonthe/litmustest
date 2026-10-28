// The local server's request handling. Every write is validated before it stays on disk; every change is tracked as pending.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync, appendFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { execFileSync } from "node:child_process";
import { parse as parseYaml, stringify as yaml } from "yaml";
import { SchemaSet } from "../schemas.ts";
import { validateEvals, sha256, type Problem, type ValidateResult } from "../validate.ts";
import { traceView } from "../trace_view.ts";
import { Git } from "./git.ts";
import { modesView, overview, loadFiles } from "./overview.ts";
import { compareRuns, evaluateGates, comparisonMarkdown } from "../compare.ts";
import { applyGraduations, doctor, graduationProposals } from "../graduate.ts";
import { Pending } from "./pending.ts";
import { serialize } from "./serialize.ts";

type Obj = Record<string, unknown>;
export interface Reply { status: number; body: unknown; headers?: Record<string, string> }
export type Listener = (event: Obj) => void;

export function kindOf(rel: string): string | undefined {
  if (rel === "litmustest.yaml") return "config";
  if (/^failure_modes\/[^/]+\.yaml$/.test(rel)) return "failure_mode";
  if (/^tasks\/.+\.yaml$/.test(rel)) return "task";
  if (/^refs\/.+\.json$/.test(rel)) return "reference_solution";
  if (/^graders\/judges\/[^/]+\/judge\.yaml$/.test(rel)) return "judge";
  if (/^graders\/judges\/[^/]+\/calibration\.json$/.test(rel)) return "calibration";
  if (/^graders\/judges\/[^/]+\/prompt\.md$/.test(rel)) return "prompt";
  if (/^graders\/code\/[^/]+\.py$/.test(rel)) return "code";
  if (/^labels\/[^/]+\.jsonl$/.test(rel)) return "label";
  if (/^suites\/[^/]+\.yaml$/.test(rel)) return "suite";
  if (/^runs\/[^/]+\.json$/.test(rel)) return "run_summary";
  if (/^datasets\/(traces|synthetic)\/[^/]+\.json$/.test(rel)) return "trace";
  if (/^batches\/[^/]+\.yaml$/.test(rel)) return "batch";
  return undefined;
}

export class App {
  readonly evalsDir: string;
  readonly git: Git;
  readonly pending: Pending;
  private schemas = new SchemaSet();
  private listeners = new Set<Listener>();
  private validation: ValidateResult | undefined;

  constructor(evalsDir: string) {
    if (!existsSync(join(resolve(evalsDir), "litmustest.yaml"))) throw new Error(`${resolve(evalsDir)}/litmustest.yaml not found; run litmustest init first`);
    this.evalsDir = realpathSync(resolve(evalsDir));
    this.git = new Git(this.evalsDir);
    this.pending = new Pending(this.git, this.evalsDir);
  }

  subscribe(l: Listener): () => void { this.listeners.add(l); return () => this.listeners.delete(l); }
  emit(event: Obj): void { for (const l of this.listeners) l(event); }

  validate(force = false): ValidateResult {
    if (!this.validation || force) this.validation = validateEvals(this.evalsDir);
    return this.validation;
  }
  invalidate(): void { this.validation = undefined; }

  /** Resolve a repo- or evals-relative path safely inside evals/. */
  private abs(path: string): { abs: string; rel: string } {
    const cleaned = path.replace(/^\/+/, "").replace(/^evals\//, "");
    const abs = resolve(this.evalsDir, cleaned);
    if (!abs.startsWith(this.evalsDir + sep) && abs !== this.evalsDir) throw new HttpError(400, "path escapes evals/");
    return { abs, rel: relative(this.evalsDir, abs).split(sep).join("/") };
  }

  // ---- reads
  health(): Reply {
    const v = this.validate();
    let annotator = "";
    try { annotator = this.git.run(["config", "user.name"]).trim(); } catch { /* unset */ }
    const project = (() => { try { return String((parseYaml(readFileSync(join(this.evalsDir, "litmustest.yaml"), "utf8")) as Obj).project ?? ""); } catch { return ""; } })();
    return { status: 200, body: { evals: this.evalsDir, repo: this.git.root, project, branch: this.git.branch(), head: this.git.head(), annotator, errors: v.errors, warnings: v.warnings, pending: this.pending.count() } };
  }
  modes(): Reply { return { status: 200, body: { failure_modes: modesView(this.evalsDir) } }; }
  graduate(): Reply { return { status: 200, body: graduationProposals(this.evalsDir) }; }
  applyGraduate(tasks: string[]): Reply { const r = applyGraduations(this, tasks); this.invalidate(); return { status: 200, body: r }; }
  doctor(): Reply { return { status: 200, body: doctor(this.evalsDir) }; }
  /** Tasks & suites: every task with its checks, source, and the last five runs' results. */
  tasks(): Reply {
    const f = loadFiles(this.evalsDir); const last5 = f.runs.slice(-5);
    const prop = graduationProposals(this.evalsDir);
    const tasks = f.tasks.map((t) => { const id = String(t.id); const hist = last5.map((r) => { const x = (r.tasks as Record<string, Obj>)?.[id]; if (!x) return null; const tr = ((x.trials as Obj[]) ?? []).filter((y) => !y.infra_error); return { run: r.run_id, strict_pass: x.strict_pass, passed: tr.filter((y) => y.pass).length, trials: tr.length, flaky: Boolean(x.flaky), likely_broken: Boolean(x.likely_broken) }; }); const latest = hist[hist.length - 1];
      return { id, suite: t.suite, source: t.source, description: t.description, checks: ((t.checks as Obj[]) ?? []).map((c) => ({ id: c.id, type: c.type, failure_mode: c.failure_mode, weight: c.weight ?? 1 })), trials: t.trials, graduated_from: t.graduated_from, history: hist, pass_at_1: latest?.strict_pass ?? null, pass_hat_k: latest ? (latest.trials && latest.passed === latest.trials ? 100 : 0) : null, status: latest?.likely_broken ? "broken" : latest?.flaky ? "flaky" : prop.proposals.some((p) => p.task === id) ? "graduate" : latest ? (latest.passed === latest.trials ? "passing" : latest.passed === 0 ? "failing" : "mixed") : "no runs", path: findPath(this.evalsDir, id) }; });
    const suites = f.suites.map((s) => { const ids = tasks.filter((t) => t.suite === s.name); const latest = f.runs[f.runs.length - 1]; const cur = (latest?.suites as Record<string, Obj> | undefined)?.[String(s.name)]; return { name: s.name, kind: s.kind, description: s.description, n: ids.length, pass_rate: cur ? cur.pass_rate : null, broken: ids.filter((t) => t.status === "broken").length, flaky: ids.filter((t) => t.status === "flaky").length, graduate: ids.filter((t) => t.status === "graduate").length, gate: s.gate ?? (f.config.gates as Record<string, Obj> | undefined)?.[String(s.name)] ?? null }; });
    const balance = (() => { const should = f.tasks.filter((t) => ((t.checks as Obj[]) ?? []).some((c) => c.type === "outcome" && Object.values((c.expect as Obj) ?? {}).some((v) => v !== 0 && v !== "none" && v !== false))).length; return f.tasks.length ? Math.round((100 * should) / f.tasks.length) : 0; })();
    return { status: 200, body: { tasks, suites, balance_should_pct: balance, saturation: prop.saturation, proposals: prop.proposals, runs: last5.map((r) => r.run_id) } };
  }
  runs(): Reply { const f = loadFiles(this.evalsDir); return { status: 200, body: { runs: f.runs.map((r) => ({ run_id: r.run_id, commit: r.commit, branch: r.branch, started_at: r.started_at, trials: r.trials, suites: Object.keys(r.suites as Obj), n_tasks: Object.keys(r.tasks as Obj).length, cost_usd: r.cost_usd, infra_error_rate: r.infra_error_rate })).reverse() } }; }
  compare(a: string, b: string): Reply { try { const c = compareRuns(this.evalsDir, a, b); const g = evaluateGates(c); return { status: 200, body: { ...c, gates_passed: g.passed, markdown: comparisonMarkdown(c) } }; } catch (e) { throw new HttpError(404, (e as Error).message); } }
  overview(): Reply { return { status: 200, body: overview(this.evalsDir) }; }
  /** Failure modes with their grader status and label counts, for chips and the "so far" panel. */
  failureModes(): Reply {
    const dir = join(this.evalsDir, "failure_modes");
    const labels = this.labelsByTrace();
    const counts = new Map<string, number>();
    for (const ls of labels.values()) for (const l of ls) if (l.label === "Fail") counts.set(String(l.failure_mode), (counts.get(String(l.failure_mode)) ?? 0) + 1);
    const judgesDir = join(this.evalsDir, "graders", "judges");
    const codeDir = join(this.evalsDir, "graders", "code");
    const codeFiles = existsSync(codeDir) ? readdirSync(codeDir).filter((f) => f.endsWith(".py")) : [];
    const codeUses = new Set<string>();
    const tasksDir = join(this.evalsDir, "tasks");
    const walkTasks = (d: string) => { if (!existsSync(d)) return; for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); if (e.isDirectory()) walkTasks(p); else if (e.name.endsWith(".yaml")) { try { for (const c of ((parseYaml(readFileSync(p, "utf8")) as Obj).checks as Obj[]) ?? []) if (c.type === "code" && c.failure_mode) codeUses.add(String(c.failure_mode)); } catch { /* reported by validate */ } } } };
    walkTasks(tasksDir);
    const modes = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".yaml")).map((f) => {
      const m = parseYaml(readFileSync(join(dir, f), "utf8")) as Obj;
      const name = String(m.name);
      let grader = "No grader"; let status: string = "none";
      const calFile = join(judgesDir, name, "calibration.json");
      if (existsSync(join(judgesDir, name, "judge.yaml"))) { grader = "Judge"; status = existsSync(calFile) ? String((JSON.parse(readFileSync(calFile, "utf8")) as Obj).status) : "untested"; }
      else if (codeUses.has(name)) { grader = "Code check"; status = "trusted"; }
      return { name, definition: m.definition, severity: m.severity, owner: m.owner, retired: Boolean(m.retired), grader, status, fail_labels: counts.get(name) ?? 0 };
    }).filter((m) => !m.retired) : [];
    void codeFiles;
    return { status: 200, body: { failure_modes: modes } };
  }
  listFiles(): Reply {
    const out: Obj[] = [];
    const walk = (d: string) => { for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); if (e.isDirectory()) walk(p); else if (!e.name.startsWith(".")) { const rel = relative(this.evalsDir, p).split(sep).join("/"); const kind = kindOf(rel); if (kind && kind !== "trace") out.push({ path: rel, kind, hash: sha256(readFileSync(p)), size: statSync(p).size }); } } };
    walk(this.evalsDir);
    return { status: 200, body: { files: out.sort((a, b) => String(a.path).localeCompare(String(b.path))) } };
  }
  getFile(path: string): Reply {
    const { abs, rel } = this.abs(path);
    if (!existsSync(abs) || statSync(abs).isDirectory()) throw new HttpError(404, `no file ${rel}`);
    const content = readFileSync(abs, "utf8");
    const kind = kindOf(rel);
    let data: unknown = null;
    try { data = rel.endsWith(".json") ? JSON.parse(content) : rel.endsWith(".yaml") ? parseYaml(content) : rel.endsWith(".jsonl") ? content.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l)) : null; } catch { data = null; }
    const problems = this.validate().problems.filter((p) => p.file === rel);
    return { status: 200, body: { path: rel, kind, hash: sha256(content), content, data, problems } };
  }

  // ---- writes
  /** Save a file. Refuses a conflict (409), a schema failure or a new cross-file error (422). Side effects for judges.
   *  `content` is the raw text; a client may send `data` instead and the server serializes it (YAML or JSON by extension), which keeps diffs minimal. */
  putFile(path: string, content: string | undefined, baseHash?: string, data?: unknown): Reply {
    const { abs, rel } = this.abs(path);
    const kind = kindOf(rel);
    if (content === undefined) {
      if (data === undefined) throw new HttpError(400, "content or data is required");
      content = serialize(rel, data, existsSync(abs) ? readFileSync(abs, "utf8") : undefined);
    }
    if (!kind) throw new HttpError(400, `${rel} is not a file type litmustest knows; see docs/SCHEMAS.md`);
    if (kind === "calibration") throw new HttpError(403, "calibration.json is written by litmustest calibrate only; edit the judge and re-run calibration");
    if (kind === "trace") throw new HttpError(403, "traces are written by litmustest ingest; they are evidence, not something to edit");
    const existed = existsSync(abs);
    const before = existed ? readFileSync(abs, "utf8") : undefined;
    const currentHash = before === undefined ? null : sha256(before);
    if (existed && baseHash !== undefined && baseHash !== currentHash) {
      return { status: 409, body: { error: "conflict", message: `${rel} changed on disk since it was loaded`, current_hash: currentHash, current_content: before, resolve: ["reload", "keep_mine"] } };
    }
    if (!existed && baseHash) throw new HttpError(409, `${rel} does not exist but a base hash was sent`);
    // 1. shape
    const shape = this.checkShape(kind, rel, content);
    if (shape.length) return { status: 422, body: { error: "invalid", message: `${rel} does not validate`, problems: shape.map((m) => ({ level: "error", file: rel, message: m, rule: "schema" })) } };
    // 2. write, then the cross-file rules; revert if anything new breaks
    const baseline = new Set(this.validate().problems.filter((p) => p.level === "error").map((p) => `${p.file}|${p.message}`));
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
    const side = this.judgeSideEffects(rel, kind);
    const after = validateEvals(this.evalsDir);
    const fresh = after.problems.filter((p) => p.level === "error" && !baseline.has(`${p.file}|${p.message}`));
    if (fresh.length) {
      if (before === undefined) rmSync(abs); else writeFileSync(abs, before);
      for (const s of side) writeFileSync(s.abs, s.before);
      this.invalidate();
      return { status: 422, body: { error: "invalid", message: `${rel} would break the evals directory`, problems: fresh } };
    }
    this.validation = after;
    this.pending.track(abs);
    for (const s of side) this.pending.track(s.abs);
    this.emit({ type: "saved", path: rel, hash: sha256(content), side_effects: side.map((s) => s.rel) });
    const problems = after.problems.filter((p) => p.file === rel || side.some((s) => s.rel === p.file));
    return { status: 200, body: { path: rel, hash: sha256(content), status: "saved to branch", branch: this.git.branch(), problems, side_effects: side.map((s) => s.rel) } };
  }

  /** Save several files as one change: every file passes its shape check, all are written, the cross-file rules run once, and all revert together if anything new breaks. */
  putFiles(items: { path: string; content?: string; data?: unknown }[]): Reply {
    const prepared: { abs: string; rel: string; content: string; before?: string }[] = [];
    for (const it of items) {
      const { abs, rel } = this.abs(it.path); const kind = kindOf(rel);
      if (!kind) throw new HttpError(400, `${rel} is not a file type litmustest knows`);
      if (kind === "calibration" || kind === "trace") throw new HttpError(403, `${rel} cannot be written through the API`);
      const content = it.content ?? serialize(rel, it.data, existsSync(abs) ? readFileSync(abs, "utf8") : undefined);
      const shape = this.checkShape(kind, rel, content);
      if (shape.length) return { status: 422, body: { error: "invalid", message: `${rel} does not validate`, problems: shape.map((m) => ({ level: "error", file: rel, message: m, rule: "schema" })) } };
      prepared.push({ abs, rel, content, before: existsSync(abs) ? readFileSync(abs, "utf8") : undefined });
    }
    const baseline = new Set(this.validate().problems.filter((p) => p.level === "error").map((p) => `${p.file}|${p.message}`));
    for (const p of prepared) { mkdirSync(dirname(p.abs), { recursive: true }); writeFileSync(p.abs, p.content); }
    const after = validateEvals(this.evalsDir);
    const fresh = after.problems.filter((p) => p.level === "error" && !baseline.has(`${p.file}|${p.message}`));
    if (fresh.length) { for (const p of prepared) { if (p.before === undefined) rmSync(p.abs); else writeFileSync(p.abs, p.before); } this.invalidate(); return { status: 422, body: { error: "invalid", message: "the change would break the evals directory", problems: fresh } }; }
    this.validation = after;
    for (const p of prepared) this.pending.track(p.abs);
    this.emit({ type: "saved", path: prepared[0]?.rel, side_effects: prepared.slice(1).map((p) => p.rel) });
    return { status: 200, body: { files: prepared.map((p) => ({ path: p.rel, hash: sha256(p.content) })), status: "saved to branch", branch: this.git.branch() } };
  }

  private checkShape(kind: string, rel: string, content: string): string[] {
    try {
      if (kind === "prompt") return content.trim() ? [] : ["(root): prompt is empty"];
      if (kind === "code") return /def\s+check\s*\(/.test(content) ? [] : ["(root): must define check(trial, args)"];
      if (kind === "label") { const out: string[] = []; content.split("\n").forEach((l, i) => { if (!l.trim()) return; for (const m of this.schemas.check("label", JSON.parse(l))) out.push(`line ${i + 1}: ${m}`); }); return out; }
      const data = rel.endsWith(".json") ? JSON.parse(content) : parseYaml(content);
      return this.schemas.check(kind, data);
    } catch (e) { return [`(root): cannot parse: ${(e as Error).message}`]; }
  }

  /** A judge's prompt or model changed: keep prompt_hash in sync and mark a trusted calibration stale. */
  private judgeSideEffects(rel: string, kind: string): { abs: string; rel: string; before: string }[] {
    const m = /^graders\/judges\/([^/]+)\//.exec(rel);
    if (!m || (kind !== "prompt" && kind !== "judge")) return [];
    const dir = join(this.evalsDir, "graders", "judges", m[1]!);
    const out: { abs: string; rel: string; before: string }[] = [];
    const judgeFile = join(dir, "judge.yaml"), calFile = join(dir, "calibration.json"), promptFile = join(dir, "prompt.md");
    if (!existsSync(judgeFile)) return out;
    const judge = parseYaml(readFileSync(judgeFile, "utf8")) as Obj;
    if (kind === "prompt" && existsSync(promptFile)) {
      const h = sha256(readFileSync(promptFile));
      if (judge.prompt_hash !== h) { const before = readFileSync(judgeFile, "utf8"); judge.prompt_hash = h; writeFileSync(judgeFile, yaml(judge)); out.push({ abs: judgeFile, rel: `graders/judges/${m[1]}/judge.yaml`, before }); }
    }
    if (existsSync(calFile)) {
      const before = readFileSync(calFile, "utf8");
      const cal = JSON.parse(before) as Obj;
      const reason = cal.prompt_hash !== judge.prompt_hash ? "prompt_changed" : cal.model !== judge.model ? "model_changed" : undefined;
      if (reason && cal.status === "trusted") { cal.status = "stale"; cal.stale_reason = reason; writeFileSync(calFile, JSON.stringify(cal, null, 2) + "\n"); out.push({ abs: calFile, rel: `graders/judges/${m[1]}/calibration.json`, before }); }
    }
    return out;
  }

  /** Append one label. The only partial write: labels are append-only. */
  appendLabel(batch: string, label: Obj): Reply {
    const at = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
    const full: Obj = { at, ...label, batch: label.batch ?? batch };
    const errs = this.schemas.check("label", full);
    if (errs.length) return { status: 422, body: { error: "invalid", message: "label does not validate", problems: errs.map((m) => ({ level: "error", file: `labels/${batch}.jsonl`, message: m, rule: "schema" })) } };
    const v = this.validate();
    const fm = String(full.failure_mode);
    if (fm !== "overall" && !existsSync(join(this.evalsDir, "failure_modes", `${fm}.yaml`))) return { status: 422, body: { error: "invalid", message: `failure_mode '${fm}' does not exist`, problems: [{ level: "error", file: `labels/${batch}.jsonl`, message: `failure_mode '${fm}' does not exist`, rule: "failure_mode_exists" }] } };
    if (!existsSync(join(this.evalsDir, "datasets", "traces", `${full.trace_id}.json`))) return { status: 422, body: { error: "invalid", message: `trace '${full.trace_id}' not found`, problems: [] } };
    const safe = String(batch).replace(/[^a-z0-9_-]/gi, "_");
    const abs = join(this.evalsDir, "labels", `${safe}.jsonl`);
    mkdirSync(dirname(abs), { recursive: true });
    appendFileSync(abs, JSON.stringify(full) + "\n");
    this.pending.track(abs); this.invalidate();
    this.emit({ type: "label", path: `labels/${safe}.jsonl`, label: full });
    void v;
    return { status: 200, body: { path: `labels/${safe}.jsonl`, label: full } };
  }

  // ---- pending changes tray
  pendingState(): Reply { return { status: 200, body: this.pending.state() }; }
  commit(message?: string, slug?: string): Reply {
    const st = this.pending.state();
    if (!st.files.length) throw new HttpError(400, "nothing pending");
    const branch = this.git.ensureEvalsBranch(slug ?? defaultSlug(st.files.map((f) => f.path)));
    const msg = message ?? `evals: ${st.files.map((f) => f.path.replace(/^.*evals\//, "")).slice(0, 3).join(", ")}${st.files.length > 3 ? ` and ${st.files.length - 3} more` : ""}`;
    const commit = this.git.commit(st.files.map((f) => f.path), msg);
    this.pending.clear();
    this.emit({ type: "committed", branch, commit });
    return { status: 200, body: { branch, commit, message: msg, files: st.files.map((f) => f.path) } };
  }
  openPr(title?: string, body?: string): Reply {
    const branch = this.git.branch();
    if (!branch.startsWith("evals/")) throw new HttpError(400, "commit to an evals/ branch first");
    if (this.pending.state().files.length) throw new HttpError(400, "commit or discard pending changes first");
    const t = title ?? `evals: ${branch.slice(6)}`;
    try {
      this.git.run(["push", "-u", "origin", branch]);
      const url = execFileSync("gh", ["pr", "create", "--title", t, "--body", body ?? "Opened from the litmustest Pending changes tray.", "--head", branch], { cwd: this.git.root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
      return { status: 200, body: { url, branch } };
    } catch (e) {
      return { status: 502, body: { error: "pr_failed", message: (e as Error).message.split("\n")[0], command: `git push -u origin ${branch} && gh pr create --head ${branch} --title "${t}"` } };
    }
  }
  discard(paths?: string[]): Reply {
    const st = this.pending.state();
    const rels = paths ? st.files.map((f) => f.path).filter((p) => paths.some((q) => p.endsWith(q.replace(/^\/+/, "")))) : st.files.map((f) => f.path);
    if (!rels.length) throw new HttpError(400, "nothing to discard");
    this.git.discard(rels);
    this.pending.clear(rels);
    this.invalidate();
    this.emit({ type: "discarded", files: rels });
    return { status: 200, body: { discarded: rels } };
  }

  // ---- review queue reads
  batches(): Reply {
    const dir = join(this.evalsDir, "batches");
    const names = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".yaml")).map((f) => f.replace(/\.yaml$/, "")) : [];
    return { status: 200, body: { batches: names.map((n) => { const b = parseYaml(readFileSync(join(dir, `${n}.yaml`), "utf8")) as Obj; return { name: n, created: b.created, source: b.source, items: (b.items as unknown[]).length, labelled: this.labelledCount(b.items as { trace_id: string }[]) }; }) } };
  }
  batch(name: string): Reply {
    const p = join(this.evalsDir, "batches", `${name.replace(/[^a-z0-9_-]/gi, "")}.yaml`);
    if (!existsSync(p)) throw new HttpError(404, `no batch ${name}`);
    const b = parseYaml(readFileSync(p, "utf8")) as Obj;
    const labels = this.labelsByTrace();
    return { status: 200, body: { ...b, items: (b.items as Obj[]).map((it) => ({ ...it, labels: labels.get(String(it.trace_id)) ?? [] })) } };
  }
  trace(id: string): Reply {
    const p = join(this.evalsDir, "datasets", "traces", `${id.replace(/[^a-z0-9_-]/gi, "")}.json`);
    if (!existsSync(p)) throw new HttpError(404, `no trace ${id}`);
    const t = JSON.parse(readFileSync(p, "utf8")) as Obj;
    return { status: 200, body: { trace: t, view: traceView(t), labels: this.labelsByTrace().get(id) ?? [], expected_tools: this.expectedTools(id) } };
  }
  /** Tools a task promoted from this trace requires, so the renderer can flag a call that never happened. */
  private expectedTools(traceId: string): string[] {
    const out = new Set<string>();
    const walk = (d: string) => { if (!existsSync(d)) return; for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); if (e.isDirectory()) walk(p); else if (e.name.endsWith(".yaml")) { try { const t = parseYaml(readFileSync(p, "utf8")) as Obj; if (t.source !== `trace:${traceId}`) continue; for (const c of (t.checks as Obj[]) ?? []) for (const r of (c.required_tools as string[]) ?? []) out.add(r); } catch { /* reported by validate */ } } } };
    walk(join(this.evalsDir, "tasks"));
    return [...out];
  }
  private labelsByTrace(): Map<string, Obj[]> {
    const out = new Map<string, Obj[]>(); const dir = join(this.evalsDir, "labels");
    if (!existsSync(dir)) return out;
    for (const f of readdirSync(dir).filter((x) => x.endsWith(".jsonl"))) for (const l of readFileSync(join(dir, f), "utf8").split("\n")) { if (!l.trim()) continue; try { const o = JSON.parse(l) as Obj; out.set(String(o.trace_id), [...(out.get(String(o.trace_id)) ?? []), o]); } catch { /* reported by validate */ } }
    return out;
  }
  private labelledCount(items: { trace_id: string }[]): number { const m = this.labelsByTrace(); return items.filter((i) => m.has(i.trace_id)).length; }
}

function findPath(evalsDir: string, id: string): string | undefined {
  const walk = (d: string, rel: string): string | undefined => { if (!existsSync(d)) return undefined; for (const e of readdirSync(d, { withFileTypes: true })) { if (e.isDirectory()) { const r = walk(join(d, e.name), `${rel}${e.name}/`); if (r) return r; } else if (e.name === `${id}.yaml`) return `${rel}${e.name}`; } return undefined; };
  return walk(join(evalsDir, "tasks"), "tasks/");
}

export class HttpError extends Error { status: number; constructor(status: number, message: string) { super(message); this.status = status; } }

function defaultSlug(paths: string[]): string {
  const day = new Date().toISOString().slice(0, 10);
  const first = paths[0]?.replace(/^.*evals\//, "").replace(/\.[a-z]+$/, "").split("/").slice(-1)[0] ?? "edit";
  return `${day}-${first.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`;
}

export { createHash };
