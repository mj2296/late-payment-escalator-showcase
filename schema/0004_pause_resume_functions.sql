-- supabase/migrations/0004_pause_resume_functions.sql

create or replace function pause_invoice(p_invoice_id uuid)
returns void
language plpgsql
as $$
declare
  v_status invoice_status;
begin
  select status into v_status from invoices where id = p_invoice_id;

  if v_status is null then
    raise exception 'Invoice not found';
  end if;

  if v_status not in ('overdue', 'escalating') then
    raise exception 'Invoice cannot be paused from status %', v_status;
  end if;

  insert into escalation_pauses (invoice_id, paused_at, source)
  values (p_invoice_id, now(), 'manual');

  update invoices set status = 'paused', updated_at = now() where id = p_invoice_id;
end;
$$;

create or replace function resume_invoice(p_invoice_id uuid)
returns void
language plpgsql
as $$
declare
  v_pause_id uuid;
  v_paused_at timestamptz;
  v_duration bigint;
  v_new_status text;
begin
  select id, paused_at into v_pause_id, v_paused_at
  from escalation_pauses
  where invoice_id = p_invoice_id and resumed_at is null
  order by paused_at desc
  limit 1;

  if v_pause_id is null then
    raise exception 'Invoice is not currently paused';
  end if;

  v_duration := extract(epoch from (now() - v_paused_at))::bigint;

  update escalation_pauses
  set resumed_at = now(), duration_seconds = v_duration
  where id = v_pause_id;

  select case
    when exists (
      select 1 from escalation_stages
      where invoice_id = p_invoice_id and send_state = 'sent'
    ) then 'escalating'
    else 'overdue'
  end into v_new_status;

  update invoices
  set status = v_new_status::invoice_status,
      cumulative_pause_seconds = cumulative_pause_seconds + v_duration,
      updated_at = now()
  where id = p_invoice_id;
end;
$$;
