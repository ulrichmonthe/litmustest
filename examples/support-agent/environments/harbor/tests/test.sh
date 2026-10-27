#!/usr/bin/env bash
# Reads the trial's end state and checks the task's outcome: one processed refund of 1999 cents and one confirmation.
set -euo pipefail
trial=$(ls -d /output/duplicate_charge_frustrated_* | tail -1)
node -e '
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.argv[1]);
const r = db.prepare("SELECT status, amount_cents FROM refunds").all();
const c = db.prepare("SELECT COUNT(*) AS n FROM confirmations").get();
const ok = r.length === 1 && r[0].status === "processed" && r[0].amount_cents === 1999 && c.n === 1;
console.log(JSON.stringify({ refunds: r, confirmations: c.n, pass: ok }));
process.exit(ok ? 0 : 1);
' "$trial/support.sqlite"
