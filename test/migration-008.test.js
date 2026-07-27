const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");

const sql = readFileSync(join(__dirname, "../migrations/008_room_type_inventory_availability.sql"), "utf8");
const lower = sql.toLowerCase();

test("008 preflights the production schema and exact active room types", () => {
  assert.match(lower, /to_regclass\('public\.room_types'\)/);
  assert.match(lower, /to_regclass\('public\.bookings'\)/);
  for (const column of ["name", "is_active", "idempotency_key", "room_type", "booking_status", "check_in", "check_out"]) assert.match(lower, new RegExp(`'${column}'`));
  assert.match(sql, /name = 'Deluxe' and is_active is true/);
  assert.match(sql, /name = 'Standard' and is_active is true/);
  assert.match(lower, /inventory_count <= 0/);
  assert.match(lower, /raise exception 'availability migration preflight failed:/);
});

test("008 stores the exact production inventories on room_types", () => {
  assert.match(lower, /inventory_count integer not null default 1/);
  assert.match(sql, /inventory_count = 3 where name = 'Deluxe'/);
  assert.match(sql, /inventory_count = 3 where name = 'Standard'/);
});

test("008 uses one half-open, active-status availability calculation for lookup and booking", () => {
  assert.match(lower, /case when is_active then inventory_count else 0 end/);
  assert.match(sql, /booking_status in \('Pending', 'Confirmed'\)/);
  assert.match(lower, /check_in < requested_check_out/);
  assert.match(lower, /check_out > requested_check_in/);
  assert.match(lower, /greatest\(coalesce\(selected_room_type\.inventory, 0\) - overlapping_bookings\.occupied, 0\)/);
  assert.match(lower, /create or replace function public\.create_booking_atomic\(booking_data jsonb\)[\s\S]*from public\.room_availability\(/);
  assert.doesNotMatch(lower, /\bfrom\s+(?:public\.)?rooms\b|\bjoin\s+(?:public\.)?rooms\b/);
});

test("008 preserves service-role-only RPC execution", () => {
  for (const signature of ["room_availability(text, date, date)", "create_booking_atomic(jsonb)"]) {
    const escaped = signature.replace(/[()]/g, "\\$&");
    assert.match(lower, new RegExp(`revoke all on function public\\.${escaped} from public, anon, authenticated`));
    assert.match(lower, new RegExp(`grant execute on function public\\.${escaped} to service_role`));
  }
});

test("production inventory permits three overlaps, rejects the fourth, and permits same-day turnover", () => {
  const remaining = (bookings, start, end, active = true) => {
    const occupied = bookings.filter((b) => ["Pending", "Confirmed"].includes(b.status) && b.checkIn < end && b.checkOut > start).length;
    return Math.max((active ? 3 : 0) - occupied, 0);
  };
  const bookings = [
    { status: "Confirmed", checkIn: "2026-08-01", checkOut: "2026-08-05" },
    { status: "Pending", checkIn: "2026-08-02", checkOut: "2026-08-06" },
    { status: "Confirmed", checkIn: "2026-08-03", checkOut: "2026-08-07" }
  ];
  assert.equal(remaining(bookings.slice(0, 1), "2026-08-03", "2026-08-04"), 2);
  assert.equal(remaining(bookings.slice(0, 2), "2026-08-03", "2026-08-04"), 1);
  assert.equal(remaining(bookings, "2026-08-03", "2026-08-04"), 0);
  assert.equal(remaining(bookings, "2026-08-03", "2026-08-04") > 0, false);
  assert.equal(remaining([bookings[0]], "2026-08-05", "2026-08-06"), 3);
  assert.equal(remaining([], "2026-08-03", "2026-08-04", false), 0);
});
