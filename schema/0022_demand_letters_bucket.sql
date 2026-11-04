-- supabase/migrations/0022_demand_letters_bucket.sql

insert into storage.buckets (id, name, public)
values ('demand-letters', 'demand-letters', false);

-- Milestone 5 design doc Decision 3: the standard Supabase per-user-folder
-- Storage RLS shape, so the Flutter app can call createSignedUrl directly
-- with the signed-in user's own session -- no bespoke authenticated Edge
-- Function needed just to hand out a download link.
create policy "owners can read their own demand letters"
  on storage.objects for select
  to authenticated
  using (
    bucket_id = 'demand-letters'
    and (storage.foldername(name))[1] = auth.uid()::text
  );
-- No insert/update/delete policy for authenticated on this bucket -- uploads
-- are service-role-only (generateDemandLetter's Storage client bypasses RLS
-- entirely, same as every other service-role write path in this codebase).
