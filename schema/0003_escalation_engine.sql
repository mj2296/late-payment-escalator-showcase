-- supabase/migrations/0003_escalation_engine.sql

create table escalation_stages (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references invoices(id) on delete cascade,
  stage_number integer not null check (stage_number between 1 and 4),
  sent_at timestamptz,
  send_state text not null default 'pending' check (send_state in ('pending', 'sent', 'failed')),
  created_at timestamptz not null default now(),
  unique (invoice_id, stage_number)
);

alter table escalation_stages enable row level security;

create policy "escalation_stages are owner-only"
  on escalation_stages for all
  using (exists (
    select 1 from invoices
    where invoices.id = escalation_stages.invoice_id
      and invoices.user_id = auth.uid()
  ))
  with check (exists (
    select 1 from invoices
    where invoices.id = escalation_stages.invoice_id
      and invoices.user_id = auth.uid()
  ));

create index escalation_stages_invoice_id_idx on escalation_stages(invoice_id);

create table escalation_pauses (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references invoices(id) on delete cascade,
  paused_at timestamptz not null default now(),
  resumed_at timestamptz,
  duration_seconds bigint,
  source text not null default 'manual' check (source in ('manual')),
  created_at timestamptz not null default now()
);

alter table escalation_pauses enable row level security;

create policy "escalation_pauses are owner-only"
  on escalation_pauses for all
  using (exists (
    select 1 from invoices
    where invoices.id = escalation_pauses.invoice_id
      and invoices.user_id = auth.uid()
  ))
  with check (exists (
    select 1 from invoices
    where invoices.id = escalation_pauses.invoice_id
      and invoices.user_id = auth.uid()
  ));

create index escalation_pauses_invoice_id_idx on escalation_pauses(invoice_id);
