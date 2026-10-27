// The agent's database: accounts, invoices, refunds, tickets, audit. SQLite via node:sqlite.
// `seedDb(path)` writes the golden copy; `freshDb(trialDir)` copies it so every trial starts clean.
import { DatabaseSync } from "node:sqlite";
import { copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ACCOUNTS } from "./catalog.ts";

const here = dirname(fileURLToPath(import.meta.url));
export const SEED_DB = join(here, "..", "environments", "seed.sqlite");

export const SCHEMA = `
CREATE TABLE accounts (id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, plan TEXT NOT NULL, tier TEXT NOT NULL, last4 TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', renews_on TEXT);
CREATE TABLE invoices (id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id), amount_cents INTEGER NOT NULL, issued TEXT NOT NULL, status TEXT NOT NULL, note TEXT);
CREATE TABLE refunds (id INTEGER PRIMARY KEY AUTOINCREMENT, invoice_id TEXT NOT NULL REFERENCES invoices(id), amount_cents INTEGER NOT NULL, reason TEXT, status TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE tickets (id INTEGER PRIMARY KEY AUTOINCREMENT, account_id TEXT, subject TEXT, status TEXT NOT NULL DEFAULT 'open', created_at TEXT NOT NULL);
CREATE TABLE confirmations (id INTEGER PRIMARY KEY AUTOINCREMENT, account_id TEXT NOT NULL, subject TEXT NOT NULL, sent_at TEXT NOT NULL);
CREATE TABLE audit (id INTEGER PRIMARY KEY AUTOINCREMENT, tool TEXT NOT NULL, args TEXT NOT NULL, ok INTEGER NOT NULL, at TEXT NOT NULL);
`;

export function seedDb(path = SEED_DB): void {
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path)) rmSync(path);
  const db = new DatabaseSync(path);
  db.exec(SCHEMA);
  const acc = db.prepare("INSERT INTO accounts (id,name,email,plan,tier,last4,renews_on) VALUES (?,?,?,?,?,?,?)");
  const inv = db.prepare("INSERT INTO invoices (id,account_id,amount_cents,issued,status,note) VALUES (?,?,?,?,?,?)");
  for (const a of ACCOUNTS) {
    const last = a.invoices[a.invoices.length - 1]!.issued;
    const renews = new Date(last + "T00:00:00Z"); renews.setUTCMonth(renews.getUTCMonth() + 1);
    acc.run(a.id, a.name, a.email, a.plan, a.tier, a.last4, renews.toISOString().slice(0, 10));
    for (const i of a.invoices) inv.run(i.id, a.id, i.amount_cents, i.issued, i.status, i.note ?? null);
  }
  db.close();
}

/** Copy the seed into trialDir and open it. Each trial gets its own file; nothing is shared. */
export function freshDb(trialDir: string): { db: DatabaseSync; path: string } {
  if (!existsSync(SEED_DB)) seedDb();
  mkdirSync(trialDir, { recursive: true });
  const path = join(trialDir, "support.sqlite");
  copyFileSync(SEED_DB, path);
  return { db: new DatabaseSync(path), path };
}

/** The end-state snapshot an outcome check reads. Keys match the dotted paths in task `expect`. */
export function snapshot(db: DatabaseSync): Record<string, unknown> {
  const refunds = db.prepare("SELECT status, amount_cents FROM refunds ORDER BY id").all() as { status: string; amount_cents: number }[];
  const tickets = db.prepare("SELECT status FROM tickets ORDER BY id DESC LIMIT 1").get() as { status: string } | undefined;
  const confirmations = db.prepare("SELECT COUNT(*) AS n FROM confirmations").get() as { n: number };
  const audit = db.prepare("SELECT tool FROM audit ORDER BY id").all() as { tool: string }[];
  const last = refunds[refunds.length - 1];
  return {
    refunds: { count: refunds.length, status: last?.status ?? "none", amount_cents: last?.amount_cents ?? 0 },
    tickets: { status: tickets?.status ?? "none" },
    confirmations: { sent: confirmations.n },
    audit: { tool_calls: audit.map((a) => a.tool) },
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1] && process.argv[2] === "seed") {
  seedDb();
  console.log(`seeded ${SEED_DB}`);
}
