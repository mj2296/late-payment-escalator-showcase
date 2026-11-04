-- Milestone 5 design doc Decision 5: keyed by invoice_id as the primary key
-- (not a separate surrogate id) -- a demand letter is 1:1 with an invoice,
-- Stage 4 fires at most once per invoice, matching invoice_recipient_tokens'
-- precedent from Milestone 4.
create table demand_letters (
  invoice_id uuid primary key references invoices(id) on delete cascade,
  storage_path text,
  generated_at timestamptz,
  generation_status text not null default 'pending'
    check (generation_status in ('pending', 'generated', 'failed', 'blocked_missing_address')),
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table demand_letters enable row level security;

-- Policies: only service_role can write
-- No insert/update/delete policy for authenticated users — implicitly denied by RLS

create policy "demand_letters are owner-readable"
  on demand_letters for select
  using (exists (
    select 1 from invoices
    where invoices.id = demand_letters.invoice_id
      and invoices.user_id = auth.uid()
  ));

-- service_role can read all demand letters (no explicit policy needed; service_role bypasses RLS)
-- Authenticated users can read their own demand letters (per the select policy above) but
-- cannot insert, update, or delete -- generateDemandLetter does all writes via service_role.
-- @see Task 6 (generateDemandLetter), Task 9 (DemandLetterRepository.getForInvoice)

create index demand_letters_status_idx on demand_letters(generation_status);
