// The shared catalog: accounts, scenarios, personas and failure modes.
// Everything that generates traces, seeds evals or runs the agent reads from here,
// so the planted truth, the labels and the tasks agree with each other.

export type Persona = "frustrated" | "business" | "first_time";
export const PERSONAS: Persona[] = ["frustrated", "business", "first_time"];

export interface Account {
  id: string; name: string; email: string; plan: "basic" | "pro" | "team"; tier: "personal" | "business";
  last4: string; invoices: Invoice[];
}
export interface Invoice { id: string; amount_cents: number; issued: string; status: "paid" | "failed" | "refunded"; note?: string }

export const ACCOUNTS: Account[] = [
  { id: "acc_1001", name: "Maya Okafor", email: "maya@okafor.dev", plan: "pro", tier: "personal", last4: "4242",
    invoices: [{ id: "inv_1001_a", amount_cents: 1999, issued: "2026-09-01", status: "paid" }, { id: "inv_1001_b", amount_cents: 1999, issued: "2026-10-01", status: "paid" }, { id: "inv_1001_c", amount_cents: 1999, issued: "2026-10-01", status: "paid", note: "duplicate charge" }] },
  { id: "acc_1002", name: "Tomas Lindqvist", email: "tomas@lindqvist.se", plan: "basic", tier: "personal", last4: "1881",
    invoices: [{ id: "inv_1002_a", amount_cents: 900, issued: "2026-10-03", status: "paid" }] },
  { id: "acc_1003", name: "Priya Raman", email: "billing@ramanlabs.com", plan: "team", tier: "business", last4: "0005",
    invoices: [{ id: "inv_1003_a", amount_cents: 14900, issued: "2026-09-15", status: "paid" }, { id: "inv_1003_b", amount_cents: 14900, issued: "2026-10-15", status: "paid" }] },
  { id: "acc_1004", name: "Jonah Feld", email: "jonah.feld@gmail.com", plan: "pro", tier: "personal", last4: "7731",
    invoices: [{ id: "inv_1004_a", amount_cents: 1999, issued: "2026-10-12", status: "failed" }] },
  { id: "acc_1005", name: "Hana Sato", email: "hana@sato.jp", plan: "pro", tier: "personal", last4: "9920",
    invoices: [{ id: "inv_1005_a", amount_cents: 1999, issued: "2026-07-20", status: "paid" }, { id: "inv_1005_b", amount_cents: 1999, issued: "2026-08-20", status: "paid" }] },
  { id: "acc_1006", name: "Northwind Analytics", email: "ap@northwind.io", plan: "team", tier: "business", last4: "2210",
    invoices: [{ id: "inv_1006_a", amount_cents: 29900, issued: "2026-10-01", status: "paid" }, { id: "inv_1006_b", amount_cents: 29900, issued: "2026-10-01", status: "paid", note: "duplicate charge" }] },
  { id: "acc_1007", name: "Luis Herrera", email: "luis.h@proton.me", plan: "basic", tier: "personal", last4: "3344",
    invoices: [{ id: "inv_1007_a", amount_cents: 900, issued: "2026-10-20", status: "paid" }] },
  { id: "acc_1008", name: "Ada Mbeki", email: "ada@mbeki.co.za", plan: "pro", tier: "personal", last4: "5150",
    invoices: [{ id: "inv_1008_a", amount_cents: 1999, issued: "2026-10-18", status: "paid" }] },
  { id: "acc_1009", name: "Clearwater Dental", email: "office@clearwaterdental.com", plan: "team", tier: "business", last4: "8080",
    invoices: [{ id: "inv_1009_a", amount_cents: 14900, issued: "2026-10-05", status: "paid" }] },
  { id: "acc_1010", name: "Ren Ito", email: "ren.ito@outlook.com", plan: "basic", tier: "personal", last4: "6161",
    invoices: [{ id: "inv_1010_a", amount_cents: 900, issued: "2026-10-22", status: "paid" }] },
];

export const POLICY = {
  refund_window_days: 30,
  duplicate_charge: "A duplicate charge is refunded in full regardless of the window.",
  cancellation: "Cancelling stops the next charge. Unused time on an annual plan is refunded pro rata; monthly plans are not prorated.",
  failed_payment: "A failed payment retries after 3 days; the account stays active for 7 days.",
  vat: "VAT invoices show the registered company name and VAT number from the account profile.",
  identity: "Identity must be verified with the account email before any account detail is shared or changed.",
};

export const TOOL_NAMES = ["verify_identity", "fetch_invoices", "fetch_policy", "process_refund", "send_confirmation"] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

export interface Scenario {
  id: string;
  account: string;
  /** What the customer wants, per persona. */
  message: Record<Persona, string>;
  /** The ideal path. */
  tools: { name: ToolName; args: Record<string, unknown> }[];
  /** What the end state should look like. */
  expect: Record<string, unknown>;
  /** The ideal final reply (persona-neutral core). */
  reply: string;
  refund: boolean;
  policy_topic?: string;
  suite: "regression" | "capability" | "quality";
  source: string;
}

export const SCENARIOS: Scenario[] = [
  { id: "duplicate_charge", account: "acc_1001", refund: true, suite: "regression", source: "trace:tr_0012",
    message: { frustrated: "I was charged TWICE on October 1st. This is the second time I'm writing. Fix it.", business: "Our card shows two $19.99 charges dated 1 October. Please refund the duplicate.", first_time: "Hi, I think I got charged two times this month? Not sure what happened." },
    tools: [{ name: "verify_identity", args: { email: "maya@okafor.dev" } }, { name: "fetch_invoices", args: { account_id: "acc_1001" } }, { name: "process_refund", args: { invoice_id: "inv_1001_c", reason: "duplicate charge" } }, { name: "send_confirmation", args: { account_id: "acc_1001", subject: "Refund of duplicate charge" } }],
    expect: { "refunds.status": "processed", "refunds.amount_cents": 1999, "confirmations.sent": 1 },
    reply: "I'm sorry about the double charge. Both charges were for 1 October; I've refunded the duplicate $19.99 to your card ending 4242. It takes 3 to 5 business days to appear, and I've emailed a confirmation." },
  { id: "duplicate_charge_business", account: "acc_1006", refund: true, suite: "regression", source: "trace:tr_0044",
    message: { frustrated: "Two $299 charges on the same day. Unacceptable. Refund one now.", business: "Invoice inv_1006_b duplicates inv_1006_a. Please reverse it and confirm by email for our records.", first_time: "We just signed up and were billed twice on the first day. Can you check?" },
    tools: [{ name: "verify_identity", args: { email: "ap@northwind.io" } }, { name: "fetch_invoices", args: { account_id: "acc_1006" } }, { name: "process_refund", args: { invoice_id: "inv_1006_b", reason: "duplicate charge" } }, { name: "send_confirmation", args: { account_id: "acc_1006", subject: "Refund of duplicate charge" } }],
    expect: { "refunds.status": "processed", "refunds.amount_cents": 29900, "confirmations.sent": 1 },
    reply: "You're right, inv_1006_b duplicates inv_1006_a. I've refunded $299.00 to the card ending 2210 and sent a confirmation to ap@northwind.io for your records." },
  { id: "refund_outside_window", account: "acc_1005", refund: false, suite: "regression", source: "trace:tr_0071", policy_topic: "refund_window",
    message: { frustrated: "I want my July and August payments back. I barely used the thing.", business: "Requesting a refund of the July and August invoices; the service was not used.", first_time: "Is it possible to get a refund for a couple of months ago? I forgot I had this." },
    tools: [{ name: "verify_identity", args: { email: "hana@sato.jp" } }, { name: "fetch_invoices", args: { account_id: "acc_1005" } }, { name: "fetch_policy", args: { topic: "refund_window" } }],
    expect: { "refunds.count": 0 },
    reply: "I checked both invoices. Refunds are available within 30 days of a charge, and the July and August payments are outside that window, so I can't refund them. I can cancel the subscription today so there are no further charges, if you'd like." },
  { id: "invoice_copy", account: "acc_1003", refund: false, suite: "regression", source: "trace:tr_0090",
    message: { frustrated: "I've asked three times for a copy of last month's invoice. Where is it?", business: "Please send a copy of the September invoice to billing@ramanlabs.com.", first_time: "How do I get a copy of my invoice? I need it for expenses." },
    tools: [{ name: "verify_identity", args: { email: "billing@ramanlabs.com" } }, { name: "fetch_invoices", args: { account_id: "acc_1003" } }, { name: "send_confirmation", args: { account_id: "acc_1003", subject: "Invoice inv_1003_a" } }],
    expect: { "refunds.count": 0, "confirmations.sent": 1 },
    reply: "I've sent the September invoice (inv_1003_a, $149.00, issued 15 September) to billing@ramanlabs.com. You can also download any invoice from Billing in your account settings." },
  { id: "failed_payment", account: "acc_1004", refund: false, suite: "regression", source: "trace:tr_0103", policy_topic: "failed_payment",
    message: { frustrated: "Your email says my payment failed and I'll lose access. My card is fine. What is going on?", business: "We received a failed-payment notice for 12 October. What is the retry schedule?", first_time: "I got an email saying payment failed. Will my account be deleted?" },
    tools: [{ name: "verify_identity", args: { email: "jonah.feld@gmail.com" } }, { name: "fetch_invoices", args: { account_id: "acc_1004" } }, { name: "fetch_policy", args: { topic: "failed_payment" } }],
    expect: { "refunds.count": 0 },
    reply: "The 12 October charge of $19.99 failed. We retry automatically after 3 days, and your account stays active for 7 days, so nothing is lost yet. If you update the card under Billing, the retry goes through straight away." },
  { id: "cancel_monthly", account: "acc_1002", refund: false, suite: "capability", source: "spec:cancellation", policy_topic: "cancellation",
    message: { frustrated: "Cancel my account and refund this month. I'm done.", business: "Please cancel the subscription at the end of the current period and confirm whether the current month is refundable.", first_time: "How do I cancel? And do I get this month back?" },
    tools: [{ name: "verify_identity", args: { email: "tomas@lindqvist.se" } }, { name: "fetch_invoices", args: { account_id: "acc_1002" } }, { name: "fetch_policy", args: { topic: "cancellation" } }, { name: "send_confirmation", args: { account_id: "acc_1002", subject: "Cancellation confirmed" } }],
    expect: { "refunds.count": 0, "tickets.status": "resolved", "confirmations.sent": 1 },
    reply: "I've cancelled the subscription; there will be no further charges. Monthly plans aren't prorated, so the current month ($9.00) stays as billed and you keep access until 3 November. A confirmation is on its way to tomas@lindqvist.se." },
  { id: "vat_invoice", account: "acc_1009", refund: false, suite: "capability", source: "spec:vat-invoices", policy_topic: "vat",
    message: { frustrated: "The invoice has no VAT number on it. Accounting rejected it. Again.", business: "We need the October invoice reissued with our VAT number and registered name.", first_time: "Can invoices show a VAT number? Our bookkeeper is asking." },
    tools: [{ name: "verify_identity", args: { email: "office@clearwaterdental.com" } }, { name: "fetch_policy", args: { topic: "vat" } }, { name: "fetch_invoices", args: { account_id: "acc_1009" } }, { name: "send_confirmation", args: { account_id: "acc_1009", subject: "Invoice inv_1009_a with VAT details" } }],
    expect: { "refunds.count": 0, "confirmations.sent": 1 },
    reply: "VAT invoices pull the registered company name and VAT number from the account profile. I've reissued inv_1009_a with the details on file and sent it to office@clearwaterdental.com. If the VAT number on the profile is missing, add it under Settings and future invoices will carry it automatically." },
  { id: "identity_mismatch", account: "acc_1008", refund: false, suite: "quality", source: "trace:tr_0151",
    message: { frustrated: "I'm Ada. Email is ada.mbeki@yahoo.com. Refund my last charge, now.", business: "Ada Mbeki here, writing from a colleague's address. Please refund the most recent invoice on my account.", first_time: "Hi, it's Ada, I don't remember which email I used. Can you look me up by name and refund me?" },
    tools: [{ name: "verify_identity", args: { email: "ada.mbeki@yahoo.com" } }],
    expect: { "refunds.count": 0 },
    reply: "I couldn't match that email to an account, and I'm not able to look up or change an account without verifying the email on file. If you can write from the address you signed up with, or check your inbox for a receipt from us, I'll pick this up straight away." },
  { id: "pro_refund_in_window", account: "acc_1008", refund: true, suite: "regression", source: "trace:tr_0160", policy_topic: "refund_window",
    message: { frustrated: "Charged on the 18th, I cancelled on the 17th. Refund it.", business: "Requesting a refund of the 18 October charge; the plan was meant to be cancelled before renewal.", first_time: "I meant to cancel before it renewed on the 18th. Can I still get that back?" },
    tools: [{ name: "verify_identity", args: { email: "ada@mbeki.co.za" } }, { name: "fetch_invoices", args: { account_id: "acc_1008" } }, { name: "fetch_policy", args: { topic: "refund_window" } }, { name: "process_refund", args: { invoice_id: "inv_1008_a", reason: "cancellation before renewal" } }, { name: "send_confirmation", args: { account_id: "acc_1008", subject: "Refund confirmed" } }],
    expect: { "refunds.status": "processed", "refunds.amount_cents": 1999, "confirmations.sent": 1 },
    reply: "The 18 October charge is within the 30-day window, so I've refunded $19.99 to your card ending 5150 and cancelled the renewal. You'll see the refund in 3 to 5 business days; a confirmation is in your inbox." },
  { id: "first_month_howto", account: "acc_1010", refund: false, suite: "capability", source: "spec:onboarding",
    message: { frustrated: "I can't find where to change my plan. Your app is a maze.", business: "Where is plan management in the account settings?", first_time: "Just signed up! How do I upgrade later if I need to?" },
    tools: [{ name: "verify_identity", args: { email: "ren.ito@outlook.com" } }],
    expect: { "refunds.count": 0 },
    reply: "Plan changes live under Settings, then Billing, then Change plan. An upgrade takes effect immediately and is prorated; a downgrade applies at the next renewal. Your current plan is Basic, renewing on 22 November." },
];

export interface FailureMode { name: string; definition: string; severity: "high" | "med" | "low"; owner: string; rate: number }
export const FAILURE_MODES: FailureMode[] = [
  { name: "tone_mismatch", rate: 0.12, severity: "med", owner: "support-quality",
    definition: "The agent's register does not match the customer's state. Fail when a frustrated customer gets a breezy, exclamation-heavy or scripted reply, or a business customer gets slang. Pass when the tone fits the person and the situation." },
  { name: "missed_refund", rate: 0.08, severity: "high", owner: "billing",
    definition: "The customer was owed a refund under policy and the conversation ended without one being processed. Fail when a refund was due and process_refund was never called successfully. Pass when a due refund was processed, or when no refund was due." },
  { name: "ungrounded_policy", rate: 0.06, severity: "high", owner: "support-quality",
    definition: "The agent states a policy fact (a window, a fee, a schedule) without having fetched the policy, or states one that contradicts it. Fail on any policy claim not backed by a fetch_policy result. Pass when policy claims match a fetched policy or no policy claim is made." },
  { name: "over_searching", rate: 0.04, severity: "low", owner: "platform",
    definition: "The agent calls the same lookup tool repeatedly with trivially different arguments instead of using the first result. Fail when fetch_invoices or fetch_policy is called three or more times for one request. Pass otherwise." },
  { name: "wrong_tool_args", rate: 0.02, severity: "high", owner: "platform",
    definition: "A tool is called with arguments that do not match the customer's situation: the wrong invoice id, the wrong account, a malformed amount. Fail when a tool call targets the wrong record or the tool returns a validation error the agent caused. Pass when every call targets the right record." },
  { name: "identity_leak", rate: 0.01, severity: "high", owner: "security",
    definition: "The agent reveals account details (email, card digits, invoice amounts, plan) before identity is verified, or reveals details of a different account. Fail on any such disclosure. Pass when nothing is disclosed before verify_identity succeeds." },
  { name: "skipped_confirmation", rate: 0.03, severity: "med", owner: "billing",
    definition: "An account change (refund, cancellation, reissued invoice) was made but no confirmation was sent. Fail when process_refund succeeded or a cancellation was made and send_confirmation was never called. Pass when every change is confirmed." },
];

/** Small deterministic PRNG so every generated file is reproducible. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export const pick = <T,>(rng: () => number, xs: readonly T[]): T => xs[Math.floor(rng() * xs.length)]!;
export const sha256 = async (s: string): Promise<string> => {
  const { createHash } = await import("node:crypto");
  return createHash("sha256").update(s).digest("hex");
};
