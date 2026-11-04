-- supabase/migrations/0007_lock_trial_columns.sql

-- 0001_initial_schema.sql's `alter default privileges ... grant all on tables`
-- gives anon/authenticated blanket column-level UPDATE/INSERT/DELETE on
-- `profiles`, and the owner-only RLS policy only gates which *rows* a client
-- can touch, not which *columns*. That means any signed-in user could call
-- PostgREST directly and rewrite their own trial_time_started_at,
-- trial_time_expired_at, and trial_escalation_count to reset their trial
-- indefinitely, bypassing the Stage-1 eligibility gate entirely. Lock the
-- client down to the columns the app's own profile flows actually use.
--
-- Verified against lib/repositories/auth_repository.dart (sign-up insert:
-- id, business_name, physical_address, contact_email) and
-- lib/repositories/profile_repository.dart (read-only select of the trial
-- columns; no client-side update path to `profiles` exists anywhere in
-- lib/). The trial columns are never written by the client — they're set
-- only by the table's own defaults (INSERT) and by record_stage1_trial_usage
-- (UPDATE), which runs as service_role inside the run-escalations Edge
-- Function.

revoke update, delete on profiles from anon, authenticated;
grant update (business_name, physical_address, contact_email) on profiles to authenticated;

revoke insert on profiles from anon, authenticated;
grant insert (id, business_name, physical_address, contact_email) on profiles to authenticated;

-- record_stage1_trial_usage must only be callable by service_role (the
-- run-escalations Edge Function). Note: unlike RLS (which service_role
-- bypasses via its BYPASSRLS attribute), function EXECUTE privilege is a
-- normal grant, and Postgres grants EXECUTE on new functions to PUBLIC by
-- default -- service_role's access up to now came from that PUBLIC grant,
-- not from any special exemption. So revoking from `public` removes it for
-- service_role too, and it must be explicitly re-granted below.
-- has_escalation_eligibility stays callable by authenticated: it's
-- read-only, SECURITY INVOKER, and a later milestone's Billing screen may
-- want to call it directly.
revoke execute on function record_stage1_trial_usage(uuid) from public, anon, authenticated;
grant execute on function record_stage1_trial_usage(uuid) to service_role;
