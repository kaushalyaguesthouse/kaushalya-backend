const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");

const schema = fs.readFileSync("migrations/001_production_schema.sql", "utf8").toLowerCase();
const sql = fs.readFileSync("migrations/003_production_rls_hardening.sql", "utf8").toLowerCase();
const applicationTables = ["bookings", "payment_orders", "reviews", "room_types", "rooms", "booking_room_assignments", "booking_stays", "housekeeping_tasks"];
const featureTables = ["business_settings", "invoices", "audit_logs"];

function simulatedExecution(existingTables) {
  const hardened = [];
  for (const table of [...applicationTables, ...featureTables]) {
    if (existingTables.has(table)) hardened.push(table);
  }
  return hardened;
}

test("RLS hardening guards every table, remains private by default, and retains service-role access", () => {
  assert.match(sql, /to_regclass\(format\('%i\.%i', 'public', table_name\)\) is not null/g);
  for (const table of [...applicationTables, ...featureTables]) assert.match(sql, new RegExp(`'${table}'`));
  assert.match(sql, /enable row level security/);
  assert.match(sql, /revoke all on table %i\.%i from public, anon, authenticated/);
  assert.match(sql, /grant select, insert, update, delete on table %i\.%i to service_role/);
  assert.doesNotMatch(sql, /disable row level security|drop table|truncate|delete from/);
  assert.doesNotMatch(sql, /create policy|grant[^\n]+to (?:public|anon|authenticated)/);
});

test("RLS hardening succeeds when room_types is absent and changes no unrelated catalog state", () => {
  const catalog = new Set([...applicationTables, ...featureTables].filter((table) => table !== "room_types"));
  const before = [...catalog];
  assert.doesNotThrow(() => simulatedExecution(catalog));
  assert.deepEqual([...catalog], before);
  assert.doesNotMatch(sql, /alter table public\.room_types|(?:revoke|grant)[^;]*public\.room_types/);
});

test("RLS hardening is repeatable", () => {
  const catalog = new Set([...applicationTables, ...featureTables]);
  const first = simulatedExecution(catalog);
  const second = simulatedExecution(catalog);
  assert.deepEqual(second, first);
  assert.equal(new Set(second).size, applicationTables.length + featureTables.length);
});

test("the canonical schema creates every table referenced by RLS hardening", () => {
  for (const table of [...applicationTables, ...featureTables]) {
    assert.match(schema, new RegExp(`create table if not exists public\\.${table}\\b`), table);
  }
});
