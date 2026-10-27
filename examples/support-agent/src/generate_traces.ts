// Generate 300 synthetic traces with planted failures at known rates. No API calls; fully deterministic.
// Writes traces/support.jsonl (what a team has), traces/planted_truth.jsonl (what was planted),
// and evals/datasets/traces/<id>.json (the internal shape ingest would produce).
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ACCOUNTS, FAILURE_MODES, PERSONAS, SCENARIOS, mulberry32, pick, type Persona, type Scenario } from "./catalog.ts";
import { toJsonlLine, toTrace, type Recorded, type RecordedCall, type Turn } from "./otel.ts";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, "..");
export const N_TRACES = 300;
const MODEL = "claude-opus-5-5";

const OPENERS: Record<Persona, string[]> = {
  frustrated: ["I understand, and I'm sorry you've had to write again.", "I'm sorry. Let me deal with this now."],
  business: ["Thank you for the details.", "Understood."],
  first_time: ["Welcome, and thanks for checking.", "Good question."],
};
const BREEZY = ["No worries at all!! 😊 Let's get this sorted!", "Oops! Happens to the best of us! Let me take a peek!", "Hey there! Great question! Super easy fix!"];

export interface Planted { trace_id: string; scenario: string; persona: Persona; failures: string[] }

export function synthesize(i: number, rng: () => number): { rec: Recorded; planted: Planted } {
  const sc = pick(rng, SCENARIOS);
  const persona = pick(rng, PERSONAS);
  // A mode is drawn only where it can occur, at rate / P(applicable), so the rate over all traces matches the target.
  const applicable = new Set(FAILURE_MODES.filter((f) => applies(f.name, sc, persona) && rng() < f.rate / applicableFraction(f.name)).map((f) => f.name));
  const id = `tr_${String(i).padStart(4, "0")}`;
  const acc = ACCOUNTS.find((a) => a.id === sc.account)!;
  const turns: Turn[] = [{ role: "user", content: `From: ${sc.tools[0]!.args.email}\n\n${sc.message[persona]}` }];
  const calls: RecordedCall[] = [];
  const call = (name: string, args: Record<string, unknown>, result: unknown, ok = true) => {
    calls.push({ name, args, result, ok, turn: 0 });
    turns.push({ role: "tool", tool: name, content: JSON.stringify(result) });
  };
  let reply = `${pick(rng, OPENERS[persona])} ${sc.reply}`;

  if (applicable.has("identity_leak")) {
    const other = pick(rng, ACCOUNTS.filter((a) => a.id !== acc.id));
    reply = `I can see an account for ${other.name} at ${other.email} with a card ending ${other.last4}. ` + reply;
  }
  for (const t of sc.tools) {
    if (t.name === "fetch_policy" && applicable.has("ungrounded_policy")) continue; // skipped: the claim below is unbacked
    if (t.name === "process_refund" && applicable.has("missed_refund")) continue;
    if (t.name === "send_confirmation" && applicable.has("skipped_confirmation")) continue;
    if (t.name === "process_refund" && applicable.has("wrong_tool_args")) {
      const wrong = acc.invoices.find((x) => x.id !== t.args.invoice_id)?.id ?? "inv_0000";
      call("process_refund", { ...t.args, invoice_id: wrong }, wrong === "inv_0000" ? { error: "invoice_not_found" } : { refund: { invoice_id: wrong, amount_cents: acc.invoices.find((x) => x.id === wrong)!.amount_cents, status: "processed" } }, wrong !== "inv_0000");
      continue;
    }
    const n = t.name === "fetch_invoices" && applicable.has("over_searching") ? 3 + Math.floor(rng() * 2) : 1;
    for (let k = 0; k < n; k++) {
      const args = k === 0 ? t.args : { ...t.args, account_id: `${t.args.account_id}`, _attempt: k + 1 };
      call(t.name, args, toolResult(t.name, t.args, sc));
    }
  }
  if (applicable.has("ungrounded_policy")) reply = reply.replace("within 30 days", "within 60 days").replace("after 3 days", "after 24 hours").replace("aren't prorated", "are prorated");
  if (applicable.has("missed_refund")) reply = `${pick(rng, OPENERS[persona])} I've noted the issue on your account and flagged it for the billing team. You should hear back within a few days.`;
  if (applicable.has("tone_mismatch")) reply = `${pick(rng, BREEZY)} ${sc.reply}`;
  turns.push({ role: "agent", content: reply });
  const started = new Date(Date.UTC(2026, 9, 1 + Math.floor(i / 12), 8 + (i % 12), (i * 7) % 60));
  return { rec: { id, model: MODEL, persona, scenario: sc.id, turns, calls, started, input_tokens: 700 + Math.floor(rng() * 500), output_tokens: 80 + Math.floor(rng() * 100) },
    planted: { trace_id: id, scenario: sc.id, persona, failures: [...applicable].sort() } };
}

export function applies(mode: string, sc: Scenario, persona: Persona): boolean {
  if (mode === "missed_refund" || mode === "wrong_tool_args") return sc.refund;
  if (mode === "skipped_confirmation") return sc.tools.some((t) => t.name === "send_confirmation");
  if (mode === "ungrounded_policy") return Boolean(sc.policy_topic);
  if (mode === "tone_mismatch") return persona !== "first_time";
  return true;
}
const fractionCache = new Map<string, number>();
function applicableFraction(mode: string): number {
  let f = fractionCache.get(mode);
  if (f === undefined) {
    let n = 0, k = 0;
    for (const sc of SCENARIOS) for (const p of PERSONAS) { n++; if (applies(mode, sc, p)) k++; }
    f = k / n; fractionCache.set(mode, f);
  }
  return f;
}

function toolResult(name: string, args: Record<string, unknown>, sc: Scenario): unknown {
  const acc = ACCOUNTS.find((a) => a.id === sc.account)!;
  switch (name) {
    case "verify_identity": return String(args.email).toLowerCase() === acc.email.toLowerCase()
      ? { verified: true, account_id: acc.id, name: acc.name, plan: acc.plan, tier: acc.tier, status: "active" } : { verified: false, error: "not_found" };
    case "fetch_invoices": return acc.invoices.map((x) => ({ id: x.id, amount_cents: x.amount_cents, issued: x.issued, status: x.status, note: x.note ?? null }));
    case "fetch_policy": return { topic: args.topic, policy: args.topic === "refund_window" ? "Refunds are available within 30 days of a charge." : "(policy text)" };
    case "process_refund": { const inv = acc.invoices.find((x) => x.id === args.invoice_id)!; return { refund: { invoice_id: inv.id, amount_cents: inv.amount_cents, status: "processed" } }; }
    case "send_confirmation": return { sent: true };
  }
  return {};
}

export function generateAll(): { recs: Recorded[]; planted: Planted[] } {
  const rng = mulberry32(20261027);
  const recs: Recorded[] = []; const planted: Planted[] = [];
  for (let i = 1; i <= N_TRACES; i++) { const r = synthesize(i, rng); recs.push(r.rec); planted.push(r.planted); }
  return { recs, planted };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { recs, planted } = generateAll();
  const tracesDir = join(ROOT, "traces"); mkdirSync(tracesDir, { recursive: true });
  writeFileSync(join(tracesDir, "support.jsonl"), recs.map((r) => JSON.stringify(toJsonlLine(r))).join("\n") + "\n");
  writeFileSync(join(tracesDir, "planted_truth.jsonl"), planted.map((p) => JSON.stringify(p)).join("\n") + "\n");
  const internal = join(ROOT, "evals", "datasets", "traces"); rmSync(internal, { recursive: true, force: true }); mkdirSync(internal, { recursive: true });
  for (const r of recs) writeFileSync(join(internal, `${r.id}.json`), JSON.stringify(toTrace(r), null, 1));
  const counts: Record<string, number> = {};
  for (const p of planted) for (const f of p.failures) counts[f] = (counts[f] ?? 0) + 1;
  console.log(`wrote ${recs.length} traces; planted:`, Object.fromEntries(Object.entries(counts).map(([k, v]) => [k, `${v} (${(100 * v / recs.length).toFixed(1)}%)`])));
}
