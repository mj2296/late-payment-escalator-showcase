-- supabase/migrations/0008_subscriptions.sql

create table subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references auth.users(id) on delete cascade,
  stripe_customer_id text,
  stripe_subscription_id text,
  status text not null default 'none' check (status in ('none', 'active', 'past_due', 'canceled')),
  current_period_end timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table subscriptions enable row level security;

create policy "subscriptions are owner-readable"
  on subscriptions for select
  using (auth.uid() = user_id);

create index subscriptions_user_id_idx on subscriptions(user_id);
create index subscriptions_stripe_customer_id_idx on subscriptions(stripe_customer_id);
