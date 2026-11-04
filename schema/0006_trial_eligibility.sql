-- supabase/migrations/0006_trial_eligibility.sql

-- Mirrored (UI-only approximation) by `isEligible` in
-- lib/models/trial_status.dart. This function is the source of truth (the
-- server-side gate actually enforced in run-escalations) -- the Dart copy is
-- not kept in sync automatically and must be updated by hand if this
-- function's logic changes.
create or replace function has_escalation_eligibility(p_user_id uuid)
returns boolean
language sql
stable
set search_path = ''
as $$
  select coalesce(
    (
      select
        trial_escalation_count < 2
        and (trial_time_started_at is null or now() < trial_time_expired_at)
      from public.profiles
      where id = p_user_id
    ),
    false
  );
$$;

create or replace function record_stage1_trial_usage(p_user_id uuid)
returns void
language plpgsql
set search_path = ''
as $$
begin
  update public.profiles
  set
    trial_time_started_at = coalesce(trial_time_started_at, now()),
    trial_time_expired_at = coalesce(trial_time_expired_at, now() + interval '14 days'),
    trial_escalation_count = trial_escalation_count + 1
  where id = p_user_id;
end;
$$;
