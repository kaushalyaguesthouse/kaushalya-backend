const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const sql = fs.readFileSync(path.join(__dirname, "../migrations/006_booking_creation_compatibility.sql"), "utf8").toLowerCase();
const availabilitySql = fs.readFileSync(path.join(__dirname, "../migrations/007_authoritative_room_availability.sql"), "utf8").toLowerCase();

test("006 repairs the legacy refund_status default and replaces the booking RPC", () => {
  assert.match(sql, /column_name\s*=\s*'refund_status'/);
  assert.match(sql, /alter column refund_status set default 'n\/a'/);
  assert.match(sql, /create or replace function public\.create_booking_atomic\(booking_data jsonb, room_inventory integer\)/);
  assert.match(sql, /grant execute on function public\.create_booking_atomic\(jsonb, integer\) to service_role/);
});

test("007 uses active operational physical rooms and half-open booking overlap", () => {
  assert.match(availabilitySql, /join room_types on room_types\.id = rooms\.room_type_id/);
  assert.match(availabilitySql, /rooms\.is_active/);
  assert.match(availabilitySql, /rooms\.operational_status = 'operational'/);
  assert.match(availabilitySql, /check_in < requested_check_out/);
  assert.match(availabilitySql, /check_out > requested_check_in/);
  assert.match(availabilitySql, /from room_availability\(/);
});
