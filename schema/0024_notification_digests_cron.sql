-- supabase/migrations/0024_notification_digests_cron.sql

-- Mirrors 0017_stop_request_backstop_cron.sql's exact mechanism: a Vault
-- secret for this function's own URL, reusing the existing
-- escalation_function_service_key Vault secret from Milestone 2 (the same
-- service-role key authenticates every scheduled function in this codebase).
select
  cron.schedule(
    'send-notification-digests-hourly',
    '0 * * * *', -- top of every hour (design doc Decision 5)
    $$
    select
      net.http_post(
        url := (select decrypted_secret from vault.decrypted_secrets where name = 'send_notification_digests_function_url'),
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'escalation_function_service_key')
        ),
        body := '{}'::jsonb
      );
    $$
  );

create or replace function send_notification_digests_cron_job_exists()
returns boolean
language sql
security definer
set search_path = ''
as $$
  select exists (select 1 from cron.job where jobname = 'send-notification-digests-hourly');
$$;
