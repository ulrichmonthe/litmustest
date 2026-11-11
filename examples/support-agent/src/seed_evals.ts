// Seed the example's evals/ directory from the catalog and the planted truth. Deterministic; re-run freely.
// Produces: litmustest.yaml, 7 failure modes, ~40 tasks with reference solutions, 2 code checks, 2 judges
// (tone_mismatch trusted, missed_refund stale), 100 labels, three suites, two run summaries.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { stringify as yaml } from "yaml";
import { ACCOUNTS, FAILURE_MODES, PERSONAS, SCENARIOS, mulberry32, pick, type Persona, type Scenario } from "./catalog.ts";
import { BREEZY, OPENERS, generateAll, type Planted } from "./generate_traces.ts";

const here = dirname(fileURLToPath(import.meta.url));
const EVALS = join(here, "..", "evals");
// Transcripts and grades for the seeded runs; the store litmustest.yaml names, git-ignored like a real run's.
const STORE = join(here, "..", ".litmustest", "transcripts");
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const write = (rel: string, body: string) => { const p = join(EVALS, rel); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, body); };
const rng = mulberry32(7);

// wipe everything except datasets/traces, which generate_traces owns
for (const d of ["failure_modes", "tasks", "refs", "graders", "labels", "suites", "runs", "datasets/synthetic"]) rmSync(join(EVALS, d), { recursive: true, force: true });
if (!existsSync(join(EVALS, "datasets", "traces"))) throw new Error("run generate_traces first");
write(".gitkeep_synthetic", ""); rmSync(join(EVALS, ".gitkeep_synthetic")); mkdirSync(join(EVALS, "datasets", "synthetic"), { recursive: true }); write("datasets/synthetic/.gitkeep", "");

// ---- config
write("litmustest.yaml", `# evals/litmustest.yaml for the support-agent example\n` + yaml({
  version: 1, project: "support_agent",
  sources: { traces: { format: "jsonl", path: "examples/support-agent/traces/support.jsonl" }, sampler: { every: "manual", size: 60, clusters: 8 } },
  runs: { trials: 5, concurrency: 4, budget_usd: 10, environment: "inprocess", resources: { timeout_s: 180 } },
  agent: { command: "node examples/support-agent/src/run_trial.ts --task {task} --trial-dir {trial_dir}", cwd: "." },
  judges: { default_model: "claude-sonnet-5-5", trust_threshold: 90, stale_on_change: true, correct_for_judge_error: true },
  gates: { regression: { min_pass_rate: 95, max_drop_pts: 2, trusted_judges_only: true }, capability: { report_only: true }, quality: { min_pass_rate: 80, trusted_judges_only: true } },
  storage: { summaries: "evals/runs", transcripts: { backend: "local", path: ".litmustest/transcripts" } },
  ci: { pr_comment: true },
}));

// ---- failure modes
const { planted } = generateAll();
for (const f of FAILURE_MODES) {
  const examples = planted.filter((p) => p.failures.includes(f.name)).slice(0, 3).map((p) => p.trace_id);
  write(`failure_modes/${f.name}.yaml`, yaml({ name: f.name, definition: f.definition, severity: f.severity, owner: f.owner, examples, created: "2026-10-21" }));
}

// ---- code checks
write("graders/code/identity_verified_first.py", `"""identity_verified_first: verify_identity must succeed before any account lookup or change.

Fails when fetch_invoices, process_refund or send_confirmation is called before a successful
verify_identity, or when verify_identity never succeeded but account details were used.
"""


def check(trial: dict, args: dict) -> bool:
    verified = False
    gated = set(args.get("gated", ["fetch_invoices", "process_refund", "send_confirmation"]))
    for call in trial.get("tool_calls", []):
        name = call.get("name")
        result = call.get("result") or {}
        if name == "verify_identity":
            if isinstance(result, dict) and result.get("verified"):
                verified = True
            continue
        if name in gated and not verified:
            return False
    return True
`);
write("graders/code/confirmation_sent.py", `"""confirmation_sent: every account change is followed by send_confirmation.

A change is a successful process_refund. Fails when a change happened and no
send_confirmation call follows it in the transcript.
"""


def check(trial: dict, args: dict) -> bool:
    calls = trial.get("tool_calls", [])
    last_change = -1
    for i, call in enumerate(calls):
        result = call.get("result") or {}
        if call.get("name") == "process_refund" and isinstance(result, dict) and "refund" in result:
            last_change = i
    if last_change < 0:
        return True
    return any(c.get("name") == "send_confirmation" for c in calls[last_change + 1:])
`);

// ---- labels: 100 lines, 50 per judged failure mode, drawn from the planted truth with class balance
function labelsFor(mode: string, n: number): Planted[] {
  const pos = planted.filter((p) => p.failures.includes(mode));
  const neg = planted.filter((p) => !p.failures.includes(mode) && (mode !== "missed_refund" || SCENARIOS.find((s) => s.id === p.scenario)!.refund));
  const shuffle = <T,>(xs: T[]) => xs.map((x) => [rng(), x] as const).sort((a, b) => a[0] - b[0]).map((x) => x[1]);
  const half = Math.min(pos.length, Math.floor(n / 2));
  return shuffle([...shuffle(pos).slice(0, half), ...shuffle(neg).slice(0, n - half)]);
}
const labelled: Record<string, Planted[]> = { tone_mismatch: labelsFor("tone_mismatch", 50), missed_refund: labelsFor("missed_refund", 50) };
const lines: string[] = [];
let minute = 0;
for (const [mode, ps] of Object.entries(labelled)) for (const p of ps) {
  const fail = p.failures.includes(mode);
  const at = new Date(Date.UTC(2026, 9, 22, 9, minute++)).toISOString().replace(".000Z", "Z");
  lines.push(JSON.stringify({ trace_id: p.trace_id, failure_mode: mode, label: fail ? "Fail" : "Pass", note: fail ? `${mode} in a ${p.persona} ${p.scenario} conversation` : "fine", annotator: "ulrich", at, rubric_version: 1, batch: "2026-10-22" }));
}
write("labels/2026-10-22.jsonl", lines.join("\n") + "\n");

// ---- judges
function judge(name: string, trusted: boolean) {
  const prompt = `# ${name} judge\n\nYou check one failure mode: **${name}**.\n\n${FAILURE_MODES.find((f) => f.name === name)!.definition}\n\nRead the transcript${name === "missed_refund" ? " and the end state" : ""}. Write a short critique first: what the customer needed, what the agent did, and whether the definition above is met. Then give one verdict: Pass (the failure is absent), Fail (the failure is present) or Unknown (you cannot tell from what you were shown).\n\nAnswer as JSON with keys critique and result.\n`;
  const ids = labelled[name]!.map((p) => p.trace_id);
  const train = ids.slice(0, 8), dev = ids.slice(8, 30), test = ids.slice(30, 50);
  const splitHash = (xs: string[]) => sha([...xs].sort().join("\n"));
  // a clear Fail, a clear Pass, and one more: the lint on the judge editor wants both labels among the examples
  const byLabel = (fail: boolean) => train.filter((id) => planted.find((x) => x.trace_id === id)!.failures.includes(name) === fail);
  const picks = [byLabel(true)[0], byLabel(false)[0], byLabel(true)[1] ?? byLabel(false)[1]].filter((x): x is string => Boolean(x));
  const fewShot = picks.map((id) => { const p = planted.find((x) => x.trace_id === id)!; const fail = p.failures.includes(name); return { trace_id: id, label: fail ? "Fail" : "Pass", note: fail ? `${name} is present: see the agent's reply.` : `No ${name}: the agent handled it correctly.` }; });
  const currentHash = sha(prompt);
  const measuredHash = trusted ? currentHash : sha(prompt + "\n(previous version)\n");
  write(`graders/judges/${name}/prompt.md`, prompt);
  write(`graders/judges/${name}/judge.yaml`, yaml({ id: name, failure_mode: name, model: "claude-sonnet-5-5", inputs: name === "missed_refund" ? ["transcript", "state", "tool_calls"] : ["transcript", "input"],
    output: { critique: { type: "string", max_chars: 800 }, result: { enum: ["Pass", "Fail", "Unknown"] } }, few_shot: fewShot, prompt: `graders/judges/${name}/prompt.md`, prompt_hash: currentHash, temperature: 0, version: trusted ? 2 : 3 }));
  const devM = trusted ? { tp: 10, tn: 10, fp: 1, fn: 1, unknown: 0 } : { tp: 9, tn: 11, fp: 1, fn: 1, unknown: 0 };
  const testM = trusted ? { tp: 9, tn: 10, fp: 0, fn: 1, unknown: 0 } : { tp: 8, tn: 10, fp: 1, fn: 1, unknown: 0 };
  const rate = (m: typeof devM) => ({ tpr: +(100 * m.tp / (m.tp + m.fn)).toFixed(1), tnr: +(100 * m.tn / (m.tn + m.fp)).toFixed(1) });
  write(`graders/judges/${name}/calibration.json`, JSON.stringify({
    judge: name, prompt_hash: measuredHash, model: "claude-sonnet-5-5",
    splits: { train: { trace_ids: train, hash: splitHash(train) }, dev: { trace_ids: dev, hash: splitHash(dev) }, test: { trace_ids: test, hash: splitHash(test) } },
    dev: { ...rate(devM), matrix: devM, runs: [{ ran_at: "2026-10-24T10:00:00Z", prompt_hash: measuredHash, version: trusted ? 2 : 2, ...rate(devM), matrix: devM }] },
    test: { ...rate(testM), matrix: testM, ran_at: "2026-10-25T10:00:00Z", prompt_hash: measuredHash },
    status: trusted ? "trusted" : "stale", ...(trusted ? {} : { stale_reason: "prompt_changed" }),
    disagreements: [{ trace_id: dev[3]!, human: "Pass", judge: "Fail", critique: "Read a terse reply as a tone problem." }],
  }, null, 2) + "\n");
}
judge("tone_mismatch", true);
judge("missed_refund", false);

// ---- tasks and reference solutions
interface TaskSpec { id: string; sc: Scenario; persona: Persona; suite: string; source: string; broken?: boolean; flaky?: boolean }
const specs: TaskSpec[] = [];
for (const sc of SCENARIOS) for (const persona of PERSONAS) {
  const id = `${sc.id}_${persona}`;
  const suite = sc.suite === "quality" ? "quality" : sc.source.startsWith("spec:") ? "capability" : "regression";
  specs.push({ id, sc, persona, suite, source: sc.source.startsWith("trace:") ? `trace:${planted.find((p) => p.scenario === sc.id && p.persona === persona)?.trace_id ?? sc.source.slice(6)}` : sc.source });
}
// extra capability tasks written from the spec, before the agent can pass them
for (const [sc, persona, slug] of [["duplicate_charge", "business", "refund-batch"], ["refund_outside_window", "business", "goodwill-credit"], ["cancel_monthly", "first_time", "pause-plan"], ["vat_invoice", "first_time", "vat-self-serve"], ["failed_payment", "business", "retry-now"], ["invoice_copy", "first_time", "invoice-history"], ["pro_refund_in_window", "business", "partial-refund"]] as const)
  specs.push({ id: `${slug.replace(/-/g, "_")}_${persona}`, sc: SCENARIOS.find((s) => s.id === sc)!, persona, suite: "capability", source: `spec:${slug}` });
// quality: judge-only tasks over tone
for (const persona of ["frustrated", "business"] as const) specs.push({ id: `tone_only_${persona}`, sc: SCENARIOS.find((s) => s.id === "invoice_copy")!, persona, suite: "quality", source: "trace:tr_0090" });
// the deliberately broken task: an account that is not in the database, so no agent can verify it
// Its reference was written against an account that was later deleted, so the reference passes its checks but no agent can reproduce it.
specs.push({ id: "refund_ghost_account_frustrated", persona: "frustrated", suite: "regression", source: "trace:tr_0007", broken: true,
  sc: { ...SCENARIOS[0]!, id: "ghost", account: "acc_9999", message: { ...SCENARIOS[0]!.message, frustrated: "I'm Dmitri Volkov, dmitri@volkov.example, charged twice. Refund it." },
    tools: [{ name: "verify_identity", args: { email: "dmitri@volkov.example" } }, { name: "fetch_invoices", args: { account_id: "acc_9999" } }, { name: "process_refund", args: { invoice_id: "inv_9999_b", reason: "duplicate charge" } }, { name: "send_confirmation", args: { account_id: "acc_9999", subject: "Refund of duplicate charge" } }],
    reply: "I'm sorry about the double charge. I've refunded the duplicate $19.99 to your card ending 0000 and emailed a confirmation." } });
specs.find((s) => s.id === "invoice_copy_frustrated")!.flaky = true;

const taskIds: Record<string, string[]> = { regression: [], capability: [], quality: [] };
const taskChecks = new Map<string, Record<string, unknown>[]>();
for (const s of specs) {
  const dir = s.suite;
  const acc = ACCOUNTS.find((a) => a.id === s.sc.account);
  const checks: Record<string, unknown>[] = [];
  const expect = { ...s.sc.expect };
  if (s.suite !== "quality") {
    checks.push({ id: "end_state", type: "outcome", backend: "sql", expect, weight: 3 });
    checks.push({ id: "identity_first", type: "code", fn: "graders/code/identity_verified_first.py", weight: 2, failure_mode: "identity_leak" });
    if (s.sc.refund) checks.push({ id: "confirmed", type: "code", fn: "graders/code/confirmation_sent.py", weight: 1, failure_mode: "skipped_confirmation" });
    if (s.sc.refund) checks.push({ id: "missed_refund", type: "judge", failure_mode: "missed_refund", weight: 2 });
    checks.push({ id: "bounded", type: "transcript", path_check: true, max_toolcalls: s.sc.tools.length + 2, required_tools: ["verify_identity"], failure_mode: "over_searching" });
  }
  checks.push({ id: "tone", type: "judge", failure_mode: "tone_mismatch", weight: 1 });
  const task: Record<string, unknown> = {
    id: s.id, suite: s.suite, source: s.source,
    description: `${s.persona} customer, ${s.sc.id.replace(/_/g, " ")}.${s.broken ? " Deliberately broken: the account does not exist, so the ideal path is unreachable." : ""}${s.flaky ? " Known flaky: the agent sometimes answers from the first invoice without sending the copy." : ""}${s.sc.id === "cancel_monthly" ? " Capability: the agent has no cancellation tool yet, so this cannot pass until one ships." : ""}`,
    input: { persona: s.persona, from: s.sc.tools[0]!.args.email, message: s.sc.message[s.persona], goal: s.sc.reply.split(".")[0] },
    reference_solution: `refs/${s.id}.json`, trials: 5, checks, report: ["strict_pass", "weighted_score", "pass_at_k", "pass_hat_k"],
    tags: [s.sc.id, s.persona],
  };
  write(`tasks/${dir}/${s.id}.yaml`, yaml(task));
  taskIds[s.suite]!.push(s.id); taskChecks.set(s.id, checks);
  // reference solution: the ideal path from the catalog
  const toolCalls = s.sc.tools.map((t) => ({ name: t.name, args: t.args, result: refResult(t.name, t.args, s.sc) }));
  const state: Record<string, unknown> = { refunds: { count: 0, status: "none", amount_cents: 0 }, tickets: { status: "none" }, confirmations: { sent: 0 } };
  if (s.sc.refund) { const inv = acc?.invoices.find((x) => x.id === s.sc.tools.find((t) => t.name === "process_refund")!.args.invoice_id); state.refunds = { count: 1, status: "processed", amount_cents: inv?.amount_cents ?? 1999 }; }
  if (s.sc.tools.some((t) => t.name === "send_confirmation")) { state.confirmations = { sent: 1 }; state.tickets = { status: "resolved" }; }
  const transcript = [{ role: "user", content: `From: ${s.sc.tools[0]!.args.email}\n\n${s.sc.message[s.persona]}` }, ...toolCalls.map((c) => ({ role: "tool", tool: c.name, content: JSON.stringify(c.result) })), { role: "agent", content: s.sc.reply }];
  write(`refs/${s.id}.json`, JSON.stringify({ task: s.id, output: s.sc.reply, state, tool_calls: toolCalls, transcript, note: "Ideal path from the scenario catalog.", author: "ulrich", at: "2026-10-23T12:00:00Z" }, null, 2) + "\n");
}
function refResult(name: string, args: Record<string, unknown>, sc: Scenario): unknown {
  const acc = ACCOUNTS.find((a) => a.id === sc.account);
  if (name === "verify_identity" && sc.id === "ghost") return { verified: true, account_id: "acc_9999", name: "Dmitri Volkov", plan: "pro" };
  if (name === "verify_identity") return acc && String(args.email) === acc.email ? { verified: true, account_id: acc.id, name: acc.name, plan: acc.plan } : { verified: false, error: "not_found" };
  if (name === "fetch_invoices") return acc?.invoices.map((x) => ({ id: x.id, amount_cents: x.amount_cents, issued: x.issued, status: x.status, note: x.note ?? null })) ?? [];
  if (name === "fetch_policy") return { topic: args.topic, policy: "(see policy)" };
  if (name === "process_refund") { const inv = acc?.invoices.find((x) => x.id === args.invoice_id); return { refund: { invoice_id: args.invoice_id, amount_cents: inv?.amount_cents ?? 0, status: "processed" } }; }
  return { sent: true };
}

// ---- suites
write("suites/regression.yaml", yaml({ name: "regression", kind: "regression", description: "Promoted from production traces. Must stay near 100%.", tasks: taskIds.regression, gate: { min_pass_rate: 95, max_drop_pts: 2 }, path_checks: true }));
write("suites/capability.yaml", yaml({ name: "capability", kind: "capability", description: "Written from the spec before the agent could pass them. The hill to climb.", tasks: taskIds.capability, gate: { report_only: true }, path_checks: false }));
write("suites/quality.yaml", yaml({ name: "quality", kind: "quality", description: "Judge-only tasks on tone. Trusted judges only.", tasks: taskIds.quality, gate: { min_pass_rate: 80, trusted_judges_only: true } }));

// ---- two run summaries, consistent with the broken and flaky tasks
function runSummary(runId: string, commit: string, day: number, shift: number) {
  const r = mulberry32(day);
  rmSync(join(STORE, runId), { recursive: true, force: true });
  const tasks: Record<string, unknown> = {}; const perSuite: Record<string, { pass: number; n: number; all: number }> = {};
  for (const s of specs) {
    const base = s.suite === "regression" ? 0.96 : s.suite === "capability" ? 0.55 + shift : 0.8;
    const p = s.broken ? 0 : s.flaky ? 0.5 : base;
    const trials = Array.from({ length: 5 }, (_, i) => {
      const n = i + 1; const infra = r() < 0.02; const pass = !infra && r() < p;
      const drawn = pass || infra ? [] : [s.sc.refund && r() < 0.5 ? "end_state" : "tone"];
      const failed = s.broken && drawn.length ? ["end_state"] : drawn; // the ghost account never reaches the end state
      const tokens = 1800 + Math.floor(r() * 900), latency_ms = 4000 + Math.floor(r() * 5000), cost_usd = +(0.02 + r() * 0.02).toFixed(4);
      r(); // kept so the numbers above stay the same as before transcripts were seeded
      writeTrial(runId, s, n, { pass, failed, infra, tokens, latency_ms, at: `2026-10-${day}T08:${String(2 + i).padStart(2, "0")}:00Z` });
      return { pass, failed_checks: failed, infra_error: infra, ...(infra ? { infra_error_kind: "timeout" } : {}), tokens, latency_ms, cost_usd, transcript_ref: `local:${runId}/${s.id}/${n}` };
    });
    const scored = trials.filter((t) => !t.infra_error); const passed = scored.filter((t) => t.pass).length;
    tasks[s.id] = { suite: s.suite, strict_pass: scored.length ? +(100 * passed / scored.length).toFixed(1) : 0, weighted: scored.length ? +(100 * (passed + 0.4 * (scored.length - passed)) / scored.length).toFixed(1) : 0, ...(s.flaky ? { flaky: true } : {}), ...(s.broken ? { likely_broken: true } : {}), trials };
    const ps = (perSuite[s.suite] ??= { pass: 0, n: 0, all: 0 }); ps.pass += passed; ps.n += scored.length; ps.all += passed === scored.length && scored.length ? 1 : 0;
  }
  const suites: Record<string, unknown> = {};
  for (const [name, ps] of Object.entries(perSuite)) { const rate = +(100 * ps.pass / ps.n).toFixed(1); const half = +(1.96 * Math.sqrt(rate * (100 - rate) / ps.n)).toFixed(1); suites[name] = { pass_rate: rate, ci: { low: Math.max(0, +(rate - half).toFixed(1)), high: Math.min(100, +(rate + half).toFixed(1)), method: "bootstrap" }, pass_at_1: rate, pass_hat_k: +(100 * ps.all / taskIds[name]!.length).toFixed(1), k: 5, n_tasks: taskIds[name]!.length, excluded_judges: ["missed_refund"] }; }
  const all = Object.values(tasks).flatMap((t) => (t as { trials: { infra_error: boolean; cost_usd: number }[] }).trials);
  write(`runs/${runId}.json`, JSON.stringify({ run_id: runId, commit, branch: "main", started_at: `2026-10-${day}T08:00:00Z`, finished_at: `2026-10-${day}T08:31:00Z`, config_hash: sha(readFileSync(join(EVALS, "litmustest.yaml"), "utf8")), trials: 5, suites, tasks,
    infra_error_rate: +(100 * all.filter((t) => t.infra_error).length / all.length).toFixed(1), cost_usd: +all.reduce((a, t) => a + t.cost_usd, 0).toFixed(2),
    judge_corrections: [{ judge: "tone_mismatch", tpr: 90.0, tnr: 100.0, prompt_hash: sha(readFileSync(join(EVALS, "graders/judges/tone_mismatch/prompt.md"), "utf8")) }] }, null, 2) + "\n");
}

/** One trial's transcript and grades in the store, in the shape `litmustest run` writes, consistent with its summary line. */
function writeTrial(runId: string, s: TaskSpec, n: number, t: { pass: boolean; failed: string[]; infra: boolean; tokens: number; latency_ms: number; at: string }) {
  const dir = join(STORE, runId, s.id, String(n)); mkdirSync(dir, { recursive: true });
  const out = (name: string, body: unknown) => writeFileSync(join(dir, name), typeof body === "string" ? body : JSON.stringify(body, null, 2) + "\n");
  if (t.infra) {
    out("stderr.txt", `trial ${n}: no reply from the model after 180 s; killed by the runner\n`);
    out("grades.json", { run_id: runId, task: s.id, trial: n, pass: false, infra_error: true, infra_error_kind: "timeout", infra_message: "agent killed after 180 s", grades: [], triage_suggested: "infra" });
    return;
  }
  const rr = mulberry32(runId.length * 1000 + s.id.length * 31 + n);
  const ghost = Boolean(s.broken), missed = t.failed.includes("end_state") && !ghost, breezy = t.failed.includes("tone");
  const acc = ACCOUNTS.find((a) => a.id === s.sc.account);
  const calls: { name: string; args: Record<string, unknown>; result: unknown }[] = [];
  for (const tool of s.sc.tools) {
    if (ghost && tool.name !== "verify_identity") continue; // not found: the agent stops
    if (missed && (tool.name === "process_refund" || tool.name === "send_confirmation")) continue;
    calls.push({ name: tool.name, args: tool.args, result: ghost ? { verified: false, error: "not_found" } : refResult(tool.name, tool.args, s.sc) });
  }
  const body = ghost ? "I can't find an account for dmitri@volkov.example, so I can't see the charges or refund anything. If you signed up with a different address, write from that one and I'll deal with it straight away."
    : missed ? "I've noted the issue on your account and flagged it for the billing team. You should hear back within a few days."
    : s.sc.reply;
  const reply = `${breezy ? pick(rr, BREEZY) : pick(rr, OPENERS[s.persona])} ${body}`;
  const refunded = calls.some((c) => c.name === "process_refund"), confirmed = calls.some((c) => c.name === "send_confirmation");
  const inv = acc?.invoices.find((x) => x.id === s.sc.tools.find((c) => c.name === "process_refund")?.args.invoice_id);
  const state = { refunds: refunded ? { count: 1, status: "processed", amount_cents: inv?.amount_cents ?? 1999 } : { count: 0, status: "none", amount_cents: 0 }, tickets: { status: confirmed ? "resolved" : "none" }, confirmations: { sent: confirmed ? 1 : 0 }, audit: { tool_calls: calls.map((c) => c.name) } };
  const transcript = [{ role: "user", content: `From: ${s.sc.tools[0]!.args.email}\n\n${s.sc.message[s.persona]}` }, ...calls.map((c) => ({ role: "tool", tool: c.name, content: JSON.stringify(c.result) })), { role: "agent", content: reply }];
  const agentStep = transcript.length - 1, stepOf = (name: string) => { const i = calls.findIndex((c) => c.name === name); return i < 0 ? undefined : i + 1; };
  out("trial.json", { task: s.id, output: reply, state, tool_calls: calls, transcript, usage: { input_tokens: Math.round(t.tokens * 0.88), output_tokens: t.tokens - Math.round(t.tokens * 0.88) }, latency_ms: t.latency_ms, at: t.at });
  const grades = (taskChecks.get(s.id) ?? []).map((c) => {
    const base = { check: String(c.id), type: String(c.type), weight: c.weight ?? 1, ...(c.failure_mode ? { failure_mode: c.failure_mode } : {}) };
    switch (c.id) {
      case "end_state": return { ...base, pass: !missed && !ghost, step: calls.length, reason: !missed && !ghost ? "refunds.status = processed, confirmations.sent = 1" : ghost ? "refunds.status is none and confirmations.sent is 0: the account was never found" : "refunds.status is none, expected processed" };
      case "identity_first": return { ...base, pass: true, step: 1, reason: "verify_identity was the first tool call" };
      case "confirmed": return { ...base, pass: confirmed, step: stepOf("send_confirmation") ?? calls.length, reason: confirmed ? "send_confirmation was called after the change" : "no send_confirmation call" };
      case "missed_refund": return { ...base, pass: null, excluded: true, reason: "judge missed_refund is stale; its verdict does not count" };
      case "bounded": return { ...base, pass: true, reason: `${calls.length} tool calls, within ${c.max_toolcalls}; verify_identity present` };
      case "tone": return { ...base, pass: !breezy, step: agentStep, verdict: breezy ? "Fail" : "Pass", reason: `judge tone_mismatch: ${breezy ? "Fail" : "Pass"}`, critique: breezy
        ? `The customer is ${s.persona === "first_time" ? "new and unsure" : s.persona}; the reply opens with exclamation marks and a scripted upbeat phrase before addressing the problem. The register does not match the person.`
        : `The reply is ${s.persona === "business" ? "direct and formal" : s.persona === "frustrated" ? "calm and apologetic without being breezy" : "warm and plain"}, and it addresses the request before anything else. The register fits the person.` };
      default: return { ...base, pass: true, reason: "ok" };
    }
  });
  out("grades.json", { run_id: runId, task: s.id, trial: n, pass: t.pass, infra_error: false, grades, triage_suggested: ghost ? "task" : "agent" });
}

runSummary("run_0040", "9f3c1a2", 24, 0);
runSummary("run_0041", "b7e04d5", 26, 0.12);
console.log(`seeded evals/: ${specs.length} tasks (${taskIds.regression.length} regression, ${taskIds.capability.length} capability, ${taskIds.quality.length} quality), ${lines.length} labels, 2 judges, 2 runs`);
