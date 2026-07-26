-- Apply after 001_production_schema.sql. This migration is additive and idempotent.
-- Run ANALYZE after application so the planner can use the new indexes immediately.

create index if not exists payment_orders_status_created_idx
  on public.payment_orders(status, created_at desc);
create index if not exists bookings_admin_listing_idx
  on public.bookings(booking_status, room_type, check_in, created_at desc);
create index if not exists bookings_check_out_idx
  on public.bookings(check_out, booking_status);
create index if not exists housekeeping_tasks_status_created_idx
  on public.housekeeping_tasks(status, created_at desc);
create index if not exists booking_room_assignments_active_room_idx
  on public.booking_room_assignments(room_id, booking_id)
  where assignment_status = 'active';
create index if not exists reviews_moderation_idx
  on public.reviews(status, created_at desc);

-- Explicit NULL semantics: only non-null provider IDs must be globally unique.
create unique index if not exists payment_orders_payment_id_uidx
  on public.payment_orders(razorpay_payment_id)
  where razorpay_payment_id is not null;

analyze public.payment_orders;
analyze public.bookings;
analyze public.booking_room_assignments;
analyze public.housekeeping_tasks;
analyze public.reviews;
