-- supabase/migrations/0014_stop_requests.sql

create table stop_requests (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  originating_invoice_id uuid not null references invoices(id) on delete cascade,
  originating_stage_id uuid references escalation_stages(id) on delete set null,
  requested_at timestamptz not null default now(),
  handled_at timestamptz
);

alter table stop_requests enable row level security;

create policy "stop_requests are owner-readable"
  on stop_requests for select
  using (auth.uid() = user_id);
-- No insert/update/delete for authenticated — service_role only. invoice-view creates
-- rows on a validated stop-request POST; run-stop-request-backstop sets handled_at.

create index stop_requests_user_id_idx on stop_requests(user_id);
create index stop_requests_client_id_idx on stop_requests(client_id);
-- Looked up by run-stop-request-backstop to find unresolved requests past 5 days.
create index stop_requests_unresolved_idx on stop_requests(requested_at) where handled_at is null;

create table stop_request_invoices (
  id uuid primary key default gen_random_uuid(),
  stop_request_id uuid not null references stop_requests(id) on delete cascade,
  invoice_id uuid not null references invoices(id) on delete cascade,
  unique (stop_request_id, invoice_id)
);

alter table stop_request_invoices enable row level security;

create policy "stop_request_invoices are owner-readable"
  on stop_request_invoices for select
  using (exists (
    select 1 from stop_requests
    where stop_requests.id = stop_request_invoices.stop_request_id
      and stop_requests.user_id = auth.uid()
  ));
-- No insert/update/delete for authenticated — service_role only.

create index stop_request_invoices_invoice_id_idx on stop_request_invoices(invoice_id);
