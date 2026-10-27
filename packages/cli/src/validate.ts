import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { parse as parseYaml } from "yaml";
import { SchemaSet } from "./schemas.ts";

export type Level = "error" | "warning" | "info";
export interface Problem { level: Level; file: string; message: string; rule?: string }
export interface ValidateOptions { deep?: boolean; python?: string }
export interface ValidateResult {
  root: string;
  problems: Problem[];
  files: number;
  errors: number;
  warnings: number;
}

interface Loaded<T = Record<string, unknown>> { file: string; data: T }
type Obj = Record<string, unknown>;

/** Validate an evals/ directory: every file against its schema, then the cross-file rules. */
export function validateEvals(root: string, opts: ValidateOptions = {}): ValidateResult {
  const schemas = new SchemaSet();
  const problems: Problem[] = [];
  const rel = (p: string) => relative(root, p).split(sep).join("/");
  const add = (level: Level, file: string, message: string, rule?: string) =>
    problems.push({ level, file: rel(file), message, rule });
  let files = 0;

  if (!existsSync(root) || !statSync(root).isDirectory()) {
    return { root, problems: [{ level: "error", file: ".", message: `not a directory: ${root}` }], files: 0, errors: 1, warnings: 0 };
  }

  const read = (file: string): unknown => {
    const text = readFileSync(file, "utf8");
    return file.endsWith(".json") ? JSON.parse(text) : parseYaml(text);
  };
  const load = <T = Obj>(file: string, schema: string): Loaded<T> | undefined => {
    files++;
    let data: unknown;
    try { data = read(file); } catch (e) { add("error", file, `cannot parse: ${(e as Error).message}`, "parse"); return undefined; }
    const errs = schemas.check(schema, data);
    for (const m of errs) add("error", file, m, "schema");
    return errs.length ? undefined : { file, data: data as T };
  };
  const list = (dir: string, ext: string, recursive = false): string[] => {
    const full = join(root, dir);
    if (!existsSync(full)) return [];
    const out: string[] = [];
    const walk = (d: string) => {
      for (const ent of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, ent.name);
        if (ent.isDirectory()) { if (recursive) walk(p); }
        else if (ent.name.endsWith(ext)) out.push(p);
      }
    };
    walk(full);
    return out.sort();
  };
  const stem = (file: string) => basename(file).replace(/\.(ya?ml|json|jsonl)$/, "");

  // ---- config
  const configFile = join(root, "litmustest.yaml");
  let config: Obj | undefined;
  if (!existsSync(configFile)) add("error", configFile, "missing; every evals/ directory needs litmustest.yaml", "layout");
  else config = load(configFile, "config")?.data;
  const trustThreshold = Number((config?.judges as Obj | undefined)?.trust_threshold ?? 90);

  // ---- failure modes
  const failureModes = new Map<string, Loaded>();
  for (const f of list("failure_modes", ".yaml")) {
    const l = load(f, "failure_mode"); if (!l) continue;
    if (l.data.name !== stem(f)) add("error", f, `name '${l.data.name}' must equal the file name '${stem(f)}'`, "name_matches_file");
    failureModes.set(String(l.data.name), l);
  }

  // ---- suites
  const suites = new Map<string, Loaded>();
  for (const f of list("suites", ".yaml")) {
    const l = load(f, "suite"); if (!l) continue;
    if (l.data.name !== stem(f)) add("error", f, `name '${l.data.name}' must equal the file name '${stem(f)}'`, "name_matches_file");
    suites.set(String(l.data.name), l);
  }
  for (const name of Object.keys((config?.gates as Obj | undefined) ?? {})) {
    if (!suites.has(name)) add("warning", configFile, `gate for suite '${name}' but no suites/${name}.yaml`, "gate_suite_exists");
  }

  // ---- judges and calibration
  interface JudgeInfo { judge?: Loaded; calibration?: Loaded; dir: string }
  const judges = new Map<string, JudgeInfo>();
  const judgesDir = join(root, "graders", "judges");
  if (existsSync(judgesDir)) {
    for (const ent of readdirSync(judgesDir, { withFileTypes: true })) {
      if (!ent.isDirectory()) continue;
      const dir = join(judgesDir, ent.name);
      const info: JudgeInfo = { dir };
      const jf = join(dir, "judge.yaml");
      const cf = join(dir, "calibration.json");
      if (existsSync(jf)) info.judge = load(jf, "judge"); else add("warning", jf, "no judge.yaml yet; a judge directory needs prompt.md, judge.yaml and calibration.json", "layout");
      if (existsSync(cf)) info.calibration = load(cf, "calibration");
      judges.set(ent.name, info);
      const j = info.judge?.data, c = info.calibration?.data;
      if (j) {
        if (j.id !== ent.name) add("error", jf, `id '${j.id}' must equal the directory name '${ent.name}'`, "name_matches_file");
        if (!failureModes.has(String(j.failure_mode))) add("error", jf, `failure_mode '${j.failure_mode}' does not exist`, "failure_mode_exists");
        const promptFile = join(root, String(j.prompt));
        if (!existsSync(promptFile)) add("error", jf, `prompt file '${j.prompt}' not found`, "prompt_exists");
        else {
          const hash = sha256(readFileSync(promptFile));
          if (hash !== j.prompt_hash) add("warning", jf, `prompt_hash does not match ${j.prompt} (${hash.slice(0, 12)}…); the judge is stale until re-calibrated`, "prompt_hash");
          else if (c && c.prompt_hash !== j.prompt_hash && c.status === "trusted")
            add("error", cf, `status is trusted but calibration measured a different prompt; expected status stale`, "stale_on_change");
        }
        if (c && c.model !== j.model && c.status === "trusted")
          add("error", cf, `status is trusted but the judge's model changed (${c.model} → ${j.model}); expected status stale`, "stale_on_change");
      }
      if (c) {
        if (c.judge !== ent.name) add("error", cf, `judge '${c.judge}' must equal the directory name '${ent.name}'`, "name_matches_file");
        const splits = c.splits as Record<string, { trace_ids: string[] }>;
        const sets = { train: new Set(splits.train.trace_ids), dev: new Set(splits.dev.trace_ids), test: new Set(splits.test.trace_ids) };
        for (const [a, b] of [["train", "dev"], ["train", "test"], ["dev", "test"]] as const) {
          const overlap = [...sets[a]].filter((id) => sets[b].has(id));
          if (overlap.length) add("error", cf, `splits ${a} and ${b} share trace ids: ${overlap.slice(0, 3).join(", ")}${overlap.length > 3 ? "…" : ""}`, "splits_disjoint");
        }
        if (c.status === "trusted") {
          const t = c.test as { tpr: number; tnr: number } | null;
          if (!t) add("error", cf, "status is trusted but test is null", "trusted_requires_test");
          else if (t.tpr < trustThreshold || t.tnr < trustThreshold)
            add("error", cf, `status is trusted but test TPR ${t.tpr} / TNR ${t.tnr} is below the threshold ${trustThreshold}`, "trust_threshold");
        }
        const fewShot = (j?.few_shot as { trace_id: string }[] | undefined) ?? [];
        for (const ex of fewShot) {
          if (sets.dev.has(ex.trace_id) || sets.test.has(ex.trace_id))
            add("error", info.judge!.file, `few_shot trace '${ex.trace_id}' is in the dev or test split (leakage)`, "no_leakage");
          else if (!sets.train.has(ex.trace_id))
            add("warning", info.judge!.file, `few_shot trace '${ex.trace_id}' is not in the train split`, "few_shot_from_train");
        }
      }
    }
  }

  // ---- tasks
  const tasks = new Map<string, Loaded>();
  const taskSuite = new Map<string, string>();
  for (const f of list("tasks", ".yaml", true)) {
    const l = load(f, "task"); if (!l) continue;
    const t = l.data;
    if (t.id !== stem(f)) add("error", f, `id '${t.id}' must equal the file name '${stem(f)}'`, "name_matches_file");
    tasks.set(String(t.id), l);
    taskSuite.set(String(t.id), String(t.suite));
    if (!suites.has(String(t.suite))) add("error", f, `suite '${t.suite}' does not exist under suites/`, "suite_exists");
    const refPath = join(root, String(t.reference_solution));
    let ref: Loaded | undefined;
    if (!existsSync(refPath)) add("error", f, `reference_solution '${t.reference_solution}' not found`, "reference_exists");
    else {
      ref = load(refPath, "reference_solution");
      if (ref && ref.data.task !== t.id) add("error", refPath, `task '${ref.data.task}' must equal the task id '${t.id}'`, "reference_task_matches");
    }
    const ids = new Set<string>();
    for (const raw of t.checks as Obj[]) {
      const id = String(raw.id);
      if (ids.has(id)) add("error", f, `check id '${id}' is used twice`, "check_ids_unique"); ids.add(id);
      const fm = raw.failure_mode as string | undefined;
      if (fm !== undefined) {
        const mode = failureModes.get(fm);
        if (!mode) add("error", f, `check '${id}': failure_mode '${fm}' does not exist`, "failure_mode_exists");
        else if (mode.data.retired) add("error", f, `check '${id}': failure_mode '${fm}' is retired${mode.data.merged_into ? ` (merged into ${mode.data.merged_into})` : ""}`, "failure_mode_not_retired");
      }
      if (raw.type === "judge") {
        const jname = String(raw.judge ?? fm);
        const info = judges.get(jname);
        if (!info?.judge) add("error", f, `check '${id}': judge '${jname}' has no graders/judges/${jname}/judge.yaml`, "judge_exists");
        else {
          if (info.judge.data.failure_mode !== fm) add("error", f, `check '${id}': judge '${jname}' detects '${info.judge.data.failure_mode}', not '${fm}'`, "judge_failure_mode_matches");
          if (!info.calibration) add("error", f, `check '${id}': judge '${jname}' has no calibration.json; run litmustest calibrate ${jname}`, "judge_calibrated");
          else if (info.calibration.data.status !== "trusted")
            add("warning", f, `check '${id}': judge '${jname}' is ${info.calibration.data.status}; its verdicts will not count in gates`, "judge_trusted");
        }
      }
      if (raw.type === "code") {
        const fn = join(root, String(raw.fn));
        if (!existsSync(fn)) add("error", f, `check '${id}': fn '${raw.fn}' not found`, "code_fn_exists");
      }
    }
    if (opts.deep && ref) deepCheck(root, l, ref, add, opts.python ?? "python3");
  }

  // ---- suite membership
  for (const [name, s] of suites) {
    for (const id of (s.data.tasks as string[] | undefined) ?? []) {
      if (!tasks.has(id)) add("error", s.file, `task '${id}' does not exist`, "task_exists");
      else if (taskSuite.get(id) !== name) add("error", s.file, `task '${id}' declares suite '${taskSuite.get(id)}', not '${name}'`, "task_suite_matches");
    }
  }

  // ---- labels
  const traceDir = join(root, "datasets", "traces");
  const haveTraces = existsSync(traceDir) && readdirSync(traceDir).length > 0;
  for (const f of list("labels", ".jsonl")) {
    files++;
    const lines = readFileSync(f, "utf8").split("\n");
    lines.forEach((line, i) => {
      if (!line.trim()) return;
      let data: unknown;
      try { data = JSON.parse(line); } catch (e) { add("error", f, `line ${i + 1}: cannot parse: ${(e as Error).message}`, "parse"); return; }
      for (const m of schemas.check("label", data)) add("error", f, `line ${i + 1}: ${m}`, "schema");
      const fm = (data as Obj).failure_mode;
      if (fm !== "overall" && typeof fm === "string" && !failureModes.has(fm)) add("error", f, `line ${i + 1}: failure_mode '${fm}' does not exist`, "failure_mode_exists");
      const tid = (data as Obj).trace_id;
      if (haveTraces && typeof tid === "string" && !existsSync(join(traceDir, `${tid}.json`))) add("warning", f, `line ${i + 1}: trace '${tid}' not found under datasets/traces/`, "trace_exists");
    });
  }

  // ---- batches
  const batchTraceIds = (dir: string) => existsSync(dir) ? new Set(readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => f.replace(/\.json$/, ""))) : new Set<string>();
  const knownTraces = batchTraceIds(traceDir);
  for (const f of list("batches", ".yaml")) {
    const l = load(f, "batch"); if (!l) continue;
    if (l.data.name !== stem(f)) add("error", f, `name '${l.data.name}' must equal the file name '${stem(f)}'`, "name_matches_file");
    const ids = new Set<string>();
    for (const it of l.data.items as { trace_id: string }[]) {
      if (ids.has(it.trace_id)) add("error", f, `trace '${it.trace_id}' appears twice`, "batch_items_unique"); ids.add(it.trace_id);
      if (!knownTraces.has(it.trace_id)) add("error", f, `trace '${it.trace_id}' not found under datasets/traces/`, "trace_exists");
    }
  }

  // ---- traces, runs
  for (const f of [...list("datasets/traces", ".json"), ...list("datasets/synthetic", ".json")]) {
    const l = load(f, "trace"); if (!l) continue;
    if (l.data.id !== stem(f)) add("error", f, `id '${l.data.id}' must equal the file name '${stem(f)}'`, "name_matches_file");
  }
  for (const f of list("runs", ".json")) {
    const l = load(f, "run_summary"); if (!l) continue;
    if (l.data.run_id !== stem(f)) add("error", f, `run_id '${l.data.run_id}' must equal the file name '${stem(f)}'`, "name_matches_file");
    for (const s of Object.keys(l.data.suites as Obj)) if (!suites.has(s)) add("warning", f, `suite '${s}' no longer exists`, "suite_exists");
    for (const t of Object.keys(l.data.tasks as Obj)) if (!tasks.has(t)) add("warning", f, `task '${t}' no longer exists`, "task_exists");
  }

  const errors = problems.filter((p) => p.level === "error").length;
  const warnings = problems.filter((p) => p.level === "warning").length;
  return { root, problems, files, errors, warnings };
}

export function sha256(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

function getPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const part of path.split(".")) {
    const m = /^([A-Za-z0-9_]+)(?:\[(\d+)\])?$/.exec(part);
    if (!m || cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Obj)[m[1]!];
    if (m[2] !== undefined) cur = Array.isArray(cur) ? cur[Number(m[2])] : undefined;
  }
  return cur;
}

/** --deep: run every check it can against the reference solution. Judge checks need a model and are skipped here. */
function deepCheck(root: string, task: Loaded, ref: Loaded, add: (l: Level, f: string, m: string, r?: string) => void, python: string) {
  const r = ref.data;
  const toolCalls = ((r.tool_calls as { name: string }[] | undefined) ?? []).map((c) => c.name);
  const turns = (r.transcript as { role: string }[] | undefined) ?? [];
  for (const raw of task.data.checks as Obj[]) {
    const id = String(raw.id);
    const fail = (why: string) => add("error", task.file, `deep: check '${id}' fails against ${task.data.reference_solution}: ${why}`, "reference_passes");
    switch (raw.type) {
      case "outcome": {
        for (const [path, want] of Object.entries(raw.expect as Obj)) {
          const got = getPath(r.state, path);
          if (JSON.stringify(got) !== JSON.stringify(want)) fail(`expected ${path} = ${JSON.stringify(want)}, reference state has ${JSON.stringify(got)}`);
        }
        break;
      }
      case "transcript": {
        const agentTurns = turns.filter((t) => t.role === "agent").length;
        if (raw.max_turns !== undefined && agentTurns > Number(raw.max_turns)) fail(`${agentTurns} agent turns, max ${raw.max_turns}`);
        if (raw.max_toolcalls !== undefined && toolCalls.length > Number(raw.max_toolcalls)) fail(`${toolCalls.length} tool calls, max ${raw.max_toolcalls}`);
        for (const t of (raw.required_tools as string[] | undefined) ?? []) if (!toolCalls.includes(t)) fail(`required tool '${t}' never called`);
        for (const t of (raw.forbidden_tools as string[] | undefined) ?? []) if (toolCalls.includes(t)) fail(`forbidden tool '${t}' was called`);
        break;
      }
      case "code": {
        const fn = resolve(root, String(raw.fn));
        if (!existsSync(fn)) break; // already reported
        const script = [
          "import importlib.util, json, sys",
          "fn, trial, args = sys.argv[1], json.loads(sys.argv[2]), json.loads(sys.argv[3])",
          "spec = importlib.util.spec_from_file_location('grader', fn); m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)",
          "print(json.dumps({'pass': bool(m.check(trial, args))}))",
        ].join("\n");
        const trial = { input: task.data.input, ...r };
        const res = spawnSync(python, ["-I", "-c", script, fn, JSON.stringify(trial), JSON.stringify(raw.args ?? {})], { encoding: "utf8", cwd: dirname(root), timeout: 30_000 });
        if (res.error) { add("error", task.file, `deep: check '${id}': cannot run ${python}: ${res.error.message}`, "python"); break; }
        if (res.status !== 0) { fail(`${raw.fn} raised: ${res.stderr.trim().split("\n").pop()}`); break; }
        let out: { pass: boolean };
        try { out = JSON.parse(res.stdout.trim().split("\n").pop() ?? ""); } catch { fail(`${raw.fn} printed no JSON verdict`); break; }
        if (!out.pass) fail(`${raw.fn} returned False`);
        break;
      }
      case "judge":
        add("info", task.file, `deep: check '${id}' is a judge check; it runs under litmustest run, not validate`, "judge_not_run");
        break;
    }
  }
}
