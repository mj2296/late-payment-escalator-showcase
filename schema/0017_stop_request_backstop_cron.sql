-- supabase/migrations/0017_stop_request_backstop_cron.sql

select
  cron.schedule(
    'run-stop-request-backstop-daily',
    '30 13 * * *', -- 13:30 UTC daily -- offset 30 min after run-escalations' 13:00 run so
                   -- a backstop-triggered pause never races a same-day escalation send
    $$
    select
      net.http_post(
        url := (select decrypted_secret from vault.decrypted_secrets where name = 'stop_request_backstop_function_url'),
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'escalation_function_service_key')
        ),
        body := '{}'::jsonb
      );
    $$
  );

create or replace function stop_request_backstop_cron_job_exists()
returns boolean
language sql
security definer
set search_path = ''
as $$
  select exists (select 1 from cron.job where jobname = 'run-stop-request-backstop-daily');
$$;
