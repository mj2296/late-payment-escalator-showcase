-- The inline constraint from 0015_notifications.sql was declared without an
-- explicit name, so Postgres auto-named it `notifications_type_check` (the
-- standard `{table}_{column}_check` convention). If this fails with
-- "constraint does not exist", confirm the actual name via:
--   select conname from pg_constraint where conrelid = 'notifications'::regclass;
alter table notifications
  drop constraint notifications_type_check,
  add constraint notifications_type_check
    check (type in ('stop_request', 'auto_pause_backstop', 'demand_letter_blocked_missing_address'));
