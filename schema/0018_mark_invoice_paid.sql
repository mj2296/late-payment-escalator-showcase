-- supabase/migrations/0018_mark_invoice_paid.sql

create or replace function mark_invoice_paid(p_invoice_id uuid)
returns public.invoices
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_invoice public.invoices;
begin
  select * into v_invoice from public.invoices where id = p_invoice_id;

  if v_invoice.id is null then
    raise exception 'Invoice not found';
  end if;

  -- security definer bypasses RLS entirely, so this function must enforce ownership
  -- itself -- unlike pause_invoice/resume_invoice, which stay invoker-rights and lean on
  -- the caller's own RLS to restrict which invoice they can touch.
  if v_invoice.user_id <> auth.uid() then
    raise exception 'Not authorized to modify this invoice';
  end if;

  update public.invoices
  set status = 'paid', paid_at = now()
  where id = p_invoice_id
  returning * into v_invoice;

  -- Best-effort: not every invoice necessarily has a token row yet (Task 2's row is
  -- created lazily on a first successful stage send), so a missing row here is not an
  -- error -- design Decision 2's "a paid invoice's link should stop working immediately."
  update public.invoice_recipient_tokens
  set revoked_at = now()
  where invoice_id = p_invoice_id and revoked_at is null;

  return v_invoice;
end;
$$;

revoke execute on function mark_invoice_paid(uuid) from public, anon;
grant execute on function mark_invoice_paid(uuid) to authenticated;
