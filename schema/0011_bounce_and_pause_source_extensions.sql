-- supabase/migrations/0011_bounce_and_pause_source_extensions.sql

alter table escalation_stages
  add column provider_message_id text,
  add column bounced_at timestamptz;

-- The inline `check (source in ('manual'))` from 0003_escalation_engine.sql was declared
-- without an explicit constraint name, so Postgres auto-named it
-- `escalation_pauses_source_check` (its standard `{table}_{column}_check` convention for an
-- unnamed inline column constraint). If this migration fails with "constraint does not
-- exist", confirm the actual name via:
--   select conname from pg_constraint where conrelid = 'escalation_pauses'::regclass;
-- and update the DROP line to match before re-running.
alter table escalation_pauses
  drop constraint escalation_pauses_source_check,
  add constraint escalation_pauses_source_check
    check (source in ('manual', 'stop_request_backstop'));
