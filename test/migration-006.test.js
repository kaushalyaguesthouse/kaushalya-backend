const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const sql = fs.readFileSync(path.join(__dirname, "../migrations/006_booking_creation_compatibility.sql"), "utf8").toLowerCase();

test("006 repairs the legacy refund_status default and replaces the booking RPC", () => {
  assert.match(sql, /column_name\s*=\s*'refund_status'/);
  assert.match(sql, /alter column refund_status set default 'n\/a'/);
  assert.match(sql, /create or replace function public\.create_booking_atomic\(booking_data jsonb, room_inventory integer\)/);
  assert.match(sql, /grant execute on function public\.create_booking_atomic\(jsonb, integer\) to service_role/);
});
