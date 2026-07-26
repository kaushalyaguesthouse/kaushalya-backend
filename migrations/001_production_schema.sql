-- Additive/idempotent production migration. Run in the Supabase SQL editor.
create extension if not exists pgcrypto;

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
