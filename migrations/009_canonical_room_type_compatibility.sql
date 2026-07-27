begin;

-- Keep customer-facing and historical names compatible with canonical inventory.
create or replace function public.canonical_room_type(room_type_name text)
returns text language sql immutable strict parallel safe as $$
  select case room_type_name
    when 'AC Room' then 'Deluxe'
    when 'Non AC Room' then 'Standard'
    else room_type_name
  end
$$;

create or replace function public.room_availability(
  requested_room_type text,
  requested_check_in date,
  requested_check_out date
)
returns table(inventory integer, occupied integer, remaining integer)
language sql stable security definer set search_path = public as $$
  with request as (
    select public.canonical_room_type(requested_room_type) as room_type
  ), selected_room_type as (
    select case when is_active then inventory_count else 0 end::integer as inventory
    from public.room_types, request
    where name = request.room_type
  ), overlapping_bookings as (
    select count(*)::integer as occupied
    from public.bookings, request
    where public.canonical_room_type(bookings.room_type) = request.room_type
      and booking_status in ('Pending', 'Confirmed')
      and check_in < requested_check_out
      and check_out > requested_check_in
  )
  select coalesce(selected_room_type.inventory, 0), overlapping_bookings.occupied,
    greatest(coalesce(selected_room_type.inventory, 0) - overlapping_bookings.occupied, 0)::integer
  from overlapping_bookings left join selected_room_type on true;
$$;

create or replace function public.create_booking_atomic(booking_data jsonb)
returns setof public.bookings language plpgsql security definer set search_path = public as $$
declare availability record; existing public.bookings; created public.bookings; canonical_type text;
begin
  canonical_type := public.canonical_room_type(booking_data->>'room_type');
  perform pg_advisory_xact_lock(hashtext(canonical_type));
  select * into existing from public.bookings where idempotency_key = booking_data->>'idempotency_key';
  if found then return next existing; return; end if;
  select * into availability from public.room_availability(canonical_type, (booking_data->>'check_in')::date, (booking_data->>'check_out')::date);
  if availability.remaining <= 0 then return; end if;
  insert into public.bookings (booking_id,idempotency_key,customer_name,phone,email,room_type,check_in,check_out,adults,children,payment_type,payment_status,razorpay_order_id,razorpay_payment_id,amount,advance_amount,booking_status,special_request,nights,paid_nights,complimentary_nights)
  values (booking_data->>'booking_id',booking_data->>'idempotency_key',booking_data->>'customer_name',booking_data->>'phone',booking_data->>'email',canonical_type,(booking_data->>'check_in')::date,(booking_data->>'check_out')::date,(booking_data->>'adults')::int,(booking_data->>'children')::int,booking_data->>'payment_type',booking_data->>'payment_status',booking_data->>'razorpay_order_id',booking_data->>'razorpay_payment_id',(booking_data->>'amount')::numeric,(booking_data->>'advance_amount')::numeric,'Confirmed',booking_data->>'special_request',(booking_data->>'nights')::int,(booking_data->>'paid_nights')::int,(booking_data->>'complimentary_nights')::int)
  returning * into created;
  return next created;
end $$;

revoke all on function public.canonical_room_type(text) from public, anon, authenticated;
grant execute on function public.canonical_room_type(text) to service_role;
revoke all on function public.room_availability(text, date, date) from public, anon, authenticated;
grant execute on function public.room_availability(text, date, date) to service_role;
revoke all on function public.create_booking_atomic(jsonb) from public, anon, authenticated;
grant execute on function public.create_booking_atomic(jsonb) to service_role;

commit;
