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

test("room foundation and assignment phases retain their constraints, indexes, and RPC privacy", () => {
  for (const constraint of [
    /room_type_id uuid not null references public\.room_types\(id\).*delete restrict/,
    /room_number text not null unique/,
    /check \(char_length\(trim\(room_number\)\) between 1 and 20\)/,
    /check \(assignment_status in \('active','released'\)\)/,
    /check \(\(assignment_status = 'active'.*assignment_status = 'released'/
  ]) assert.match(migration, constraint);

  for (const index of [
    /create index if not exists rooms_room_type_idx/,
    /create index if not exists rooms_status_idx/,
    /create unique index if not exists booking_room_assignments_one_active_idx/,
    /create index if not exists booking_room_assignments_booking_history_idx/,
    /create index if not exists booking_room_assignments_room_idx/
  ]) assert.match(migration, index);

  assert.match(migration, /revoke all on function public\.assign_booking_room\(uuid,uuid,text\), public\.release_booking_room\(uuid,text,text\) from public, anon, authenticated/);
  assert.match(migration, /grant execute on function public\.assign_booking_room\(uuid,uuid,text\), public\.release_booking_room\(uuid,text,text\) to service_role/);
});

test("room assignments use immutable booking-derived ranges and reject active overlaps", () => {
  assert.match(migration, /create extension if not exists btree_gist/);
  assert.match(migration, /allocation_range daterange not null/);
  assert.match(migration, /new\.allocation_range = daterange\(arrival, departure, '\[\)'\)/);
  assert.match(migration, /create trigger booking_room_assignments_set_allocation_range before insert/);
  assert.doesNotMatch(migration, /before (?:insert or update|update or insert)[\s\S]*set_booking_room_allocation_range/);
  assert.match(migration, /not isempty\(allocation_range\).*not lower_inf\(allocation_range\).*not upper_inf\(allocation_range\)[\s\S]*lower_inc\(allocation_range\) and not upper_inc\(allocation_range\)/);
  assert.match(migration, /exclude using gist \(room_id with =, allocation_range with &&\) where \(assignment_status = 'active'\)/);
  assert.match(migration, /exception when exclusion_violation[\s\S]*'reason','room_assignment_conflict'/);
  assert.match(migration, /update booking_room_assignments set assignment_status='released',released_at=now\(\),released_by=actor,release_reason=reason/);
  assert.doesNotMatch(migration, /update booking_room_assignments set[^;]*allocation_range/);
});

test("guest stay migration creates one constrained stay per booking and an atomic privacy-safe check-in RPC", () => {
  assert.match(migration, /create table if not exists public\.booking_stays/);
  assert.match(migration, /booking_id uuid primary key references public\.bookings\(id\)/);
  assert.match(migration, /default 'not_checked_in' check \(stay_status in \('not_checked_in','checked_in','checked_out','no_show'\)\)/);
  assert.match(migration, /insert into public\.booking_stays\(booking_id\) select id from public\.bookings on conflict \(booking_id\) do nothing/);
  assert.match(migration, /create trigger bookings_create_stay after insert on public\.bookings/);
  assert.match(migration, /create or replace function public\.check_in_booking/);
  assert.match(migration, /b\.booking_status <> 'Confirmed'/);
  assert.match(migration, /active_count <> 1/);
  assert.match(migration, /r\.housekeeping_status not in \('clean','inspected'\)/);
  assert.match(migration, /update booking_stays set stay_status='checked_in',checked_in_at=checked_in/);
  assert.doesNotMatch(migration.split("-- Phase 4.4:")[1].split("-- Phase 4.5:")[0], /update booking_room_assignments/);
  assert.match(migration, /revoke all on function public\.check_in_booking\(uuid\) from public, anon, authenticated/);
});

test("guest checkout atomically completes the stay, preserves assignment history, dirties the room, and creates turnover work", () => {
  const phase45 = migration.split("-- Phase 4.5:")[1].split("-- Phase 4.6:")[0];
  assert.match(phase45, /create table if not exists public\.housekeeping_tasks/);
  assert.match(phase45, /task_type in \('turnover','stayover','inspection','deep_clean'\)/);
  assert.match(phase45, /status in \('pending','cleaning','completed','inspected','cancelled'\)/);
  assert.match(phase45, /create or replace function public\.check_out_booking/);
  assert.match(phase45, /s\.stay_status is distinct from 'checked_in'/);
  assert.match(phase45, /b\.booking_status <> 'Confirmed'/);
  assert.match(phase45, /active_count <> 1/);
  assert.match(phase45, /update booking_stays set stay_status='checked_out',checked_out_at=checkout_time/);
  assert.match(phase45, /update bookings set booking_status='Completed'/);
  assert.match(phase45, /update booking_room_assignments set assignment_status='released',released_at=checkout_time/);
  assert.match(phase45, /update rooms set housekeeping_status='dirty'/);
  assert.match(phase45, /insert into housekeeping_tasks\(booking_id,room_id,task_type,status\) values\(target_booking_id,r\.id,'turnover','pending'\)/);
  assert.doesNotMatch(phase45, /update booking_room_assignments set[^;]*(?:allocation_range|assigned_at)/);
  assert.doesNotMatch(phase45, /operational_status\s*=/);
  assert.match(phase45, /revoke all on function public\.check_out_booking\(uuid\) from public, anon, authenticated/);
});

test("Phase 4.6 enforces atomic housekeeping transitions and availability conditions", () => {
  const phase46 = migration.split("-- Phase 4.6:")[1];
  assert.match(phase46, /create or replace function public\.transition_housekeeping_task/);
  assert.match(phase46, /when 'start' then 'pending'[\s\S]*when 'complete' then 'cleaning'[\s\S]*when 'inspect' then 'completed'/);
  assert.match(phase46, /completed_at=case when target_action='complete' then transition_time/);
  assert.match(phase46, /update rooms set housekeeping_status=next_status/);
  assert.match(phase46, /assignment_status='active'/);
  assert.match(phase46, /s\.stay_status='checked_in'/);
  assert.match(phase46, /when active_assignment then 'reserved' else 'available'/);
  assert.doesNotMatch(phase46, /delete from housekeeping_tasks/);
});
