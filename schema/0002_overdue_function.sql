-- supabase/migrations/0002_overdue_function.sql

create or replace function mark_overdue_invoices()
returns void
language sql
as $$
  update invoices
  set status = 'overdue', updated_at = now()
  where status = 'pending'
    and due_date < current_date;
$$;
