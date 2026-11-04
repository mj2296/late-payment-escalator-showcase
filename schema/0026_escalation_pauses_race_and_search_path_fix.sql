-- supabase/migrations/0026_escalation_pauses_race_and_search_path_fix.sql

-- Closes a TOCTOU race between pause_invoice (manual, called from the app) and the
-- stop-request backstop cron (run-stop-request-backstop/index.ts): both read the
-- invoice's status before either writes, so two near-simultaneous pauses could each
-- pass their own "is this invoice still overdue/escalating" check and insert their own
-- open escalation_pauses row. resume_invoice only ever closes the single most recent
-- open row, so a second leftover open row permanently leaks time out of
-- cumulative_pause_seconds and makes the next escalation stage fire earlier than it
-- should. Same fix shape as 0016_stop_requests_unresolved_unique_index.sql.
create unique index escalation_pauses_open_unique_idx
  on escalation_pauses (invoice_id)
  where resumed_at is null;

-- pause_invoice updated to tolerate the race the index above now guards against, rather
-- than surfacing a confusing "Invoice cannot be paused from status paused" error (or,
-- pre-index, silently creating a second open pause row) when it loses a race to a
-- concurrent pause_invoice call or the backstop cron. Also pins search_path, closing an
-- AGENTS.md-convention gap this function had alongside resume_invoice and
-- mark_overdue_invoices (fixed below) -- lower real-world risk since this function is
-- invoker-rights (not security definer) and RLS-backstopped, but a real deviation from
-- every other function in this codebase.
create or replace function pause_invoice(p_invoice_id uuid)
returns void
language plpgsql
set search_path = ''
as $$
declare
  v_status public.invoice_status;
begin
  select status into v_status from public.invoices where id = p_invoice_id;

  if v_status is null then
    raise exception 'Invoice not found';
  end if;

  -- A concurrent pause (another pause_invoice call, or the stop-request backstop cron)
  -- already landed between some other caller's status read and this one -- the invoice
  -- is paused either way, so this is a benign no-op rather than an error.
  if v_status = 'paused' then
    return;
  end if;

  if v_status not in ('overdue', 'escalating') then
    raise exception 'Invoice cannot be paused from status %', v_status;
  end if;

  begin
    insert into public.escalation_pauses (invoice_id, paused_at, source)
    values (p_invoice_id, now(), 'manual');
  exception when unique_violation then
    -- The narrower version of the same race: both callers' status reads above ran
    -- before either write, so both got past the checks and both attempt this insert.
    -- The loser's insert hits escalation_pauses_open_unique_idx instead of creating a
    -- second open pause row -- tolerate it the same way run-escalations'
    -- getOrCreateInvoiceLink tolerates a concurrent invoice_recipient_tokens insert.
    return;
  end;

  update public.invoices set status = 'paused', updated_at = now() where id = p_invoice_id;
end;
$$;

-- resume_invoice and mark_overdue_invoices were the other 2 of 12 functions across the
-- migrations so far that didn't pin search_path -- same fix, no behavior change.
create or replace function resume_invoice(p_invoice_id uuid)
returns void
language plpgsql
set search_path = ''
as $$
declare
  v_pause_id uuid;
  v_paused_at timestamptz;
  v_duration bigint;
  v_new_status text;
begin
  select id, paused_at into v_pause_id, v_paused_at
  from public.escalation_pauses
  where invoice_id = p_invoice_id and resumed_at is null
  order by paused_at desc
  limit 1;

  if v_pause_id is null then
    raise exception 'Invoice is not currently paused';
  end if;

  v_duration := extract(epoch from (now() - v_paused_at))::bigint;

  update public.escalation_pauses
  set resumed_at = now(), duration_seconds = v_duration
  where id = v_pause_id;

  select case
    when exists (
      select 1 from public.escalation_stages
      where invoice_id = p_invoice_id and send_state = 'sent'
    ) then 'escalating'
    else 'overdue'
  end into v_new_status;

  update public.invoices
  set status = v_new_status::public.invoice_status,
      cumulative_pause_seconds = cumulative_pause_seconds + v_duration,
      updated_at = now()
  where id = p_invoice_id;
end;
$$;

create or replace function mark_overdue_invoices()
returns void
language sql
set search_path = ''
as $$
  update public.invoices
  set status = 'overdue', updated_at = now()
  where status = 'pending'
    and due_date < current_date;
$$;
