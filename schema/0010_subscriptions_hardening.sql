-- supabase/migrations/0010_subscriptions_hardening.sql

-- A unique index on stripe_customer_id (nulls excluded, since the column starts null
-- until a customer is lazily created in create-checkout-session) makes the webhook's
-- and create-portal-session's `.eq("stripe_customer_id", customerId)` lookups provably
-- single-row at the schema level, and turns the pre-existing Task-5-era race (two
-- concurrent first-checkout calls for the same user both creating a Stripe customer and
-- upserting a row) into a loud constraint-violation failure instead of a silent
-- orphaned row.
create unique index subscriptions_stripe_customer_id_key
  on subscriptions(stripe_customer_id)
  where stripe_customer_id is not null;

-- 0008_subscriptions.sql declared `user_id uuid not null unique ...`, which Postgres
-- already backs with its own unique index -- the separate explicit index on the same
-- column added in that same migration is dead weight (two indexes doing the same job
-- for every write and lookup). Drop it.
drop index if exists subscriptions_user_id_idx;

-- subscriptions deliberately has only a SELECT policy for `authenticated` (see
-- 0008_subscriptions.sql) and no INSERT/UPDATE/DELETE policy -- mirroring the
-- rationale documented for `profiles` in 0007_lock_trial_columns.sql. All writes to
-- this table happen exclusively from the Stripe-facing Edge Functions
-- (create-checkout-session, create-portal-session, stripe-webhook), which authenticate
-- to Postgres as `service_role` and bypass RLS entirely (BYPASSRLS). Letting a signed-in
-- user write their own row directly would mean they could set status = 'active' on
-- themselves via PostgREST without ever paying -- there is intentionally no client-side
-- write path to this table anywhere in lib/.
