const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");

const migration = readFileSync(join(__dirname, "../migrations/001_production_schema.sql"), "utf8");

test("physical room migration creates constrained, indexed room tables with updated_at triggers", () => {
  const phase41 = migration.split("-- Phase 4.2:")[0];
  assert.match(phase41, /create table if not exists public\.room_types/);
  assert.match(migration, /create table if not exists public\.rooms/);
  assert.match(migration, /references public\.room_types\(id\).*delete restrict/);
  assert.match(migration, /check \(operational_status in \('operational','maintenance','out_of_service'\)\)/);
  assert.match(migration, /check \(housekeeping_status in \('clean','dirty','cleaning'\)\)/);
  assert.match(migration, /create index if not exists rooms_status_idx/);
  assert.match(migration, /create trigger rooms_set_updated_at/);
  assert.doesNotMatch(phase41, /room_assignment|housekeeping_task|maintenance_history|check_in_at|check_out_at/);
});

test("physical room migration seeds the legacy room types and four requested rooms idempotently", () => {
  assert.match(migration, /values \('Standard'\), \('Deluxe'\) on conflict \(name\) do nothing/);
  for (const seed of ["('101', 'Standard', 1)", "('102', 'Standard', 1)", "('201', 'Deluxe', 2)", "('202', 'Deluxe', 2)"]) assert.ok(migration.includes(seed), seed);
  assert.match(migration, /on conflict \(room_number\) do nothing/);
});

test("room assignment migration preserves history and enforces one active assignment", () => {
  assert.match(migration, /create table if not exists public\.booking_room_assignments/);
  assert.match(migration, /booking_id uuid not null references public\.bookings\(id\)/);
  assert.match(migration, /room_id uuid not null references public\.rooms\(id\)/);
  assert.match(migration, /unique index if not exists booking_room_assignments_one_active_idx[\s\S]*where assignment_status = 'active'/);
  assert.match(migration, /create or replace function public\.assign_booking_room/);
  assert.match(migration, /create or replace function public\.release_booking_room/);
  assert.doesNotMatch(migration, /alter table public\.bookings add column if not exists room_id/);
});
