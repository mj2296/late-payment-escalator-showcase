-- Mirrored (UI-only approximation) by `isEligible` in
-- lib/models/trial_status.dart. This function is the source of truth (the
-- server-side gate actually enforced in run-escalations) -- the Dart copy is
-- not kept in sync automatically and must be updated by hand if this
-- function's logic changes. (Note: as of this milestone the Dart mirror does
-- NOT yet check subscription status -- Task 10 extends the Dashboard badge's
-- check separately via BillingRepository rather than teaching TrialStatus
-- about subscriptions.)
create or replace function has_escalation_eligibility(p_user_id uuid)
returns boolean
language sql
stable
set search_path = ''
as $$
  select
    exists (
      select 1 from public.subscriptions
      where user_id = p_user_id and status = 'active'
    )
    or coalesce(
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
