const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { canonicalRoomType } = require("../src/room-types");
const { createSupabaseDb } = require("../src/supabase-db");

test("customer-facing room types map to production canonical names", () => {
  assert.equal(canonicalRoomType("AC Room"), "Deluxe");
  assert.equal(canonicalRoomType("Non AC Room"), "Standard");
  assert.equal(canonicalRoomType("Deluxe"), "Deluxe");
});

test("database boundary canonicalizes availability and atomic booking RPC calls", async () => {
  const calls = [];
  const supabase = { rpc: async (name, args) => { calls.push({ name, args }); return { data: name === "room_availability" ? [{ remaining: 3 }] : [{ room_type: args.booking_data.room_type }], error: null }; } };
  const db = createSupabaseDb(supabase);
  assert.equal(await db.availability("AC Room", "2026-08-01", "2026-08-02"), 3);
  await db.createBookingAtomic({ room_type: "Non AC Room" });
  assert.equal(calls[0].args.requested_room_type, "Deluxe");
  assert.equal(calls[1].args.booking_data.room_type, "Standard");
});

test("migration canonicalizes inventory lookup and historical occupancy without rewriting bookings", () => {
  const sql = fs.readFileSync(path.join(__dirname, "../migrations/009_canonical_room_type_compatibility.sql"), "utf8");
  assert.match(sql, /when 'AC Room' then 'Deluxe'/);
  assert.match(sql, /when 'Non AC Room' then 'Standard'/);
  assert.match(sql, /canonical_room_type\(bookings\.room_type\)/);
  assert.doesNotMatch(sql, /update\s+public\.bookings/i);
});
