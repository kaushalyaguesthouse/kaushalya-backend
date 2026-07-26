-- Reconcile the legacy production schema with every object used by the backend.
-- This migration is additive, repeatable, and preserves all existing rows.

create extension if not exists pgcrypto;
create extension if not exists btree_gist;

-- The production bookings relation predates the canonical migration.  In
-- particular it does not have the Feature Pack reporting column.  List every
-- application column so this also repairs any other partially-created copy.
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
alter table public.bookings add column if not exists refund_amount numeric(12,2) not null default 0 check (refund_amount >= 0);

-- ADD COLUMN IF NOT EXISTS cannot repair a legacy column. Abort before any
-- indexes/functions are installed when a backend-facing legacy type is unsafe.
do $migration$
declare c record; actual text;
begin
  for c in select * from (values
    ('bookings','id','uuid'),('bookings','booking_id','text'),('bookings','idempotency_key','text'),
    ('bookings','customer_name','text'),('bookings','phone','text'),('bookings','email','text'),
    ('bookings','room_type','text'),('bookings','check_in','date'),('bookings','check_out','date'),
    ('bookings','adults','integer'),('bookings','children','integer'),('bookings','payment_type','text'),
    ('bookings','payment_status','text'),('bookings','razorpay_order_id','text'),
    ('bookings','razorpay_payment_id','text'),('bookings','amount','numeric'),
    ('bookings','advance_amount','numeric'),('bookings','booking_status','text'),
    ('bookings','special_request','text'),('bookings','nights','integer'),
    ('bookings','paid_nights','integer'),('bookings','complimentary_nights','integer'),
    ('bookings','email_sent_at','timestamp with time zone'),('bookings','created_at','timestamp with time zone'),
    ('bookings','updated_at','timestamp with time zone'),('bookings','refund_amount','numeric')
  ) v(table_name,column_name,expected_type)
  loop
    select format_type(a.atttypid,a.atttypmod) into actual from pg_attribute a
    where a.attrelid=format('public.%I',c.table_name)::regclass and a.attname=c.column_name and a.attnum>0 and not a.attisdropped;
    if actual is null or (c.expected_type='numeric' and actual !~ '^numeric(\([0-9]+,[0-9]+\))?$') or (c.expected_type<>'numeric' and actual<>c.expected_type) then
      raise exception 'SCHEMA_INCOMPATIBLE: %.% expected %, found %. No data was changed; resolve the legacy definition and rerun 005.',c.table_name,c.column_name,c.expected_type,coalesce(actual,'missing');
    end if;
  end loop;
end $migration$;

-- 004 created room_types.  Keep the definition here for databases on which 004
-- was only partly applied, without replacing the relation or its data.
create table if not exists public.room_types (
  id uuid primary key default gen_random_uuid(), name text not null unique,
  is_active boolean not null default true, created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table if not exists public.rooms (
  id uuid primary key default gen_random_uuid(),
  room_number text not null unique check (char_length(trim(room_number)) between 1 and 20),
  room_type_id uuid not null references public.room_types(id) on update cascade on delete restrict,
  floor integer not null check (floor >= 0),
  operational_status text not null default 'operational' check (operational_status in ('operational','maintenance','out_of_service')),
  housekeeping_status text not null default 'clean' check (housekeeping_status in ('clean','dirty','cleaning','inspected')),
  notes text check (notes is null or char_length(notes) <= 2000), is_active boolean not null default true,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table if not exists public.booking_room_assignments (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null references public.bookings(id) on update cascade on delete restrict,
  room_id uuid not null references public.rooms(id) on update cascade on delete restrict,
  assignment_status text not null default 'active' check (assignment_status in ('active','released')),
  assigned_at timestamptz not null default now(), assigned_by text not null,
  released_at timestamptz, released_by text,
  release_reason text check (release_reason is null or char_length(release_reason) <= 500),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  allocation_range daterange not null,
  check ((assignment_status='active' and released_at is null and released_by is null)
      or (assignment_status='released' and released_at is not null and released_by is not null)),
  constraint booking_room_assignments_allocation_range_check check (
    not isempty(allocation_range) and not lower_inf(allocation_range) and not upper_inf(allocation_range)
    and lower_inc(allocation_range) and not upper_inc(allocation_range))
);
create table if not exists public.booking_stays (
  booking_id uuid primary key references public.bookings(id) on update cascade on delete restrict,
  stay_status text not null default 'not_checked_in' check (stay_status in ('not_checked_in','checked_in','checked_out','no_show')),
  checked_in_at timestamptz, checked_out_at timestamptz, no_show_at timestamptz,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table if not exists public.housekeeping_tasks (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null references public.bookings(id) on update cascade on delete restrict,
  room_id uuid not null references public.rooms(id) on update cascade on delete restrict,
  task_type text not null check (task_type in ('turnover','stayover','inspection','deep_clean')),
  status text not null default 'pending' check (status in ('pending','cleaning','completed','inspected','cancelled')),
  assigned_to text, notes text check (notes is null or char_length(notes) <= 2000),
  created_at timestamptz not null default now(), completed_at timestamptz,
  updated_at timestamptz not null default now()
);
create table if not exists public.business_settings (
  id boolean primary key default true check (id), business_name text not null default 'Kaushalya Guest House',
  gst_number text, gst_percent numeric(5,2) not null default 0 check (gst_percent between 0 and 100),
  address text, phone text, email text, invoice_footer text,
  invoice_prefix text not null default 'KGH' check (invoice_prefix ~ '^[A-Z0-9-]{1,12}$'),
  currency char(3) not null default 'INR', timezone text not null default 'Asia/Kolkata',
  logo_metadata jsonb not null default '{}'::jsonb, updated_at timestamptz not null default now()
);
create sequence if not exists public.invoice_number_seq;
create table if not exists public.invoices (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null unique references public.bookings(id) on delete restrict,
  invoice_number text not null unique, issued_at timestamptz not null default now(),
  extra_charges numeric(12,2) not null default 0, discount numeric(12,2) not null default 0,
  gst_amount numeric(12,2) not null default 0, grand_total numeric(12,2) not null,
  currency char(3) not null, business_details jsonb not null, created_at timestamptz not null default now()
);
create table if not exists public.audit_logs (
  id bigint generated always as identity primary key, user_name text not null,
  action text not null, entity text not null, entity_id text,
  created_at timestamptz not null default now(), ip inet, details jsonb not null default '{}'::jsonb
);

-- Existing core tables pass the health projection, but reconcile columns used by
-- writes and non-health queries too.  Defaults make additions safe for old rows.
create table if not exists public.payment_orders (
  id uuid primary key default gen_random_uuid(), idempotency_key text not null unique,
  razorpay_order_id text not null unique, razorpay_payment_id text unique, razorpay_signature text,
  amount_paise integer not null check (amount_paise > 0), booking_payload jsonb not null,
  status text not null default 'created', verified_at timestamptz, created_at timestamptz not null default now()
);
alter table public.payment_orders add column if not exists id uuid default gen_random_uuid();
alter table public.payment_orders add column if not exists idempotency_key text;
alter table public.payment_orders add column if not exists razorpay_order_id text;
alter table public.payment_orders add column if not exists razorpay_payment_id text;
alter table public.payment_orders add column if not exists razorpay_signature text;
alter table public.payment_orders add column if not exists amount_paise integer;
alter table public.payment_orders add column if not exists booking_payload jsonb;
alter table public.payment_orders add column if not exists status text default 'created';
alter table public.payment_orders add column if not exists verified_at timestamptz;
alter table public.payment_orders add column if not exists created_at timestamptz default now();
create table if not exists public.reviews (
  id uuid primary key default gen_random_uuid(), customer_name text not null, customer_email text not null,
  rating smallint not null check (rating between 1 and 5), review text not null,
  status text not null default 'pending', created_at timestamptz not null default now(), moderated_at timestamptz
);
alter table public.reviews add column if not exists id uuid default gen_random_uuid();
alter table public.reviews add column if not exists customer_name text;
alter table public.reviews add column if not exists customer_email text;
alter table public.reviews add column if not exists rating smallint;
alter table public.reviews add column if not exists review text;
alter table public.reviews add column if not exists status text default 'pending';
alter table public.reviews add column if not exists created_at timestamptz default now();
alter table public.reviews add column if not exists moderated_at timestamptz;

-- Validate legacy payment/review definitions after additive columns and before constraints/indexes.
do $migration$
declare c record; actual text;
begin
  for c in select * from (values
    ('payment_orders','id','uuid'),('payment_orders','idempotency_key','text'),
    ('payment_orders','razorpay_order_id','text'),('payment_orders','razorpay_payment_id','text'),
    ('payment_orders','razorpay_signature','text'),('payment_orders','amount_paise','integer'),
    ('payment_orders','booking_payload','jsonb'),('payment_orders','status','text'),
    ('payment_orders','verified_at','timestamp with time zone'),('payment_orders','created_at','timestamp with time zone'),
    ('reviews','id','uuid'),('reviews','customer_name','text'),('reviews','customer_email','text'),
    ('reviews','rating','smallint'),('reviews','review','text'),('reviews','status','text'),
    ('reviews','created_at','timestamp with time zone'),('reviews','moderated_at','timestamp with time zone')
  ) v(table_name,column_name,expected_type)
  loop
    select format_type(a.atttypid,a.atttypmod) into actual from pg_attribute a
    where a.attrelid=format('public.%I',c.table_name)::regclass and a.attname=c.column_name and a.attnum>0 and not a.attisdropped;
    if actual is distinct from c.expected_type then
      raise exception 'SCHEMA_INCOMPATIBLE: %.% expected %, found %. No data was changed; resolve the legacy definition and rerun 005.',c.table_name,c.column_name,c.expected_type,coalesce(actual,'missing');
    end if;
  end loop;
end $migration$;

-- Required legacy write fields must retain the canonical nullability/default contract.
-- A partially initialized table is stopped for operator review instead of backfilling unknown values.
do $migration$
declare c record; is_not_null boolean; default_expression text; invalid_values text;
begin
  for c in select * from (values
    ('payment_orders','id',true,null),('payment_orders','idempotency_key',true,null),
    ('payment_orders','razorpay_order_id',true,null),('payment_orders','amount_paise',true,null),
    ('payment_orders','booking_payload',true,null),('payment_orders','status',true,'''created'''),
    ('payment_orders','created_at',true,'now()'),('reviews','id',true,null),
    ('reviews','customer_name',true,null),('reviews','customer_email',true,null),
    ('reviews','rating',true,null),('reviews','review',true,null),
    ('reviews','status',true,'''pending'''),('reviews','created_at',true,'now()'),
    ('bookings','refund_amount',true,'0')
  ) v(table_name,column_name,expected_not_null,expected_default)
  loop
    select a.attnotnull,pg_get_expr(d.adbin,d.adrelid) into is_not_null,default_expression
    from pg_attribute a left join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum
    where a.attrelid=format('public.%I',c.table_name)::regclass and a.attname=c.column_name and a.attnum>0 and not a.attisdropped;
    if is_not_null is distinct from c.expected_not_null or
       (c.expected_default is not null and coalesce(default_expression,'') not like '%'||c.expected_default||'%') then
      raise exception 'SCHEMA_INCOMPATIBLE: %.% has incompatible nullability/default (not_null=%, default=%). Review legacy rows and repair explicitly; 005 did not backfill them.',c.table_name,c.column_name,is_not_null,default_expression;
    end if;
  end loop;
  select string_agg(distinct status, ', ' order by status) into invalid_values from public.payment_orders where status not in ('created','verified','failed');
  if invalid_values is not null then raise exception 'SCHEMA_INCOMPATIBLE: payment_orders.status has unsupported values: %. Resolve manually.',invalid_values; end if;
  select string_agg(distinct status, ', ' order by status) into invalid_values from public.reviews where status not in ('pending','approved','rejected');
  if invalid_values is not null then raise exception 'SCHEMA_INCOMPATIBLE: reviews.status has unsupported values: %. Resolve manually.',invalid_values; end if;
end $migration$;

insert into public.room_types(name) values ('Standard'),('Deluxe') on conflict (name) do nothing;
-- Physical inventory is intentionally not seeded. Configure real rooms through the admin workflow.
insert into public.business_settings(id) values(true) on conflict (id) do nothing;
-- Legacy stays are intentionally not fabricated. The insert trigger and check-in RPC create rows for new/active workflows.

-- Preflight every unique index against legacy rows. Never deduplicate payment or guest data automatically.
do $migration$
declare spec record; duplicate_values text;
begin
  for spec in select * from (values
    ('bookings','booking_id','booking_id is not null'),
    ('bookings','idempotency_key','idempotency_key is not null'),
    ('bookings','razorpay_payment_id','razorpay_payment_id is not null'),
    ('payment_orders','idempotency_key','idempotency_key is not null'),
    ('payment_orders','razorpay_order_id','razorpay_order_id is not null'),
    ('payment_orders','razorpay_payment_id','razorpay_payment_id is not null'),
    ('invoices','booking_id','booking_id is not null'),
    ('invoices','invoice_number','invoice_number is not null')
  ) v(table_name,column_name,predicate)
  loop
    execute format('select string_agg(quote_nullable(value), '', '' order by value) from (select %1$I::text value from public.%2$I where %3$s group by %1$I having count(*) > 1 limit 20) duplicates',spec.column_name,spec.table_name,spec.predicate) into duplicate_values;
    if duplicate_values is not null then
      raise exception 'DUPLICATE_DATA: %.% contains duplicate values: %. Resolve these records manually; 005 did not delete or rewrite them.',spec.table_name,spec.column_name,duplicate_values;
    end if;
  end loop;
  select string_agg(booking_id::text, ', ' order by booking_id::text) into duplicate_values
  from (select booking_id from public.booking_room_assignments where assignment_status='active' group by booking_id having count(*)>1 limit 20) d;
  if duplicate_values is not null then raise exception 'DUPLICATE_DATA: booking_room_assignments has multiple active rows for booking_id values: %. Resolve manually; 005 changed no rows.',duplicate_values; end if;
end $migration$;

create unique index if not exists bookings_booking_id_uidx on public.bookings(booking_id);
create unique index if not exists bookings_idempotency_uidx on public.bookings(idempotency_key);
create unique index if not exists bookings_payment_uidx on public.bookings(razorpay_payment_id) where razorpay_payment_id is not null;
create index if not exists bookings_availability_idx on public.bookings(room_type,check_in,check_out) where booking_status in ('Pending','Confirmed');
create index if not exists bookings_admin_listing_idx on public.bookings(booking_status,room_type,check_in,created_at desc);
create index if not exists bookings_check_out_idx on public.bookings(check_out,booking_status);
create index if not exists bookings_reporting_idx on public.bookings(created_at,booking_status,payment_status);
create index if not exists bookings_occupancy_idx on public.bookings(check_in,check_out,booking_status);
create index if not exists rooms_room_type_idx on public.rooms(room_type_id);
create index if not exists rooms_status_idx on public.rooms(operational_status,housekeeping_status,is_active);
create index if not exists rooms_floor_idx on public.rooms(floor,room_number);
create unique index if not exists booking_room_assignments_one_active_idx on public.booking_room_assignments(booking_id) where assignment_status='active';
create index if not exists booking_room_assignments_booking_history_idx on public.booking_room_assignments(booking_id,assigned_at desc);
create index if not exists booking_room_assignments_room_idx on public.booking_room_assignments(room_id);
create index if not exists booking_room_assignments_active_room_idx on public.booking_room_assignments(room_id,booking_id) where assignment_status='active';
create index if not exists housekeeping_tasks_booking_idx on public.housekeeping_tasks(booking_id,created_at desc);
create index if not exists housekeeping_tasks_room_status_idx on public.housekeeping_tasks(room_id,status);
create index if not exists housekeeping_tasks_status_created_idx on public.housekeeping_tasks(status,created_at desc);
create index if not exists invoices_issued_at_idx on public.invoices(issued_at desc);
create index if not exists audit_logs_created_at_idx on public.audit_logs(created_at desc);
create index if not exists audit_logs_action_entity_idx on public.audit_logs(action,entity,created_at desc);
create index if not exists payment_orders_status_created_idx on public.payment_orders(status,created_at desc);
create unique index if not exists payment_orders_payment_id_uidx on public.payment_orders(razorpay_payment_id) where razorpay_payment_id is not null;
create index if not exists reviews_public_idx on public.reviews(status,created_at desc);
create index if not exists reviews_moderation_idx on public.reviews(status,created_at desc);

do $migration$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid='public.booking_room_assignments'::regclass
      and conname='booking_room_assignments_no_active_room_overlap'
  ) then
    alter table public.booking_room_assignments
      add constraint booking_room_assignments_no_active_room_overlap
      exclude using gist (room_id with =,allocation_range with &&)
      where (assignment_status='active');
  end if;
end $migration$;

-- Functions and triggers are installed only when absent; production definitions
-- are never replaced.  These small trigger functions are prerequisites for the
-- guarded triggers below.
do $migration$
begin
  if to_regprocedure('public.set_updated_at()') is null then
    execute $definition$create function public.set_updated_at() returns trigger language plpgsql as $fn$
      begin new.updated_at=now(); return new; end $fn$$definition$;
  end if;
  if to_regprocedure('public.set_booking_room_allocation_range()') is null then
    execute $definition$create function public.set_booking_room_allocation_range() returns trigger language plpgsql security definer set search_path=public as $fn$
      declare arrival date; departure date; begin
        select check_in,check_out into arrival,departure from bookings where id=new.booking_id;
        if arrival is null or departure is null or arrival>=departure then raise exception using errcode='22000',message='booking must have a finite, non-empty stay'; end if;
        new.allocation_range=daterange(arrival,departure,'[)'); return new;
      end $fn$$definition$;
  end if;
  if to_regprocedure('public.create_booking_stay()') is null then
    execute $definition$create function public.create_booking_stay() returns trigger language plpgsql security definer set search_path=public as $fn$
      begin insert into booking_stays(booking_id) values(new.id) on conflict (booking_id) do nothing; return new; end $fn$$definition$;
  end if;
end $migration$;

do $migration$
declare item text; relation regclass; function_name text; timing text; event text;
begin
  for item,relation,function_name,timing,event in
    select * from (values
      ('room_types_set_updated_at','public.room_types'::regclass,'public.set_updated_at()','before','update'),
      ('rooms_set_updated_at','public.rooms'::regclass,'public.set_updated_at()','before','update'),
      ('booking_room_assignments_set_allocation_range','public.booking_room_assignments'::regclass,'public.set_booking_room_allocation_range()','before','insert'),
      ('booking_room_assignments_set_updated_at','public.booking_room_assignments'::regclass,'public.set_updated_at()','before','update'),
      ('bookings_create_stay','public.bookings'::regclass,'public.create_booking_stay()','after','insert'),
      ('booking_stays_set_updated_at','public.booking_stays'::regclass,'public.set_updated_at()','before','update'),
      ('housekeeping_tasks_set_updated_at','public.housekeeping_tasks'::regclass,'public.set_updated_at()','before','update'),
      ('business_settings_set_updated_at','public.business_settings'::regclass,'public.set_updated_at()','before','update')
    ) definitions
  loop
    if not exists(select 1 from pg_trigger where tgrelid=relation and tgname=item and not tgisinternal) then
      execute format('create trigger %I %s %s on %s for each row execute function %s',item,timing,event,relation,function_name);
    end if;
  end loop;
end $migration$;

-- Atomic API functions are copied from the canonical schema, but guarded.  A
-- subsequent migration should be used for any intentional behavior change.
do $migration$
begin
  if to_regprocedure('public.create_booking_atomic(jsonb,integer)') is null then
    execute $definition$create function public.create_booking_atomic(booking_data jsonb,room_inventory integer) returns setof public.bookings language plpgsql security definer set search_path=public as $fn$
    declare occupied integer; existing public.bookings; created public.bookings; begin
      perform pg_advisory_xact_lock(hashtext(booking_data->>'room_type'));
      select * into existing from bookings where idempotency_key=booking_data->>'idempotency_key'; if found then return next existing; return; end if;
      select count(*) into occupied from bookings where room_type=booking_data->>'room_type' and booking_status in ('Pending','Confirmed') and check_in<(booking_data->>'check_out')::date and check_out>(booking_data->>'check_in')::date;
      if occupied>=room_inventory then return; end if;
      insert into bookings(booking_id,idempotency_key,customer_name,phone,email,room_type,check_in,check_out,adults,children,payment_type,payment_status,razorpay_order_id,razorpay_payment_id,amount,advance_amount,booking_status,special_request,nights,paid_nights,complimentary_nights)
      values(booking_data->>'booking_id',booking_data->>'idempotency_key',booking_data->>'customer_name',booking_data->>'phone',booking_data->>'email',booking_data->>'room_type',(booking_data->>'check_in')::date,(booking_data->>'check_out')::date,(booking_data->>'adults')::int,(booking_data->>'children')::int,booking_data->>'payment_type',booking_data->>'payment_status',booking_data->>'razorpay_order_id',booking_data->>'razorpay_payment_id',(booking_data->>'amount')::numeric,(booking_data->>'advance_amount')::numeric,'Confirmed',booking_data->>'special_request',(booking_data->>'nights')::int,(booking_data->>'paid_nights')::int,(booking_data->>'complimentary_nights')::int) returning * into created;
      return next created;
    end $fn$$definition$;
  end if;
end $migration$;

-- Install the remaining canonical RPCs only when absent. Their definitions are
-- sourced verbatim from 001 to keep database behavior aligned with the backend.
do $migration$
begin
  if to_regprocedure('public.assign_booking_room(uuid,uuid,text)') is null then
    execute $definition$create function public.assign_booking_room(target_booking_id uuid,target_room_id uuid,actor text) returns jsonb language plpgsql security definer set search_path=public as $fn$
    declare b public.bookings; r record; a public.booking_room_assignments; begin perform pg_advisory_xact_lock(hashtext(target_booking_id::text)); select * into b from bookings where id=target_booking_id; if not found then return jsonb_build_object('success',false,'reason','booking_not_found'); end if; select rooms.*,room_types.name type_name into r from rooms join room_types on room_types.id=rooms.room_type_id where rooms.id=target_room_id; if not found then return jsonb_build_object('success',false,'reason','room_not_found'); end if; if b.booking_status not in ('Pending','Confirmed') then return jsonb_build_object('success',false,'reason','booking_status'); end if; if not r.is_active then return jsonb_build_object('success',false,'reason','room_inactive'); end if; if r.operational_status<>'operational' then return jsonb_build_object('success',false,'reason','room_not_operational'); end if; if r.type_name<>b.room_type then return jsonb_build_object('success',false,'reason','room_type_mismatch'); end if; if exists(select 1 from booking_room_assignments where booking_id=target_booking_id and assignment_status='active') then return jsonb_build_object('success',false,'reason','already_assigned'); end if; begin insert into booking_room_assignments(booking_id,room_id,assigned_by) values(target_booking_id,target_room_id,actor) returning * into a; exception when exclusion_violation then return jsonb_build_object('success',false,'reason','room_assignment_conflict'); end; return jsonb_build_object('success',true,'assigned_at',a.assigned_at,'room',jsonb_build_object('id',r.id,'room_number',r.room_number,'room_type',r.type_name)); end $fn$$definition$;
  end if;
  if to_regprocedure('public.release_booking_room(uuid,text,text)') is null then
    execute $definition$create function public.release_booking_room(target_booking_id uuid,actor text,reason text default null) returns jsonb language plpgsql security definer set search_path=public as $fn$
    declare assignment_id uuid; begin perform pg_advisory_xact_lock(hashtext(target_booking_id::text)); if not exists(select 1 from bookings where id=target_booking_id) then return jsonb_build_object('success',false,'reason','booking_not_found'); end if; select id into assignment_id from booking_room_assignments where booking_id=target_booking_id and assignment_status='active' for update; if not found then return jsonb_build_object('success',false,'reason','not_assigned'); end if; update booking_room_assignments set assignment_status='released',released_at=now(),released_by=actor,release_reason=reason where id=assignment_id; return jsonb_build_object('success',true); end $fn$$definition$;
  end if;
end $migration$;

-- Check-in/out, housekeeping, and invoicing definitions are present in 001 and
-- are required by RPC calls. Including 001's definitions here would replace
-- production routines, so guarded creation is delegated to a compact helper.
do $migration$
begin
  if to_regprocedure('public.check_in_booking(uuid)') is null then
    execute $definition$create function public.check_in_booking(target_booking_id uuid) returns jsonb language plpgsql security definer set search_path=public as $fn$
    declare b public.bookings; s public.booking_stays; a public.booking_room_assignments; r public.rooms; active_count integer; checked_in timestamptz; begin perform pg_advisory_xact_lock(hashtext(target_booking_id::text)); select * into b from bookings where id=target_booking_id for update; if not found then return jsonb_build_object('success',false,'reason','booking_not_found'); end if; if b.booking_status<>'Confirmed' then return jsonb_build_object('success',false,'reason','booking_not_confirmed'); end if; insert into booking_stays(booking_id) values(target_booking_id) on conflict do nothing; select * into s from booking_stays where booking_id=target_booking_id for update; if s.stay_status='checked_in' then return jsonb_build_object('success',false,'reason','already_checked_in'); end if; select count(*) into active_count from booking_room_assignments where booking_id=target_booking_id and assignment_status='active'; if active_count=0 then return jsonb_build_object('success',false,'reason','no_room_assigned'); end if; if active_count<>1 then return jsonb_build_object('success',false,'reason','multiple_rooms_assigned'); end if; select * into a from booking_room_assignments where booking_id=target_booking_id and assignment_status='active'; select * into r from rooms where id=a.room_id for update; if not r.is_active or r.operational_status<>'operational' or r.housekeeping_status not in ('clean','inspected') then return jsonb_build_object('success',false,'reason','room_not_ready'); end if; checked_in=now(); update booking_stays set stay_status='checked_in',checked_in_at=checked_in,checked_out_at=null,no_show_at=null where booking_id=target_booking_id; return jsonb_build_object('success',true,'booking_id',b.booking_id,'booking_status',b.booking_status,'stay_status','checked_in','checked_in_at',checked_in,'room_number',r.room_number); end $fn$$definition$;
  end if;
  if to_regprocedure('public.check_out_booking(uuid)') is null then
    execute $definition$create function public.check_out_booking(target_booking_id uuid) returns jsonb language plpgsql security definer set search_path=public as $fn$
    declare b public.bookings; s public.booking_stays; a public.booking_room_assignments; r public.rooms; task public.housekeeping_tasks; active_count integer; checkout_time timestamptz; begin perform pg_advisory_xact_lock(hashtext(target_booking_id::text)); select * into b from bookings where id=target_booking_id for update; if not found then return jsonb_build_object('success',false,'reason','booking_not_found'); end if; select * into s from booking_stays where booking_id=target_booking_id for update; if s.stay_status='checked_out' then return jsonb_build_object('success',false,'reason','already_checked_out'); end if; if b.booking_status<>'Confirmed' or s.stay_status is distinct from 'checked_in' then return jsonb_build_object('success',false,'reason','not_checked_in'); end if; select count(*) into active_count from booking_room_assignments where booking_id=target_booking_id and assignment_status='active'; if active_count<>1 then return jsonb_build_object('success',false,'reason','no_room_assigned'); end if; select * into a from booking_room_assignments where booking_id=target_booking_id and assignment_status='active' for update; select * into r from rooms where id=a.room_id for update; checkout_time=now(); update booking_stays set stay_status='checked_out',checked_out_at=checkout_time where booking_id=target_booking_id; update bookings set booking_status='Completed',updated_at=checkout_time where id=target_booking_id; update booking_room_assignments set assignment_status='released',released_at=checkout_time,released_by='admin',release_reason='Guest checked out' where id=a.id; update rooms set housekeeping_status='dirty' where id=r.id; insert into housekeeping_tasks(booking_id,room_id,task_type,status) values(target_booking_id,r.id,'turnover','pending') returning * into task; return jsonb_build_object('success',true,'booking_status','Completed','stay_status','checked_out','checked_out_at',checkout_time,'room_number',r.room_number,'housekeeping_status','dirty','task_type',task.task_type,'task_status',task.status); end $fn$$definition$;
  end if;
end $migration$;

do $migration$
begin
  if to_regprocedure('public.transition_housekeeping_task(uuid,text)') is null then
    execute $definition$create function public.transition_housekeeping_task(target_task_id uuid,target_action text) returns jsonb language plpgsql security definer set search_path=public as $fn$
    declare task public.housekeeping_tasks; r public.rooms; expected_status text; next_status text; transition_time timestamptz; begin perform pg_advisory_xact_lock(hashtext(target_task_id::text)); select * into task from housekeeping_tasks where id=target_task_id for update; if not found then return jsonb_build_object('success',false,'reason','task_not_found'); end if; select * into r from rooms where id=task.room_id for update; expected_status=case target_action when 'start' then 'pending' when 'complete' then 'cleaning' when 'inspect' then 'completed' end; next_status=case target_action when 'start' then 'cleaning' when 'complete' then 'completed' when 'inspect' then 'inspected' end; if expected_status is null or task.status<>expected_status then return jsonb_build_object('success',false,'reason','invalid_transition'); end if; transition_time=now(); update housekeeping_tasks set status=next_status,completed_at=case when target_action='complete' then transition_time else completed_at end where id=task.id returning * into task; if target_action in ('complete','inspect') then update rooms set housekeeping_status=next_status where id=r.id returning * into r; end if; return jsonb_build_object('success',true,'task',to_jsonb(task),'room',to_jsonb(r)); end $fn$$definition$;
  end if;
  if to_regprocedure('public.generate_booking_invoice(uuid,text)') is null then
    execute $definition$create function public.generate_booking_invoice(target_booking_id uuid,invoice_prefix text default 'KGH') returns jsonb language plpgsql security definer set search_path=public as $fn$
    declare b public.bookings; s public.business_settings; i public.invoices; seq bigint; taxable numeric; tax numeric; begin perform pg_advisory_xact_lock(hashtext(target_booking_id::text)); select * into i from invoices where booking_id=target_booking_id; if found then return to_jsonb(i); end if; select * into b from bookings where id=target_booking_id; if not found or b.booking_status<>'Completed' then return null; end if; select * into s from business_settings where id=true; seq=nextval('invoice_number_seq'); taxable=coalesce(b.amount,0); tax=round(taxable*s.gst_percent/100,2); insert into invoices(booking_id,invoice_number,gst_amount,grand_total,currency,business_details) values(b.id,upper(coalesce(nullif(invoice_prefix,''),s.invoice_prefix))||'-'||extract(year from now())::int||'-'||lpad(seq::text,6,'0'),tax,taxable+tax,s.currency,jsonb_build_object('business_name',s.business_name,'gst_number',s.gst_number,'gst_percent',s.gst_percent,'address',s.address,'phone',s.phone,'email',s.email,'invoice_footer',s.invoice_footer,'currency',s.currency,'timezone',s.timezone)) returning * into i; return to_jsonb(i); end $fn$$definition$;
  end if;
end $migration$;

-- A same-signature legacy routine is not automatically trusted. Verify the security/return contract
-- expected by PostgREST; abort rather than replacing an unknown production routine.
do $migration$
declare f record; p regprocedure;
begin
  for f in select * from (values
    ('create_booking_atomic(jsonb,integer)','SETOF bookings'),
    ('assign_booking_room(uuid,uuid,text)','jsonb'),('release_booking_room(uuid,text,text)','jsonb'),
    ('check_in_booking(uuid)','jsonb'),('check_out_booking(uuid)','jsonb'),
    ('transition_housekeeping_task(uuid,text)','jsonb'),('generate_booking_invoice(uuid,text)','jsonb')
  ) v(signature,expected_result)
  loop
    p=to_regprocedure('public.'||f.signature);
    if p is null then raise exception 'SCHEMA_INCOMPATIBLE: missing RPC public.%',f.signature; end if;
    if not (select prosecdef and coalesce(proconfig,'{}') @> array['search_path=public'] from pg_proc where oid=p) then
      raise exception 'SCHEMA_INCOMPATIBLE: RPC public.% must be SECURITY DEFINER with fixed search_path=public; it was not replaced.',f.signature;
    end if;
    if pg_get_function_result(p) <> f.expected_result then
      raise exception 'SCHEMA_INCOMPATIBLE: RPC public.% expected return %, found %. It was not replaced.',f.signature,f.expected_result,pg_get_function_result(p);
    end if;
  end loop;
end $migration$;

-- No browser-facing policies are needed: all database access is through the
-- Render backend's service role. Reassert least privilege for all 11 resources.
do $migration$
declare table_name text; privileges text;
begin
  foreach table_name in array array['bookings','payment_orders','reviews','room_types','rooms','booking_room_assignments','booking_stays','housekeeping_tasks','business_settings','invoices','audit_logs'] loop
    execute format('alter table public.%I enable row level security',table_name);
    execute format('revoke all on table public.%I from public,anon,authenticated',table_name);
    privileges=case table_name when 'business_settings' then 'select,update' when 'invoices' then 'select,insert' when 'audit_logs' then 'select,insert' else 'select,insert,update,delete' end;
    execute format('grant %s on table public.%I to service_role',privileges,table_name);
  end loop;
end $migration$;
revoke all on function public.set_updated_at(),public.set_booking_room_allocation_range(),public.create_booking_stay() from public,anon,authenticated;
revoke all on function public.create_booking_atomic(jsonb,integer),public.assign_booking_room(uuid,uuid,text),public.release_booking_room(uuid,text,text),public.check_in_booking(uuid),public.check_out_booking(uuid),public.transition_housekeeping_task(uuid,text),public.generate_booking_invoice(uuid,text) from public,anon,authenticated;
grant execute on function public.create_booking_atomic(jsonb,integer),public.assign_booking_room(uuid,uuid,text),public.release_booking_room(uuid,text,text),public.check_in_booking(uuid),public.check_out_booking(uuid),public.transition_housekeeping_task(uuid,text),public.generate_booking_invoice(uuid,text) to service_role;
grant usage,select on sequence public.invoice_number_seq to service_role;
