-- supabase/migrations/0001_initial_schema.sql

-- Base table-level grants for anon/authenticated. Row Level Security below is
-- the actual per-row gate; these grants just let PostgREST reach that gate.
-- On a hosted Supabase project this is preconfigured platform-wide, but the
-- local CLI's postgres role does not inherit it by default, so it must be
-- explicit here for the local stack (and any future clean environment).
grant usage on schema public to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;

create table profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  business_name text not null,
  physical_address text not null,
  contact_email text not null,
  trial_time_started_at timestamptz,
  trial_time_expired_at timestamptz,
  trial_escalation_count integer not null default 0,
  created_at timestamptz not null default now()
);

alter table profiles enable row level security;

create policy "profiles are owner-only"
  on profiles for all
  using (auth.uid() = id)
  with check (auth.uid() = id);

create table clients (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  email text not null,
  physical_address text not null,
  notes text,
  created_at timestamptz not null default now()
);

alter table clients enable row level security;

create policy "clients are owner-only"
  on clients for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create type invoice_status as enum (
  'pending', 'overdue', 'escalating', 'paused', 'paid'
);

create table invoices (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  client_id uuid not null references clients(id) on delete cascade,
  invoice_number text not null,
  amount_cents bigint not null check (amount_cents > 0),
  currency text not null default 'USD',
  due_date date not null,
  description text,
  original_invoice_pdf_path text,
  status invoice_status not null default 'pending',
  paid_at timestamptz,
  current_schedule_version integer not null default 1,
  cumulative_pause_seconds bigint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table invoices enable row level security;

create policy "invoices are owner-only"
  on invoices for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create index invoices_user_id_idx on invoices(user_id);
create index invoices_client_id_idx on invoices(client_id);
create index clients_user_id_idx on clients(user_id);
