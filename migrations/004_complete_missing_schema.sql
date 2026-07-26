-- Complete the only schema object verified missing in the partially initialized
-- production database. This migration is additive and safe to run repeatedly.
-- It intentionally does not attempt to reconcile or replace existing objects.

create extension if not exists pgcrypto;

create table if not exists public.room_types (
  id uuid primary key default gen_random_uuid(),
  name text not null unique check (char_length(trim(name)) between 1 and 100),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Create the shared trigger function only when it is absent. Unlike CREATE OR
-- REPLACE, this preserves any production implementation already in use.
do $migration$
begin
  if to_regprocedure('public.set_updated_at()') is null then
    execute $function$
      create function public.set_updated_at() returns trigger
      language plpgsql
      as 'begin new.updated_at = now(); return new; end'
    $function$;
  end if;
end
$migration$;

-- Trigger names are scoped to a table. Guard on both table and trigger identity
-- so an existing trigger is neither duplicated nor replaced.
do $migration$
begin
  if not exists (
    select 1
    from pg_catalog.pg_trigger
    where tgrelid = 'public.room_types'::regclass
      and tgname = 'room_types_set_updated_at'
      and not tgisinternal
  ) then
    create trigger room_types_set_updated_at
      before update on public.room_types
      for each row execute function public.set_updated_at();
  end if;
end
$migration$;

-- Add only absent seed values. ON CONFLICT never changes an existing row and
-- also makes concurrent/repeated application safe.
insert into public.room_types(name)
values ('Standard'), ('Deluxe')
on conflict (name) do nothing;
