-- supabase/migrations/0005_schedule_escalations.sql

-- pg_cron and pg_net have fixed schemas (`cron` and `net` respectively), which the SQL
-- below relies on via fully-qualified calls (`cron.schedule`, `net.http_post`). Do not add
-- `with schema extensions` here — on a fresh project that would move their objects into the
-- `extensions` schema and break these unqualified-schema references.
create extension if not exists pg_cron;
create extension if not exists pg_net;

select
  cron.schedule(
    'run-escalations-daily',
    '0 13 * * *', -- 13:00 UTC daily
    $$
    select
      net.http_post(
        url := (select decrypted_secret from vault.decrypted_secrets where name = 'escalation_function_url'),
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'escalation_function_service_key')
        ),
        body := '{}'::jsonb
      );
    $$
  );

create or replace function escalation_cron_job_exists()
returns boolean
language sql
security definer
set search_path = ''
as $$
  select exists (select 1 from cron.job where jobname = 'run-escalations-daily');
$$;
