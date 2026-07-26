-- Kaushalya backend-only API security hardening.
-- Apply after 001 and 002 in Supabase SQL Editor. This migration is additive,
-- preserves all rows, and is safe to run repeatedly.
-- The browser calls the Render API; it never needs direct table privileges.

alter table public.bookings enable row level security;
alter table public.payment_orders enable row level security;
alter table public.reviews enable row level security;
alter table public.room_types enable row level security;
alter table public.rooms enable row level security;
alter table public.booking_room_assignments enable row level security;
alter table public.booking_stays enable row level security;
alter table public.housekeeping_tasks enable row level security;

revoke all on table public.bookings, public.payment_orders, public.reviews,
  public.room_types, public.rooms, public.booking_room_assignments,
  public.booking_stays, public.housekeeping_tasks
from public, anon, authenticated;

grant select, insert, update, delete on table public.bookings, public.payment_orders,
  public.reviews, public.room_types, public.rooms, public.booking_room_assignments,
  public.booking_stays, public.housekeeping_tasks
to service_role;

-- Reassert the already-private Feature Pack tables in case legacy grants exist.
alter table public.business_settings enable row level security;
alter table public.invoices enable row level security;
alter table public.audit_logs enable row level security;
revoke all on table public.business_settings, public.invoices, public.audit_logs
from public, anon, authenticated;
grant select, update on table public.business_settings to service_role;
grant select, insert on table public.invoices, public.audit_logs to service_role;

-- No anon/authenticated policies are intentionally created. The service_role
-- bypasses RLS and is confined to the backend secret store.
