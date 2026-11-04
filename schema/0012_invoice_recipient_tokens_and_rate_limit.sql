-- supabase/migrations/0012_invoice_recipient_tokens_and_rate_limit.sql

-- Stores only per-invoice link *policy* state — the token itself is never stored,
-- only recomputed from invoiceId + INVOICE_TOKEN_SECRET (see recipient_token.ts and
-- the design doc's Decision 2 for why: a hash-at-rest token can't be reused across
-- multiple sends days apart, since a hash can't be reversed back into the raw value).
create table invoice_recipient_tokens (
  invoice_id uuid primary key references invoices(id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz
);

alter table invoice_recipient_tokens enable row level security;
-- Intentionally no policy at all for anon/authenticated (default-deny), matching
-- `subscriptions`' pattern from Milestone 3b — only service_role bypasses RLS.
-- RLS alone isn't enough to make a bare `select` error out for these roles: with
-- zero policies, Postgres just filters SELECT down to zero rows (no error) while
-- still throwing on INSERT (WITH CHECK defaults to false). 0001_initial_schema.sql's
-- `alter default privileges ... grant all on tables` already gave anon/authenticated
-- table-level access to this new table, so revoke it explicitly — same as
-- `rate_limit_hits` below — so every direct access attempt errors, not just writes.
revoke all on invoice_recipient_tokens from anon, authenticated;

create table rate_limit_hits (
  bucket text not null,
  window_start timestamptz not null,
  count integer not null default 1,
  primary key (bucket, window_start)
);
-- Never reached through PostgREST directly — only check_rate_limit() (security definer)
-- touches it, itself restricted to service_role below.
revoke all on rate_limit_hits from anon, authenticated;

create or replace function check_rate_limit(p_bucket text, p_max integer, p_window_seconds integer)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_window_start timestamptz;
  v_count integer;
begin
  v_window_start := to_timestamp(floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds);
  insert into public.rate_limit_hits (bucket, window_start, count)
  values (p_bucket, v_window_start, 1)
  on conflict (bucket, window_start) do update set count = public.rate_limit_hits.count + 1
  returning count into v_count;
  return v_count <= p_max;
end;
$$;

revoke execute on function check_rate_limit(text, integer, integer) from public, anon, authenticated;
grant execute on function check_rate_limit(text, integer, integer) to service_role;
