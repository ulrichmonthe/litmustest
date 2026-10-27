#!/usr/bin/env bash
# Reference solution: apply the ideal path directly to the database, without the model.
set -euo pipefail
mkdir -p /output/duplicate_charge_frustrated_reference
cp /app/environments/seed.sqlite /output/duplicate_charge_frustrated_reference/support.sqlite
node -e '
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.argv[1]); const now = new Date().toISOString();
db.prepare("INSERT INTO refunds (invoice_id, amount_cents, reason, status, created_at) VALUES (?,?,?,?,?)").run("inv_1001_c", 1999, "duplicate charge", "processed", now);
db.prepare("UPDATE invoices SET status=\"refunded\" WHERE id=\"inv_1001_c\"").run();
db.prepare("INSERT INTO confirmations (account_id, subject, sent_at) VALUES (?,?,?)").run("acc_1001", "Refund of duplicate charge", now);
' /output/duplicate_charge_frustrated_reference/support.sqlite
