-- supabase/migrations/0025_email_templates.sql

-- Postgres CHECK constraints cannot contain subqueries (confirmed: attempting the
-- inline `not exists (select ... from regexp_matches(...))` form fails with
-- "ERROR: cannot use subquery in check constraint (SQLSTATE 0A000)"), so both
-- validation rules -- the 3 required merge fields present, and no unsupported
-- {{field}} tokens -- live in this small plpgsql function instead, called from the
-- table's CHECK constraint below. immutable + a pinned empty search_path match this
-- codebase's existing function conventions (see check_rate_limit,
-- record_stage1_trial_usage).
create or replace function email_template_merge_fields_valid(p_subject text, p_body text)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_combined text := p_subject || ' ' || p_body;
  v_token text;
begin
  if position('{{amount}}' in v_combined) = 0
    or position('{{invoice_number}}' in v_combined) = 0
    or position('{{due_date}}' in v_combined) = 0
  then
    return false;
  end if;

  -- Detection is intentionally broader than the allowlist: match ANY brace-wrapped
  -- run (not just \w+) so malformed tokens like `{{ business_name }}` (whitespace) or
  -- `{{amount.total}}` (punctuation) are still caught as "a token-shaped thing to
  -- check" rather than silently ignored. Decision: compare the RAW (untrimmed)
  -- captured content against the allowlist, not a trimmed version -- substitute() in
  -- templates.ts still only replaces exact literal `{{name}}` strings, so a
  -- whitespace/punctuation variant like `{{ business_name }}` would never actually get
  -- substituted even if we recognized it here. Rejecting it at save time (same as any
  -- other unsupported token) is simpler and more defensible than accepting it here and
  -- relying on hasUnsubstitutedField to catch it later at send time.
  for v_token in select (regexp_matches(v_combined, '\{\{([^{}]*)\}\}', 'g'))[1]
  loop
    if v_token not in ('amount', 'invoice_number', 'due_date', 'business_name', 'invoice_link') then
      return false;
    end if;
  end loop;

  return true;
end;
$$;

create table email_templates (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  stage_number integer not null check (stage_number between 1 and 4),
  subject text not null,
  body text not null,
  is_default boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, stage_number),
  check (email_template_merge_fields_valid(subject, body))
);

alter table email_templates enable row level security;

create policy "email_templates are owner-readable"
  on email_templates for select
  using (auth.uid() = user_id);

create policy "email_templates are owner-writable"
  on email_templates for insert
  with check (auth.uid() = user_id);

create policy "email_templates are owner-updatable"
  on email_templates for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "email_templates are owner-deletable"
  on email_templates for delete
  using (auth.uid() = user_id);

create index email_templates_user_id_idx on email_templates(user_id);
