-- Additive/idempotent production migration. Run in the Supabase SQL editor.
create extension if not exists pgcrypto;

-- Phase 4.1: physical-room inventory only. It is intentionally not connected to bookings.
create table if not exists public.room_types (
  id uuid primary key default gen_random_uuid(),
  name text not null unique check (char_length(trim(name)) between 1 and 100),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table if not exists public.rooms (
  id uuid primary key default gen_random_uuid(),
  room_number text not null unique check (char_length(trim(room_number)) between 1 and 20),
  room_type_id uuid not null references public.room_types(id) on update cascade on delete restrict,
  floor integer not null check (floor >= 0),
  operational_status text not null default 'operational' check (operational_status in ('operational','maintenance','out_of_service')),
  housekeeping_status text not null default 'clean' check (housekeeping_status in ('clean','dirty','cleaning')),
  notes text check (notes is null or char_length(notes) <= 2000),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists rooms_room_type_idx on public.rooms(room_type_id);
create index if not exists rooms_status_idx on public.rooms(operational_status, housekeeping_status, is_active);
create index if not exists rooms_floor_idx on public.rooms(floor, room_number);

create or replace function public.set_updated_at() returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;
drop trigger if exists room_types_set_updated_at on public.room_types;
create trigger room_types_set_updated_at before update on public.room_types for each row execute function public.set_updated_at();
drop trigger if exists rooms_set_updated_at on public.rooms;
create trigger rooms_set_updated_at before update on public.rooms for each row execute function public.set_updated_at();

insert into public.room_types(name) values ('Standard'), ('Deluxe') on conflict (name) do nothing;
insert into public.rooms(room_number, room_type_id, floor)
select seed.room_number, room_types.id, seed.floor
from (values ('101', 'Standard', 1), ('102', 'Standard', 1), ('201', 'Deluxe', 2), ('202', 'Deluxe', 2)) seed(room_number, type_name, floor)
join public.room_types on room_types.name = seed.type_name
on conflict (room_number) do nothing;

create table if not exists public.payment_orders (
  id uuid primary key default gen_random_uuid(), idempotency_key text not null unique,
  razorpay_order_id text not null unique, razorpay_payment_id text unique, razorpay_signature text,
  amount_paise integer not null check (amount_paise > 0), booking_payload jsonb not null,
  status text not null default 'created' check (status in ('created','verified','failed')),
  verified_at timestamptz, created_at timestamptz not null default now()
);
create table if not exists public.bookings (id uuid primary key default gen_random_uuid());
alter table public.bookings add column if not exists booking_id text;
alter table public.bookings add column if not exists idempotency_key text;
alter table public.bookings add column if not exists customer_name text;
alter table public.bookings add column if not exists phone text;
alter table public.bookings add column if not exists email text;
alter table public.bookings add column if not exists room_type text;
alter table public.bookings add column if not exists check_in date;
alter table public.bookings add column if not exists check_out date;
alter table public.bookings add column if not exists adults integer default 1;
alter table public.bookings add column if not exists children integer default 0;
alter table public.bookings add column if not exists payment_type text;
alter table public.bookings add column if not exists payment_status text default 'Pending';
alter table public.bookings add column if not exists razorpay_order_id text;
alter table public.bookings add column if not exists razorpay_payment_id text;
alter table public.bookings add column if not exists amount numeric(12,2);
alter table public.bookings add column if not exists advance_amount numeric(12,2) default 0;
alter table public.bookings add column if not exists booking_status text default 'Confirmed';
alter table public.bookings add column if not exists special_request text default '';
alter table public.bookings add column if not exists nights integer;
alter table public.bookings add column if not exists paid_nights integer;
alter table public.bookings add column if not exists complimentary_nights integer default 0;
alter table public.bookings add column if not exists email_sent_at timestamptz;
alter table public.bookings add column if not exists created_at timestamptz default now();
alter table public.bookings add column if not exists updated_at timestamptz default now();
create unique index if not exists bookings_booking_id_uidx on public.bookings(booking_id);
create unique index if not exists bookings_idempotency_uidx on public.bookings(idempotency_key);
create unique index if not exists bookings_payment_uidx on public.bookings(razorpay_payment_id) where razorpay_payment_id is not null;
create index if not exists bookings_availability_idx on public.bookings(room_type, check_in, check_out) where booking_status in ('Pending','Confirmed');

create table if not exists public.reviews (
  id uuid primary key default gen_random_uuid(), customer_name text not null, customer_email text not null,
  rating smallint not null check (rating between 1 and 5), review text not null check (char_length(review) between 10 and 2000),
  status text not null default 'pending' check (status in ('pending','approved','rejected')),
  created_at timestamptz not null default now(), moderated_at timestamptz
);
alter table public.reviews add column if not exists status text default 'pending';
alter table public.reviews add column if not exists id uuid default gen_random_uuid();
alter table public.reviews add column if not exists created_at timestamptz default now();
alter table public.reviews add column if not exists moderated_at timestamptz;
-- Preserve approval state from the legacy schema when that column exists.
do $$ begin
  if exists (select 1 from information_schema.columns where table_schema='public' and table_name='reviews' and column_name='approved') then
    execute 'update public.reviews set status = case when approved then ''approved'' else ''pending'' end where status is null or status = ''pending''';
  end if;
end $$;
create index if not exists reviews_public_idx on public.reviews(status, created_at desc);

create or replace function public.create_booking_atomic(booking_data jsonb, room_inventory integer)
returns setof public.bookings language plpgsql security definer set search_path = public as $$
declare occupied integer; existing public.bookings; created public.bookings;
begin
  perform pg_advisory_xact_lock(hashtext(booking_data->>'room_type'));
  select * into existing from bookings where idempotency_key = booking_data->>'idempotency_key';
  if found then return next existing; return; end if;
  select count(*) into occupied from bookings where room_type=booking_data->>'room_type' and booking_status in ('Pending','Confirmed') and check_in < (booking_data->>'check_out')::date and check_out > (booking_data->>'check_in')::date;
  if occupied >= room_inventory then return; end if;
  insert into bookings (booking_id,idempotency_key,customer_name,phone,email,room_type,check_in,check_out,adults,children,payment_type,payment_status,razorpay_order_id,razorpay_payment_id,amount,advance_amount,booking_status,special_request,nights,paid_nights,complimentary_nights)
  values (booking_data->>'booking_id',booking_data->>'idempotency_key',booking_data->>'customer_name',booking_data->>'phone',booking_data->>'email',booking_data->>'room_type',(booking_data->>'check_in')::date,(booking_data->>'check_out')::date,(booking_data->>'adults')::int,(booking_data->>'children')::int,booking_data->>'payment_type',booking_data->>'payment_status',booking_data->>'razorpay_order_id',booking_data->>'razorpay_payment_id',(booking_data->>'amount')::numeric,(booking_data->>'advance_amount')::numeric,'Confirmed',booking_data->>'special_request',(booking_data->>'nights')::int,(booking_data->>'paid_nights')::int,(booking_data->>'complimentary_nights')::int) returning * into created;
  return next created;
end $$;
revoke all on function public.create_booking_atomic(jsonb, integer) from public, anon, authenticated;
grant execute on function public.create_booking_atomic(jsonb, integer) to service_role;

-- Phase 4.2: manual physical-room allocation. Date ranges are authoritative
-- booking data and are protected against concurrent overlapping assignments.
create extension if not exists btree_gist;

create table if not exists public.booking_room_assignments (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null references public.bookings(id) on update cascade on delete restrict,
  room_id uuid not null references public.rooms(id) on update cascade on delete restrict,
  allocation_range daterange,
  assignment_status text not null default 'active' check (assignment_status in ('active','released')),
  assigned_at timestamptz not null default now(),
  released_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.booking_room_assignments add column if not exists allocation_range daterange;

-- Safely backfill an earlier Phase 4.2 deployment before making the range mandatory.
update public.booking_room_assignments assignment
set allocation_range = daterange(booking.check_in, booking.check_out, '[)')
from public.bookings booking
where assignment.booking_id = booking.id
  and assignment.allocation_range is null
  and booking.check_in is not null
  and booking.check_out is not null
  and booking.check_in < booking.check_out;

do $$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.booking_room_assignments'::regclass and conname = 'booking_room_assignments_allocation_range_check') then
    alter table public.booking_room_assignments add constraint booking_room_assignments_allocation_range_check check (
      allocation_range is not null
      and not isempty(allocation_range)
      and not lower_inf(allocation_range)
      and not upper_inf(allocation_range)
      and lower_inc(allocation_range)
      and not upper_inc(allocation_range)
      and lower(allocation_range) < upper(allocation_range)
    );
  end if;
end $$;

create unique index if not exists booking_room_assignments_one_active_booking_uidx
  on public.booking_room_assignments(booking_id) where assignment_status = 'active';

do $$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.booking_room_assignments'::regclass and conname = 'booking_room_assignments_no_active_room_overlap') then
    alter table public.booking_room_assignments add constraint booking_room_assignments_no_active_room_overlap
      exclude using gist (room_id with =, allocation_range with &&)
      where (assignment_status = 'active');
  end if;
end $$;

create or replace function public.protect_room_assignment_history() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then raise exception 'ROOM_ASSIGNMENT_HISTORY_IMMUTABLE'; end if;
  if (to_jsonb(new) - array['assignment_status','released_at','updated_at'])
      is distinct from (to_jsonb(old) - array['assignment_status','released_at','updated_at'])
     or old.assignment_status <> 'active'
     or new.assignment_status <> 'released'
     or new.released_at is null then
    raise exception 'ROOM_ASSIGNMENT_HISTORY_IMMUTABLE';
  end if;
  new.updated_at = now();
  return new;
end $$;
drop trigger if exists booking_room_assignments_protect_history on public.booking_room_assignments;
create trigger booking_room_assignments_protect_history before update or delete on public.booking_room_assignments
  for each row execute function public.protect_room_assignment_history();

create or replace function public.assign_room_atomic(target_booking_id uuid, target_room_id uuid)
returns setof public.booking_room_assignments language plpgsql security definer set search_path = public as $$
declare
  locked_booking public.bookings;
  selected_room record;
  created public.booking_room_assignments;
begin
  select * into locked_booking from public.bookings where id = target_booking_id for update;
  if not found then raise exception 'BOOKING_NOT_FOUND'; end if;
  if locked_booking.check_in is null or locked_booking.check_out is null or locked_booking.check_in >= locked_booking.check_out then
    raise exception 'BOOKING_DATES_INVALID';
  end if;
  if locked_booking.booking_status not in ('Pending','Confirmed') then raise exception 'BOOKING_NOT_ASSIGNABLE'; end if;

  select room.id, room.is_active, room.operational_status, room_type.name as room_type
    into selected_room
    from public.rooms room join public.room_types room_type on room_type.id = room.room_type_id
    where room.id = target_room_id for update of room;
  if not found then raise exception 'ROOM_NOT_FOUND'; end if;
  if selected_room.room_type <> locked_booking.room_type then raise exception 'ROOM_TYPE_MISMATCH'; end if;
  if not selected_room.is_active or selected_room.operational_status <> 'operational' then raise exception 'ROOM_NOT_OPERATIONAL'; end if;

  begin
    insert into public.booking_room_assignments(booking_id, room_id, allocation_range)
    values (locked_booking.id, selected_room.id, daterange(locked_booking.check_in, locked_booking.check_out, '[)'))
    returning * into created;
  exception
    when exclusion_violation then raise exception 'ROOM_ASSIGNMENT_CONFLICT' using errcode = '23P01';
    when unique_violation then raise exception 'BOOKING_ALREADY_ASSIGNED' using errcode = '23505';
  end;
  return next created;
end $$;

create or replace function public.release_room_assignment(target_booking_id uuid)
returns setof public.booking_room_assignments language plpgsql security definer set search_path = public as $$
declare released public.booking_room_assignments;
begin
  select * into released from public.booking_room_assignments
    where booking_id = target_booking_id and assignment_status = 'active' for update;
  if not found then return; end if;
  update public.booking_room_assignments set assignment_status = 'released', released_at = now()
    where id = released.id returning * into released;
  return next released;
end $$;

revoke all on function public.assign_room_atomic(uuid, uuid) from public, anon, authenticated;
revoke all on function public.release_room_assignment(uuid) from public, anon, authenticated;
grant execute on function public.assign_room_atomic(uuid, uuid) to service_role;
grant execute on function public.release_room_assignment(uuid) to service_role;
