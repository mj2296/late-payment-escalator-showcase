-- supabase/migrations/0015_notifications.sql

create table notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  type text not null check (type in ('stop_request', 'auto_pause_backstop')),
  payload jsonb not null default '{}'::jsonb,
  read_at timestamptz,
  created_at timestamptz not null default now()
);

alter table notifications enable row level security;

create policy "notifications are owner-readable"
  on notifications for select
  using (auth.uid() = user_id);

create policy "notifications read_at is owner-updatable"
  on notifications for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- The UPDATE policy above only grants the *row-level* right to run an UPDATE at all;
-- Postgres RLS and table/column GRANTs are independent, sequential gates (the exact
-- lesson 0007_lock_trial_columns.sql fixed for `profiles`), so a column-scoped GRANT is
-- still required to actually restrict *which* columns `authenticated` may change.
revoke insert, delete on notifications from anon, authenticated;
revoke update on notifications from anon, authenticated;
grant update (read_at) on notifications to authenticated;

create index notifications_user_id_idx on notifications(user_id);
create index notifications_unread_idx on notifications(user_id) where read_at is null;
