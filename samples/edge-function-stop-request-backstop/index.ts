// Showcase sample — daily pg_cron edge function. In the real app, runs at
// supabase/functions/run-stop-request-backstop/index.ts: auto-pauses any
// invoice whose client "stop sending me emails" request went unresolved for
// 5 days, so a non-response can't silently keep escalating forever.
import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { createNotification } from "../_shared/notify.ts";
import { isAuthorizedCronRequest } from "../_shared/cron_auth.ts";

const FIVE_DAYS_MS = 5 * 24 * 60 * 60 * 1000;

async function markHandled(supabase: SupabaseClient, stopRequestId: string): Promise<void> {
  const { error } = await supabase
    .from("stop_requests")
    .update({ handled_at: new Date().toISOString() })
    .eq("id", stopRequestId);
  if (error) throw new Error(`stop_requests handled_at update failed: ${error.message}`);
}

// Conditions the pause on the invoice's *current* status rather than the
// possibly-stale snapshot read earlier in the run -- without this, an
// invoice paid (by the freelancer or a Stripe webhook) in the window
// between that snapshot and this update would get silently overwritten
// back to "paused". Returns whether this call actually claimed the pause.
export async function tryAutoPauseInvoice(
  supabase: SupabaseClient,
  invoiceId: string,
  now: Date,
): Promise<boolean> {
  const { data, error } = await supabase
    .from("invoices")
    .update({ status: "paused", updated_at: now.toISOString() })
    .eq("id", invoiceId)
    .in("status", ["overdue", "escalating"])
    .select("id")
    .maybeSingle();
  if (error) throw new Error(`invoices update failed: ${error.message}`);
  return data !== null;
}

export async function runStopRequestBackstop(
  supabase: SupabaseClient,
  now: Date = new Date(),
): Promise<void> {
  const cutoff = new Date(now.getTime() - FIVE_DAYS_MS);

  const { data: dueRequests, error: dueError } = await supabase
    .from("stop_requests")
    .select("id, user_id, client_id")
    .is("handled_at", null)
    .lte("requested_at", cutoff.toISOString());
  if (dueError) throw new Error(`stop_requests lookup failed: ${dueError.message}`);

  for (const stopRequest of dueRequests ?? []) {
    try {
      const { data: snapshot, error: snapshotError } = await supabase
        .from("stop_request_invoices")
        .select("invoice_id")
        .eq("stop_request_id", stopRequest.id);
      if (snapshotError) {
        throw new Error(`stop_request_invoices lookup failed: ${snapshotError.message}`);
      }

      const invoiceIds = (snapshot ?? []).map((r: { invoice_id: string }) => r.invoice_id);
      if (invoiceIds.length === 0) {
        await markHandled(supabase, stopRequest.id);
        continue;
      }

      const { data: invoiceRows, error: invoicesError } = await supabase
        .from("invoices")
        .select("id, status")
        .in("id", invoiceIds);
      if (invoicesError) throw new Error(`invoices lookup failed: ${invoicesError.message}`);

      const pausedNow: string[] = [];
      for (const invoice of invoiceRows ?? []) {
        // Not already paused (manually or by a prior backstop run) or paid -- this
        // status check is what makes a second run of this whole function idempotent
        // (design Decision 11): a concurrent manual pause or a previous backstop run has
        // already moved the row out of this branch.
        if (invoice.status !== "overdue" && invoice.status !== "escalating") continue;

        const claimed = await tryAutoPauseInvoice(supabase, invoice.id, now);
        if (!claimed) continue; // status moved on since the snapshot above -- leave it alone

        const { error: pauseError } = await supabase.from("escalation_pauses").insert({
          invoice_id: invoice.id,
          paused_at: now.toISOString(),
          source: "stop_request_backstop",
        });
        if (pauseError) {
          // A concurrent manual pause raced this cron between the status check above
          // and this insert and won -- escalation_pauses_open_unique_idx (migration
          // 0026) rejects this insert with 23505 rather than letting a second open
          // pause row leak time out of cumulative_pause_seconds. The invoice is
          // already paused via the other path, so skip it (don't double-count it in
          // the auto-pause notification below) rather than throwing.
          if (pauseError.code === "23505") continue;
          // Any other failure here (transient network/DB error) leaves the invoice
          // already flipped to "paused" by tryAutoPauseInvoice above but with no
          // escalation_pauses row to show for it -- left as-is, the guard at the top
          // of this loop would skip it on every future run (status is no longer
          // "overdue"/"escalating"), permanently stranding it. Revert the status so
          // the next run retries it cleanly instead.
          await supabase
            .from("invoices")
            .update({ status: invoice.status })
            .eq("id", invoice.id)
            .eq("status", "paused");
          throw new Error(`escalation_pauses insert failed: ${pauseError.message}`);
        }

        pausedNow.push(invoice.id);
      }

      if (pausedNow.length > 0) {
        // Payload shape follows design Decision 8: {client_id, client_name, invoice_ids}
        // -- enough to deep-link without a second fetch, same as invoice-view's own
        // stop-request-creation notification (invoice-view/index.ts's handleStopRequest).
        const { data: clientRow } = await supabase
          .from("clients")
          .select("name")
          .eq("id", stopRequest.client_id)
          .single();
        const { data: profileRow } = await supabase
          .from("profiles")
          .select("contact_email")
          .eq("id", stopRequest.user_id)
          .maybeSingle();

        const clientName = clientRow?.name ?? "a client";
        await createNotification(supabase, {
          userId: stopRequest.user_id,
          type: "auto_pause_backstop",
          payload: {
            client_id: stopRequest.client_id,
            client_name: clientName,
            invoice_ids: pausedNow,
          },
          email: profileRow
            ? {
                subject: `${clientName}'s invoices were auto-paused`,
                body:
                  `${clientName} asked to stop reminder emails, and 5 days passed with no ` +
                  "response from you, so their affected invoices have been automatically " +
                  "paused. You can resume them any time from the app.",
                to: profileRow.contact_email,
                replyTo: profileRow.contact_email,
              }
            : null,
        });
      }

      // Resolution check: re-fetch current status for every snapshotted invoice, not
      // just the ones this run itself paused -- a freelancer manually pausing or
      // marking every affected invoice paid before 5 days elapse also resolves the
      // request, with no separate "acknowledged" action (design Decision 11, spec 7.2).
      const { data: finalRows, error: finalError } = await supabase
        .from("invoices")
        .select("id, status")
        .in("id", invoiceIds);
      if (finalError) throw new Error(`invoices re-check failed: ${finalError.message}`);
      const allResolved = (finalRows ?? []).every(
        (row: { status: string }) => row.status === "paused" || row.status === "paid",
      );
      if (allResolved) await markHandled(supabase, stopRequest.id);
    } catch (err) {
      console.error(`Unexpected error processing stop request ${stopRequest.id}:`, err);
      continue;
    }
  }
}

// See _shared/cron_auth.ts for why this explicit check exists alongside
// verify_jwt = true. Do not remove this check.
Deno.serve(async (req) => {
  if (!isAuthorizedCronRequest(req)) {
    return new Response("Unauthorized", { status: 401 });
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );
  await runStopRequestBackstop(supabase, new Date());

  return new Response(JSON.stringify({ ok: true }), {
    headers: { "Content-Type": "application/json" },
  });
});
