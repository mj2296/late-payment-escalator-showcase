-- supabase/migrations/0027_invoice_pdfs_bucket.sql

-- The original-invoice-PDF-upload feature flagged as a pre-existing gap in the
-- Milestone 4 design doc (§"Explicitly out of scope") and again in the 2026-09-16
-- self-evaluation/manual-test-spec: invoices.original_invoice_pdf_path has existed
-- since Milestone 1, and invoice-view/index.ts has always been written to serve a
-- signed download link from an 'invoice-pdfs' bucket whenever that column is
-- non-null, but no bucket or upload UI ever existed to make it non-null. This
-- migration creates that bucket.
insert into storage.buckets (id, name, public)
values ('invoice-pdfs', 'invoice-pdfs', false);

-- Unlike demand-letters (server-generated, service-role-only writes), the
-- freelancer uploads their own original invoice PDF directly from the app with
-- their own session -- so, unusually for this codebase's Storage buckets, this one
-- needs authenticated insert/update/delete policies, not just select. Same
-- per-user-folder shape as demand-letters' read policy: path is always
-- "{auth.uid()}/{invoice_id}.pdf" (enforced by the app, not by RLS, the same way
-- demand-letters' path shape is enforced by generateDemandLetter rather than a
-- constraint).
create policy "owners can read their own invoice pdfs"
  on storage.objects for select
  to authenticated
  using (
    bucket_id = 'invoice-pdfs'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "owners can upload their own invoice pdfs"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'invoice-pdfs'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- Needed for uploadBinary(..., upsert: true) to replace an already-attached PDF
-- in place (same storage path, new bytes) rather than requiring delete-then-insert.
create policy "owners can replace their own invoice pdfs"
  on storage.objects for update
  to authenticated
  using (
    bucket_id = 'invoice-pdfs'
    and (storage.foldername(name))[1] = auth.uid()::text
  )
  with check (
    bucket_id = 'invoice-pdfs'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "owners can delete their own invoice pdfs"
  on storage.objects for delete
  to authenticated
  using (
    bucket_id = 'invoice-pdfs'
    and (storage.foldername(name))[1] = auth.uid()::text
  );
