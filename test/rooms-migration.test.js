const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");

const migration = readFileSync(join(__dirname, "../migrations/001_production_schema.sql"), "utf8");

test("physical room migration creates constrained, indexed room tables with updated_at triggers", () => {
  assert.match(migration, /create table if not exists public\.room_types/);
  assert.match(migration, /create table if not exists public\.rooms/);
  assert.match(migration, /references public\.room_types\(id\).*delete restrict/);
  assert.match(migration, /check \(operational_status in \('operational','maintenance','out_of_service'\)\)/);
  assert.match(migration, /check \(housekeeping_status in \('clean','dirty','cleaning'\)\)/);
  assert.match(migration, /create index if not exists rooms_status_idx/);
  assert.match(migration, /create trigger rooms_set_updated_at/);
  assert.doesNotMatch(migration, /housekeeping_task|maintenance_history|check_in_at|check_out_at/);
});

test("room assignment migration enforces finite half-open ranges and active-only uniqueness", () => {
  assert.match(migration, /create extension if not exists btree_gist/);
  assert.match(migration, /allocation_range daterange/);
  for (const assertion of [/not isempty\(allocation_range\)/, /not lower_inf\(allocation_range\)/, /not upper_inf\(allocation_range\)/, /lower_inc\(allocation_range\)/, /not upper_inc\(allocation_range\)/, /lower\(allocation_range\) < upper\(allocation_range\)/]) assert.match(migration, assertion);
  assert.match(migration, /exclude using gist \(room_id with =, allocation_range with &&\)[\s\S]*where \(assignment_status = 'active'\)/);
  assert.match(migration, /create unique index if not exists booking_room_assignments_one_active_booking_uidx[\s\S]*where assignment_status = 'active'/);
});

test("assignment RPC locks authoritative booking dates and maps concurrent constraint failures", () => {
  assert.match(migration, /from public\.bookings where id = target_booking_id for update/);
  assert.match(migration, /check_in is null or locked_booking\.check_out is null or locked_booking\.check_in >= locked_booking\.check_out/);
  assert.match(migration, /booking_status not in \('Pending','Confirmed'\)/);
  assert.match(migration, /daterange\(locked_booking\.check_in, locked_booking\.check_out, '\[\)'\)/);
  assert.match(migration, /when exclusion_violation then raise exception 'ROOM_ASSIGNMENT_CONFLICT'/);
  assert.match(migration, /when unique_violation then raise exception 'BOOKING_ALREADY_ASSIGNED'/);
  assert.match(migration, /set assignment_status = 'released', released_at = now\(\)/);
});

test("physical room migration seeds the legacy room types and four requested rooms idempotently", () => {
  assert.match(migration, /values \('Standard'\), \('Deluxe'\) on conflict \(name\) do nothing/);
  for (const seed of ["('101', 'Standard', 1)", "('102', 'Standard', 1)", "('201', 'Deluxe', 2)", "('202', 'Deluxe', 2)"]) assert.ok(migration.includes(seed), seed);
  assert.match(migration, /on conflict \(room_number\) do nothing/);
});
