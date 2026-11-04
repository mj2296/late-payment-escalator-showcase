-- supabase/migrations/0016_stop_requests_unresolved_unique_index.sql

-- Closes a TOCTOU race in invoice-view's handleStopRequest: the application-level
-- select-then-insert dedup check (design Decision 5 — "does not create a second row or
-- a second notification") cannot by itself prevent two near-simultaneous POSTs from both
-- passing the "no existing unresolved row" read before either insert commits. A partial
-- unique index is what actually closes the race at the database level; the app code then
-- tolerates the resulting 23505 unique-violation the same way
-- run-escalations/index.ts's getOrCreateInvoiceLink tolerates a concurrent insert of
-- invoice_recipient_tokens.
create unique index stop_requests_unresolved_unique_idx
  on stop_requests (client_id, user_id)
  where handled_at is null;
