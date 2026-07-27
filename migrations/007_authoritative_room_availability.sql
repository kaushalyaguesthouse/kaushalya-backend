-- Use the physical room catalogue as the authoritative inventory whenever it
-- has been configured.  The application value remains a compatibility
-- fallback for installations which have not created physical rooms yet.
create or replace function public.room_availability(
  requested_room_type text,
  requested_check_in date,
  requested_check_out date,
  configured_inventory integer
)
returns table(inventory integer, occupied integer, remaining integer)
language sql stable security definer set search_path = public as $$
  with physical_inventory as (
    select count(*)::integer as room_count
    from rooms
    join room_types on room_types.id = rooms.room_type_id
    where room_types.name = requested_room_type
      and room_types.is_active
      and rooms.is_active
      and rooms.operational_status = 'operational'
  ), overlapping_bookings as (
    select count(*)::integer as booking_count
    from bookings
    where room_type = requested_room_type
      and booking_status in ('Pending', 'Confirmed')
      and check_in < requested_check_out
      and check_out > requested_check_in
  )
  select
    case when physical_inventory.room_count > 0
      then physical_inventory.room_count
      else greatest(coalesce(configured_inventory, 0), 0)
    end,
    overlapping_bookings.booking_count,
    greatest(
      case when physical_inventory.room_count > 0
        then physical_inventory.room_count
        else greatest(coalesce(configured_inventory, 0), 0)
      end - overlapping_bookings.booking_count,
      0
    )
  from physical_inventory cross join overlapping_bookings;
$$;

revoke all on function public.room_availability(text, date, date, integer) from public, anon, authenticated;
grant execute on function public.room_availability(text, date, date, integer) to service_role;

create or replace function public.create_booking_atomic(booking_data jsonb, room_inventory integer)
returns setof public.bookings language plpgsql security definer set search_path = public as $$
declare availability record; existing public.bookings; created public.bookings;
begin
  perform pg_advisory_xact_lock(hashtext(booking_data->>'room_type'));
  select * into existing from bookings where idempotency_key = booking_data->>'idempotency_key';
  if found then return next existing; return; end if;

  select * into availability
  from room_availability(
    booking_data->>'room_type',
    (booking_data->>'check_in')::date,
    (booking_data->>'check_out')::date,
    room_inventory
  );
  if availability.remaining <= 0 then return; end if;

  insert into bookings (booking_id,idempotency_key,customer_name,phone,email,room_type,check_in,check_out,adults,children,payment_type,payment_status,razorpay_order_id,razorpay_payment_id,amount,advance_amount,booking_status,special_request,nights,paid_nights,complimentary_nights)
  values (booking_data->>'booking_id',booking_data->>'idempotency_key',booking_data->>'customer_name',booking_data->>'phone',booking_data->>'email',booking_data->>'room_type',(booking_data->>'check_in')::date,(booking_data->>'check_out')::date,(booking_data->>'adults')::int,(booking_data->>'children')::int,booking_data->>'payment_type',booking_data->>'payment_status',booking_data->>'razorpay_order_id',booking_data->>'razorpay_payment_id',(booking_data->>'amount')::numeric,(booking_data->>'advance_amount')::numeric,'Confirmed',booking_data->>'special_request',(booking_data->>'nights')::int,(booking_data->>'paid_nights')::int,(booking_data->>'complimentary_nights')::int)
  returning * into created;
  return next created;
end $$;

revoke all on function public.create_booking_atomic(jsonb, integer) from public, anon, authenticated;
grant execute on function public.create_booking_atomic(jsonb, integer) to service_role;
