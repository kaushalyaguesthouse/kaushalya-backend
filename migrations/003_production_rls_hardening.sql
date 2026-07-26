-- Kaushalya backend-only API security hardening.
-- Apply after 001 and 002 in Supabase SQL Editor. This migration is additive,
-- preserves all rows, and is safe to run repeatedly or against a partially
-- provisioned legacy schema. Missing application tables are deliberately skipped:
-- 001_production_schema.sql remains the canonical schema migration.
-- The browser calls the Render API; it never needs direct table privileges.

do $migration$
declare
  table_name text;
begin
  foreach table_name in array array[
    'bookings',
    'payment_orders',
    'reviews',
    'room_types',
    'rooms',
    'booking_room_assignments',
    'booking_stays',
    'housekeeping_tasks'
  ]
  loop
    if to_regclass(format('%I.%I', 'public', table_name)) is not null then
      execute format('alter table %I.%I enable row level security', 'public', table_name);
      execute format('revoke all on table %I.%I from public, anon, authenticated', 'public', table_name);
      execute format('grant select, insert, update, delete on table %I.%I to service_role', 'public', table_name);
    end if;
  end loop;
end
$migration$;

-- Reassert the already-private Feature Pack tables in case legacy grants exist.
-- These are guarded as well so hardening an older production schema cannot fail
-- before the canonical additive schema migration has been applied.
do $migration$
declare
  table_name text;
  service_privileges text;
begin
  foreach table_name in array array['business_settings', 'invoices', 'audit_logs']
  loop
    if to_regclass(format('%I.%I', 'public', table_name)) is not null then
      execute format('alter table %I.%I enable row level security', 'public', table_name);
      execute format('revoke all on table %I.%I from public, anon, authenticated', 'public', table_name);
      service_privileges := case table_name
        when 'business_settings' then 'select, update'
        else 'select, insert'
      end;
      execute format('grant %s on table %I.%I to service_role', service_privileges, 'public', table_name);
    end if;
  end loop;
end
$migration$;

-- No anon/authenticated policies are intentionally created. The service_role
-- bypasses RLS and is confined to the backend secret store.
