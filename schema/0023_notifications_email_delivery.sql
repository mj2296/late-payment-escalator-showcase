-- supabase/migrations/0023_notifications_email_delivery.sql

-- Milestone 6 design doc Decision 1: one nullable emailed_at applying to
-- every notification type uniformly, not a click-specific column -- immediate
-- types stamp it inline on send success; tracked_click rows are inserted with
-- it left null and picked up by send-notification-digests' click-digest pass;
-- an immediate send that fails outright is left exactly as an unsent click
-- would be, so the digest function's retry pass (Decision 5) catches it too,
-- for free, with no separate failure-tracking mechanism.
--
-- email_subject/email_body (Decision 5): the composed email text is stored at
-- insert time, unconditionally whenever an email was supplied, so a later
-- retry can re-send the exact same text rather than re-deriving it per type.
alter table notifications
  add column emailed_at timestamptz,
  add column email_subject text,
  add column email_body text;

-- The inline constraint from 0015_notifications.sql was declared without an
-- explicit name, so Postgres auto-named it `notifications_type_check` (the
-- standard `{table}_{column}_check` convention, already confirmed by
-- 0021_notifications_demand_letter_type.sql's own extension of it). If this
-- fails with "constraint does not exist", confirm the actual name via:
--   select conname from pg_constraint where conrelid = 'notifications'::regclass;
alter table notifications
  drop constraint notifications_type_check,
  add constraint notifications_type_check
    check (type in (
      'stop_request', 'auto_pause_backstop', 'demand_letter_blocked_missing_address',
      'tracked_click', 'bounced', 'stage_fired', 'trial_clock_started', 'trial_ending',
      'subscribed', 'payment_failed', 'subscription_cancelled'
    ));

-- Serves both send-notification-digests' click-digest grouping query and its
-- retry sweep -- both filter on emailed_at is null first, type second
-- (design doc's Data model section).
create index notifications_unemailed_idx on notifications(type, emailed_at) where emailed_at is null;
