-- supabase/migrations/0013_invoice_link_clicks.sql

create table invoice_link_clicks (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references invoices(id) on delete cascade,
  escalation_stage_id uuid references escalation_stages(id) on delete set null,
  clicked_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

alter table invoice_link_clicks enable row level security;

create policy "invoice_link_clicks are owner-readable"
  on invoice_link_clicks for select
  using (exists (
    select 1 from invoices
    where invoices.id = invoice_link_clicks.invoice_id
      and invoices.user_id = auth.uid()
  ));
-- No insert/update/delete policy for authenticated — only service_role (invoice-view) writes.

create index invoice_link_clicks_invoice_id_idx on invoice_link_clicks(invoice_id);
