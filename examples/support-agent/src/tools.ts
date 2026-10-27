// The five tools, as Claude tool definitions plus executors against the trial's database.
import type { DatabaseSync } from "node:sqlite";
import { POLICY, type ToolName } from "./catalog.ts";

export interface ToolDef { name: ToolName; description: string; input_schema: Record<string, unknown> }

export const TOOL_DEFS: ToolDef[] = [
  { name: "verify_identity", description: "Verify the customer by the email on the account. Must succeed before any account detail is shared or changed. Returns the account id and plan, or not_found.",
    input_schema: { type: "object", properties: { email: { type: "string" } }, required: ["email"], additionalProperties: false } },
  { name: "fetch_invoices", description: "List invoices for a verified account: id, amount in cents, issue date, status, and any note such as 'duplicate charge'.",
    input_schema: { type: "object", properties: { account_id: { type: "string" } }, required: ["account_id"], additionalProperties: false } },
  { name: "fetch_policy", description: "Fetch the billing policy for a topic. Always fetch before stating a policy fact. Topics: refund_window, duplicate_charge, cancellation, failed_payment, vat, identity.",
    input_schema: { type: "object", properties: { topic: { type: "string", enum: ["refund_window", "duplicate_charge", "cancellation", "failed_payment", "vat", "identity"] } }, required: ["topic"], additionalProperties: false } },
  { name: "process_refund", description: "Refund a paid invoice in full. Only for a verified account, and only when policy allows it. Returns the refund record.",
    input_schema: { type: "object", properties: { invoice_id: { type: "string" }, reason: { type: "string" } }, required: ["invoice_id", "reason"], additionalProperties: false } },
  { name: "send_confirmation", description: "Email a confirmation of what was done to the account's address. Call after any refund, cancellation or reissued invoice.",
    input_schema: { type: "object", properties: { account_id: { type: "string" }, subject: { type: "string" } }, required: ["account_id", "subject"], additionalProperties: false } },
];

export interface ToolCallRecord { name: string; args: Record<string, unknown>; result: unknown; ok: boolean }

export function runTool(db: DatabaseSync, name: string, args: Record<string, unknown>, verified: Set<string>): ToolCallRecord {
  const now = new Date().toISOString();
  let result: unknown; let ok = true;
  try {
    switch (name) {
      case "verify_identity": {
        const row = db.prepare("SELECT id, name, plan, tier, status, renews_on FROM accounts WHERE lower(email)=lower(?)").get(String(args.email)) as Record<string, unknown> | undefined;
        if (!row) { result = { verified: false, error: "not_found" }; ok = false; }
        else { verified.add(String(row.id)); result = { verified: true, account_id: row.id, name: row.name, plan: row.plan, tier: row.tier, status: row.status, renews_on: row.renews_on }; }
        break;
      }
      case "fetch_invoices": {
        const id = String(args.account_id);
        if (!verified.has(id)) { result = { error: "identity_not_verified" }; ok = false; break; }
        result = db.prepare("SELECT id, amount_cents, issued, status, note FROM invoices WHERE account_id=? ORDER BY issued, id").all(id);
        break;
      }
      case "fetch_policy": {
        const topic = String(args.topic) as keyof typeof POLICY | "refund_window";
        if (topic === "refund_window") result = { topic, policy: `Refunds are available within ${POLICY.refund_window_days} days of a charge.` };
        else if (topic in POLICY) result = { topic, policy: POLICY[topic as keyof typeof POLICY] };
        else { result = { error: "unknown_topic" }; ok = false; }
        break;
      }
      case "process_refund": {
        const inv = db.prepare("SELECT id, account_id, amount_cents, status FROM invoices WHERE id=?").get(String(args.invoice_id)) as Record<string, unknown> | undefined;
        if (!inv) { result = { error: "invoice_not_found" }; ok = false; break; }
        if (!verified.has(String(inv.account_id))) { result = { error: "identity_not_verified" }; ok = false; break; }
        if (inv.status !== "paid") { result = { error: `invoice_status_${inv.status}` }; ok = false; break; }
        db.prepare("INSERT INTO refunds (invoice_id, amount_cents, reason, status, created_at) VALUES (?,?,?,?,?)").run(String(inv.id), Number(inv.amount_cents), String(args.reason ?? ""), "processed", now);
        db.prepare("UPDATE invoices SET status='refunded' WHERE id=?").run(String(inv.id));
        result = { refund: { invoice_id: inv.id, amount_cents: inv.amount_cents, status: "processed" } };
        break;
      }
      case "send_confirmation": {
        const id = String(args.account_id);
        if (!verified.has(id)) { result = { error: "identity_not_verified" }; ok = false; break; }
        db.prepare("INSERT INTO confirmations (account_id, subject, sent_at) VALUES (?,?,?)").run(id, String(args.subject ?? "Confirmation"), now);
        db.prepare("INSERT INTO tickets (account_id, subject, status, created_at) VALUES (?,?,?,?)").run(id, String(args.subject ?? ""), "resolved", now);
        result = { sent: true };
        break;
      }
      default: result = { error: "unknown_tool" }; ok = false;
    }
  } catch (e) { result = { error: (e as Error).message }; ok = false; }
  db.prepare("INSERT INTO audit (tool, args, ok, at) VALUES (?,?,?,?)").run(name, JSON.stringify(args), ok ? 1 : 0, now);
  return { name, args, result, ok };
}
