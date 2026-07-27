-- Reconcile the two production failures caused by a legacy bookings table and
-- an absent/partial audit_logs table. Additive, repeatable, and data preserving.
begin;

do $preflight$
declare actual text;
begin
  if to_regclass('public.bookings') is null then
    raise exception '010 preflight failed: public.bookings does not exist; apply the baseline schema first';
  end if;

  select format_type(a.atttypid, a.atttypmod) into actual
  from pg_attribute a
  where a.attrelid = 'public.bookings'::regclass
    and a.attname = 'booking_id' and a.attnum > 0 and not a.attisdropped;
  if actual is distinct from 'text' then
    raise exception '010 preflight failed: public.bookings.booking_id must be text, found %', coalesce(actual, 'missing');
  end if;

  if exists (
    select 1 from pg_attribute a where a.attrelid = 'public.bookings'::regclass
      and a.attname = 'id' and a.attnum > 0 and not a.attisdropped
      and format_type(a.atttypid, a.atttypmod) <> 'uuid'
  ) then
    raise exception '010 preflight failed: public.bookings.id exists but is not uuid';
  end if;
end $preflight$;

create extension if not exists pgcrypto;
alter table public.bookings add column if not exists id uuid default gen_random_uuid();
update public.bookings set id = gen_random_uuid() where id is null;
alter table public.bookings alter column id set default gen_random_uuid();
alter table public.bookings alter column id set not null;
create unique index if not exists bookings_id_uidx on public.bookings(id);

create table if not exists public.audit_logs (
  id bigint generated always as identity primary key,
  user_name text not null,
  action text not null,
  entity text not null,
  entity_id text,
  created_at timestamptz not null default now(),
  ip inet,
  details jsonb not null default '{}'::jsonb
);
alter table public.audit_logs add column if not exists user_name text;
alter table public.audit_logs add column if not exists id bigint generated always as identity;
alter table public.audit_logs add column if not exists action text;
alter table public.audit_logs add column if not exists entity text;
alter table public.audit_logs add column if not exists entity_id text;
alter table public.audit_logs add column if not exists created_at timestamptz default now();
alter table public.audit_logs add column if not exists ip inet;
alter table public.audit_logs add column if not exists details jsonb default '{}'::jsonb;

do $preflight$
declare c record; actual text;
begin
  for c in select * from (values
    ('id','bigint'), ('user_name','text'), ('action','text'), ('entity','text'), ('entity_id','text'),
    ('created_at','timestamp with time zone'), ('ip','inet'), ('details','jsonb')
  ) v(column_name, expected_type)
  loop
    select format_type(a.atttypid, a.atttypmod) into actual from pg_attribute a
    where a.attrelid = 'public.audit_logs'::regclass and a.attname = c.column_name
      and a.attnum > 0 and not a.attisdropped;
    if actual is distinct from c.expected_type then
      raise exception '010 preflight failed: public.audit_logs.% expected %, found %', c.column_name, c.expected_type, coalesce(actual, 'missing');
    end if;
  end loop;
end $preflight$;

update public.audit_logs set created_at = now() where created_at is null;
update public.audit_logs set details = '{}'::jsonb where details is null;
alter table public.audit_logs alter column created_at set default now();
alter table public.audit_logs alter column created_at set not null;
alter table public.audit_logs alter column details set default '{}'::jsonb;
alter table public.audit_logs alter column details set not null;
create index if not exists audit_logs_created_at_idx on public.audit_logs(created_at desc);
create unique index if not exists audit_logs_id_uidx on public.audit_logs(id);
create index if not exists audit_logs_action_entity_idx on public.audit_logs(action, entity, created_at desc);
alter table public.audit_logs enable row level security;
revoke all on public.audit_logs from public, anon, authenticated;
grant select, insert on public.audit_logs to service_role;
do $grant_sequence$
declare sequence_name text;
begin
  sequence_name := pg_get_serial_sequence('public.audit_logs', 'id');
  if sequence_name is null then
    raise exception '010 preflight failed: public.audit_logs.id has no identity sequence';
  end if;
  execute format('grant usage, select on sequence %s to service_role', sequence_name);
end $grant_sequence$;

commit;
