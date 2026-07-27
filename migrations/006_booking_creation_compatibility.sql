-- Repair the legacy production column used by the original booking endpoint.
-- The atomic RPC intentionally omits refund_status; legacy deployments defined
-- it as NOT NULL without a default, making every RPC insert fail with 23502.
do $migration$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'bookings'
      and column_name = 'refund_status'
  ) then
    alter table public.bookings alter column refund_status set default 'N/A';
    update public.bookings set refund_status = 'N/A' where refund_status is null;
  end if;
end $migration$;

-- The function is replaced deliberately: unlike reconciliation migration 005,
-- this is a behavior-fix migration and must also repair an existing definition.
create or replace function public.create_booking_atomic(booking_data jsonb, room_inventory integer)
returns setof public.bookings language plpgsql security definer set search_path = public as $$
declare occupied integer; existing public.bookings; created public.bookings;
begin
  perform pg_advisory_xact_lock(hashtext(booking_data->>'room_type'));
  select * into existing from bookings where idempotency_key = booking_data->>'idempotency_key';
  if found then return next existing; return; end if;
  select count(*) into occupied from bookings
    where room_type = booking_data->>'room_type'
      and booking_status in ('Pending','Confirmed')
      and check_in < (booking_data->>'check_out')::date
      and check_out > (booking_data->>'check_in')::date;
  if occupied >= room_inventory then return; end if;
  insert into bookings (booking_id,idempotency_key,customer_name,phone,email,room_type,check_in,check_out,adults,children,payment_type,payment_status,razorpay_order_id,razorpay_payment_id,amount,advance_amount,booking_status,special_request,nights,paid_nights,complimentary_nights)
  values (booking_data->>'booking_id',booking_data->>'idempotency_key',booking_data->>'customer_name',booking_data->>'phone',booking_data->>'email',booking_data->>'room_type',(booking_data->>'check_in')::date,(booking_data->>'check_out')::date,(booking_data->>'adults')::int,(booking_data->>'children')::int,booking_data->>'payment_type',booking_data->>'payment_status',booking_data->>'razorpay_order_id',booking_data->>'razorpay_payment_id',(booking_data->>'amount')::numeric,(booking_data->>'advance_amount')::numeric,'Confirmed',booking_data->>'special_request',(booking_data->>'nights')::int,(booking_data->>'paid_nights')::int,(booking_data->>'complimentary_nights')::int)
  returning * into created;
  return next created;
end $$;

revoke all on function public.create_booking_atomic(jsonb, integer) from public, anon, authenticated;
grant execute on function public.create_booking_atomic(jsonb, integer) to service_role;
