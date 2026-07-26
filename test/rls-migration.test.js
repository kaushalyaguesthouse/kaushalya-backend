const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");

const sql = fs.readFileSync("migrations/003_production_rls_hardening.sql", "utf8").toLowerCase();

test("RLS hardening is repeatable, private by default, and retains service-role access", () => {
  for (const table of ["bookings", "payment_orders", "reviews", "rooms", "booking_room_assignments", "booking_stays", "housekeeping_tasks", "invoices", "audit_logs"]) assert.match(sql, new RegExp(`alter table public\\.${table} enable row level security`));
  assert.match(sql, /revoke all[\s\S]+from public, anon, authenticated/);
  assert.match(sql, /grant select, insert, update, delete[\s\S]+to service_role/);
  assert.doesNotMatch(sql, /disable row level security|drop table|truncate|delete from/);
  assert.doesNotMatch(sql, /create policy/);
});
