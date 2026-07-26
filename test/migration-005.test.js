const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");

const sql = fs.readFileSync("migrations/005_complete_schema_reconciliation.sql", "utf8").toLowerCase();
const healthTables = ["bookings", "payment_orders", "reviews", "room_types", "rooms", "booking_room_assignments", "booking_stays", "housekeeping_tasks", "invoices", "business_settings", "audit_logs"];

test("005 reconciles every health-check table without destructive table operations", () => {
  for (const table of healthTables) assert.match(sql, new RegExp(`create table if not exists public\\.${table}\\b`), table);
  assert.doesNotMatch(sql, /drop\s+(?:table|column|constraint)|truncate\s|delete\s+from/);
});

test("005 reconciles all booking columns queried or written by the backend", () => {
  const columns = ["booking_id", "idempotency_key", "customer_name", "phone", "email", "room_type", "check_in", "check_out", "adults", "children", "payment_type", "payment_status", "razorpay_order_id", "razorpay_payment_id", "amount", "advance_amount", "booking_status", "special_request", "nights", "paid_nights", "complimentary_nights", "email_sent_at", "created_at", "updated_at", "refund_amount"];
  for (const column of columns) assert.match(sql, new RegExp(`alter table public\\.bookings add column if not exists ${column}\\b`), column);
});

test("005 guards functions and triggers and restores database security", () => {
  for (const fn of ["set_updated_at", "set_booking_room_allocation_range", "create_booking_stay", "create_booking_atomic", "assign_booking_room", "release_booking_room", "check_in_booking", "check_out_booking", "transition_housekeeping_task", "generate_booking_invoice"]) {
    assert.match(sql, new RegExp(`to_regprocedure\\('public\\.${fn}\\(`), fn);
  }
  assert.match(sql, /not exists\(select 1 from pg_trigger/);
  assert.match(sql, /enable row level security/);
  assert.match(sql, /revoke all on table/);
  assert.match(sql, /grant execute on function/);
});

test("005 restores canonical indexes, foreign keys, exclusion safety, and seeds", () => {
  assert.match(sql, /references public\.bookings\(id\)/);
  assert.match(sql, /references public\.rooms\(id\)/);
  assert.match(sql, /booking_room_assignments_no_active_room_overlap/);
  assert.match(sql, /exclude using gist/);
  assert.match(sql, /create unique index if not exists bookings_booking_id_uidx/);
  assert.match(sql, /values \('standard'\),\('deluxe'\) on conflict/);
  assert.match(sql, /insert into public\.business_settings\(id\) values\(true\) on conflict/);
});

test("005 preflights legacy definitions and duplicate values before unique indexes", () => {
  assert.match(sql, /schema_incompatible: %\.% expected %/);
  assert.match(sql, /format_type\(a\.atttypid,a\.atttypmod\)/);
  assert.match(sql, /duplicate_data: %\.% contains duplicate values/);
  assert.match(sql, /having count\(\*\) > 1/);
  assert.ok(sql.indexOf("duplicate_data:") < sql.indexOf("create unique index if not exists bookings_booking_id_uidx"));
  for (const value of ["booking_id", "idempotency_key", "razorpay_payment_id", "razorpay_order_id", "invoice_number"]) assert.match(sql, new RegExp(`'${value}'`), value);
});

test("005 neither fabricates rooms nor historical stay state and preserves seed rows", () => {
  assert.doesNotMatch(sql, /insert into public\.rooms/);
  assert.doesNotMatch(sql, /select id from public\.bookings on conflict \(booking_id\)/);
  assert.doesNotMatch(sql, /do update/);
  assert.match(sql, /physical inventory is intentionally not seeded/);
  assert.match(sql, /legacy stays are intentionally not fabricated/);
});

test("005 verifies RPC contracts and never replaces functions or triggers", () => {
  assert.doesNotMatch(sql, /create\s+or\s+replace\s+(?:function|trigger)/);
  assert.doesNotMatch(sql, /drop\s+trigger/);
  assert.match(sql, /pg_get_function_result/);
  assert.match(sql, /prosecdef/);
  assert.match(sql, /search_path=public/);
  for (const signature of ["create_booking_atomic(jsonb,integer)", "assign_booking_room(uuid,uuid,text)", "release_booking_room(uuid,text,text)", "check_in_booking(uuid)", "check_out_booking(uuid)", "transition_housekeeping_task(uuid,text)", "generate_booking_invoice(uuid,text)"]) assert.match(sql, new RegExp(signature.replace(/[()]/g, "\\$&")), signature);
});

test("005 uses the service role architecture for all health resources", () => {
  assert.match(sql, /revoke all on table public\.%i from public,anon,authenticated/);
  assert.match(sql, /grant %s on table public\.%i to service_role/);
  assert.match(sql, /grant usage,select on sequence public\.invoice_number_seq to service_role/);
  for (const table of healthTables) assert.match(sql, new RegExp(`'${table}'`), table);
});
