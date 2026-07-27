begin;

-- Production preflight: abort before changing anything when the inspected
-- four-table schema or its two configured room types is not as expected.
do $$
declare
  missing_columns text;
begin
  if to_regclass('public.room_types') is null then
    raise exception 'Availability migration preflight failed: public.room_types does not exist';
  end if;
  if to_regclass('public.bookings') is null then
    raise exception 'Availability migration preflight failed: public.bookings does not exist';
  end if;

  select string_agg(expected.table_name || '.' || expected.column_name, ', ' order by expected.table_name, expected.column_name)
    into missing_columns
  from (values
    ('room_types', 'name'), ('room_types', 'is_active'),
    ('bookings', 'idempotency_key'), ('bookings', 'room_type'),
    ('bookings', 'booking_status'), ('bookings', 'check_in'), ('bookings', 'check_out'),
    ('bookings', 'booking_id'), ('bookings', 'customer_name'), ('bookings', 'phone'),
    ('bookings', 'email'), ('bookings', 'adults'), ('bookings', 'children'),
    ('bookings', 'payment_type'), ('bookings', 'payment_status'),
    ('bookings', 'razorpay_order_id'), ('bookings', 'razorpay_payment_id'),
    ('bookings', 'amount'), ('bookings', 'advance_amount'),
    ('bookings', 'special_request'), ('bookings', 'nights'),
    ('bookings', 'paid_nights'), ('bookings', 'complimentary_nights')
  ) as expected(table_name, column_name)
  where not exists (
    select 1 from information_schema.columns actual
    where actual.table_schema = 'public'
      and actual.table_name = expected.table_name
      and actual.column_name = expected.column_name
  );
  if missing_columns is not null then
    raise exception 'Availability migration preflight failed: required columns missing: %', missing_columns;
  end if;

  if not exists (select 1 from public.room_types where name = 'Deluxe' and is_active is true) then
    raise exception 'Availability migration preflight failed: active room type Deluxe is missing';
  end if;
  if not exists (select 1 from public.room_types where name = 'Standard' and is_active is true) then
    raise exception 'Availability migration preflight failed: active room type Standard is missing';
  end if;
end $$;

alter table public.room_types
  add column if not exists inventory_count integer not null default 1;

update public.room_types set inventory_count = 3 where name = 'Deluxe';
update public.room_types set inventory_count = 3 where name = 'Standard';

do $$
begin
  if exists (select 1 from public.room_types where inventory_count is null or inventory_count <= 0) then
    raise exception 'Availability migration preflight failed: room_types.inventory_count values must be positive';
  end if;
end $$;

alter table public.room_types alter column inventory_count set default 1;
alter table public.room_types alter column inventory_count set not null;

create or replace function public.room_availability(
  requested_room_type text,
  requested_check_in date,
  requested_check_out date
)
returns table(inventory integer, occupied integer, remaining integer)
language sql stable security definer set search_path = public as $$
  with selected_room_type as (
    select case when is_active then inventory_count else 0 end::integer as inventory
    from public.room_types
    where name = requested_room_type
  ), overlapping_bookings as (
    select count(*)::integer as occupied
    from public.bookings
    where room_type = requested_room_type
      and booking_status in ('Pending', 'Confirmed')
      and check_in < requested_check_out
      and check_out > requested_check_in
  )
  select
    coalesce(selected_room_type.inventory, 0),
    overlapping_bookings.occupied,
    greatest(coalesce(selected_room_type.inventory, 0) - overlapping_bookings.occupied, 0)::integer
  from overlapping_bookings
  left join selected_room_type on true;
$$;

revoke all on function public.room_availability(text, date, date) from public, anon, authenticated;
grant execute on function public.room_availability(text, date, date) to service_role;

create or replace function public.create_booking_atomic(booking_data jsonb)
returns setof public.bookings language plpgsql security definer set search_path = public as $$
declare availability record; existing public.bookings; created public.bookings;
begin
  perform pg_advisory_xact_lock(hashtext(booking_data->>'room_type'));
  select * into existing from public.bookings where idempotency_key = booking_data->>'idempotency_key';
  if found then return next existing; return; end if;

  select * into availability
  from public.room_availability(
    booking_data->>'room_type',
    (booking_data->>'check_in')::date,
    (booking_data->>'check_out')::date
  );
  if availability.remaining <= 0 then return; end if;

  insert into public.bookings (booking_id,idempotency_key,customer_name,phone,email,room_type,check_in,check_out,adults,children,payment_type,payment_status,razorpay_order_id,razorpay_payment_id,amount,advance_amount,booking_status,special_request,nights,paid_nights,complimentary_nights)
  values (booking_data->>'booking_id',booking_data->>'idempotency_key',booking_data->>'customer_name',booking_data->>'phone',booking_data->>'email',booking_data->>'room_type',(booking_data->>'check_in')::date,(booking_data->>'check_out')::date,(booking_data->>'adults')::int,(booking_data->>'children')::int,booking_data->>'payment_type',booking_data->>'payment_status',booking_data->>'razorpay_order_id',booking_data->>'razorpay_payment_id',(booking_data->>'amount')::numeric,(booking_data->>'advance_amount')::numeric,'Confirmed',booking_data->>'special_request',(booking_data->>'nights')::int,(booking_data->>'paid_nights')::int,(booking_data->>'complimentary_nights')::int)
  returning * into created;
  return next created;
end $$;

revoke all on function public.create_booking_atomic(jsonb) from public, anon, authenticated;
grant execute on function public.create_booking_atomic(jsonb) to service_role;

-- Retire the configuration-based overloads only after their replacements exist.
drop function if exists public.create_booking_atomic(jsonb, integer);
drop function if exists public.room_availability(text, date, date, integer);

commit;
