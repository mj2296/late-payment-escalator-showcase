// Showcase sample — test suite for the backstop above, at
// supabase/functions/run-stop-request-backstop/index_test.ts (runs against a
// real local Supabase instance, not mocks).
import { assertEquals, assertExists } from "jsr:@std/assert@1";
import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { runStopRequestBackstop, tryAutoPauseInvoice } from "./index.ts";

const localUrl = "http://127.0.0.1:54321";
const localServiceRoleKey =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU";

async function seedClientWithInvoices(
  supabase: SupabaseClient,
  count: number,
  statuses: string[],
) {
  const email = `backstop-${Date.now()}-${Math.random()}@test.com`;
  const { data: user } = await supabase.auth.admin.createUser({
    email,
    password: "password123",
    email_confirm: true,
  });
  await supabase.from("profiles").insert({
    id: user!.user!.id,
    business_name: "Test Studio",
    physical_address: "1 Test St",
    contact_email: "freelancer@test.com",
  });
  const { data: client } = await supabase
    .from("clients")
    .insert({
      user_id: user!.user!.id,
      name: "Test Client",
      email: "client@test.com",
      physical_address: "2 Test Ave",
    })
    .select()
    .single();
  const invoices = [];
  for (let i = 0; i < count; i++) {
    const { data: invoice } = await supabase
      .from("invoices")
      .insert({
        user_id: user!.user!.id,
        client_id: client!.id,
        invoice_number: `INV-${Date.now()}-${i}`,
        amount_cents: 1000,
        currency: "USD",
        due_date: "2026-01-01",
        status: statuses[i],
      })
      .select()
      .single();
    invoices.push(invoice!);
  }
  return { user: user!.user!, client: client!, invoices };
}

async function seedStopRequest(
  supabase: SupabaseClient,
  userId: string,
  clientId: string,
  originatingInvoiceId: string,
  invoiceIds: string[],
  requestedAt: Date,
) {
  const { data: stopRequest } = await supabase
    .from("stop_requests")
    .insert({
      client_id: clientId,
      user_id: userId,
      originating_invoice_id: originatingInvoiceId,
      requested_at: requestedAt.toISOString(),
    })
    .select()
    .single();
  await supabase
    .from("stop_request_invoices")
    .insert(invoiceIds.map((id) => ({ stop_request_id: stopRequest!.id, invoice_id: id })));
  return stopRequest!;
}

Deno.test("pauses every snapshotted invoice still overdue/escalating after 5 days, and notifies", async () => {
  const supabase = createClient(localUrl, localServiceRoleKey);
  const { user, client, invoices } = await seedClientWithInvoices(supabase, 3, [
    "overdue",
    "escalating",
    "overdue",
  ]);
  const sixDaysAgo = new Date(Date.now() - 6 * 24 * 60 * 60 * 1000);
  await seedStopRequest(
    supabase,
    user.id,
    client.id,
    invoices[0].id,
    invoices.map((i) => i.id),
    sixDaysAgo,
  );

  await runStopRequestBackstop(supabase, new Date());

  const { data: updated } = await supabase
    .from("invoices")
    .select("id, status")
    .in("id", invoices.map((i) => i.id));
  for (const row of updated!) {
    assertEquals(row.status, "paused");
  }
  const { data: pauses } = await supabase
    .from("escalation_pauses")
    .select("source")
    .in("invoice_id", invoices.map((i) => i.id));
  assertEquals(pauses!.every((p) => p.source === "stop_request_backstop"), true);

  const { data: notifications } = await supabase
    .from("notifications")
    .select("type, payload")
    .eq("user_id", user.id)
    .eq("type", "auto_pause_backstop");
  assertEquals(notifications!.length, 1);
  const payload = notifications![0].payload as {
    client_id: string;
    client_name: string;
    invoice_ids: string[];
  };
  assertEquals(payload.client_id, client.id);
  assertEquals(payload.client_name, "Test Client");
  assertEquals(payload.invoice_ids.sort(), invoices.map((i) => i.id).sort());
});

Deno.test("a second run is idempotent — no duplicate pauses, handled_at gets set", async () => {
  const supabase = createClient(localUrl, localServiceRoleKey);
  const { user, client, invoices } = await seedClientWithInvoices(supabase, 1, ["overdue"]);
  const sixDaysAgo = new Date(Date.now() - 6 * 24 * 60 * 60 * 1000);
  const stopRequest = await seedStopRequest(
    supabase,
    user.id,
    client.id,
    invoices[0].id,
    [invoices[0].id],
    sixDaysAgo,
  );

  await runStopRequestBackstop(supabase, new Date());
  await runStopRequestBackstop(supabase, new Date());

  const { data: pauses } = await supabase
    .from("escalation_pauses")
    .select("id")
    .eq("invoice_id", invoices[0].id);
  assertEquals(pauses!.length, 1);

  const { data: resolved } = await supabase
    .from("stop_requests")
    .select("handled_at")
    .eq("id", stopRequest.id)
    .single();
  assertEquals(resolved!.handled_at !== null, true);
});

Deno.test("an invoice the freelancer already manually paused before the run is left alone", async () => {
  const supabase = createClient(localUrl, localServiceRoleKey);
  const { user, client, invoices } = await seedClientWithInvoices(supabase, 2, ["overdue", "overdue"]);
  const sixDaysAgo = new Date(Date.now() - 6 * 24 * 60 * 60 * 1000);
  await seedStopRequest(
    supabase,
    user.id,
    client.id,
    invoices[0].id,
    invoices.map((i) => i.id),
    sixDaysAgo,
  );

  // Manually pause the first invoice before the backstop runs.
  await supabase.from("escalation_pauses").insert({
    invoice_id: invoices[0].id,
    paused_at: new Date().toISOString(),
    source: "manual",
  });
  await supabase.from("invoices").update({ status: "paused" }).eq("id", invoices[0].id);

  await runStopRequestBackstop(supabase, new Date());

  const { data: firstPauses } = await supabase
    .from("escalation_pauses")
    .select("source")
    .eq("invoice_id", invoices[0].id);
  assertEquals(firstPauses!.length, 1);
  assertEquals(firstPauses![0].source, "manual"); // not overwritten

  const { data: secondPauses } = await supabase
    .from("escalation_pauses")
    .select("source")
    .eq("invoice_id", invoices[1].id);
  assertEquals(secondPauses!.length, 1);
  assertEquals(secondPauses![0].source, "stop_request_backstop");
});

Deno.test("a stop request whose invoices are all already resolved before 5 days elapse gets handled_at without new pauses", async () => {
  const supabase = createClient(localUrl, localServiceRoleKey);
  const { user, client, invoices } = await seedClientWithInvoices(supabase, 1, ["paid"]);
  const sixDaysAgo = new Date(Date.now() - 6 * 24 * 60 * 60 * 1000);
  const stopRequest = await seedStopRequest(
    supabase,
    user.id,
    client.id,
    invoices[0].id,
    [invoices[0].id],
    sixDaysAgo,
  );

  await runStopRequestBackstop(supabase, new Date());

  const { data: pauses } = await supabase
    .from("escalation_pauses")
    .select("id")
    .eq("invoice_id", invoices[0].id);
  assertEquals(pauses!.length, 0);

  const { data: resolved } = await supabase
    .from("stop_requests")
    .select("handled_at")
    .eq("id", stopRequest.id)
    .single();
  assertEquals(resolved!.handled_at !== null, true);
});

Deno.test("the auto_pause_backstop notification includes email fields", async () => {
  const supabase = createClient(localUrl, localServiceRoleKey);
  const { data: userData } = await supabase.auth.admin.createUser({
    email: `backstop-email-${Date.now()}@test.com`,
    password: "password123",
    email_confirm: true,
  });
  const userId = userData!.user!.id;
  await supabase.from("profiles").insert({
    id: userId,
    business_name: "Test Studio",
    physical_address: "1 Test St",
    contact_email: "freelancer@test.com",
  });
  const { data: clientRow } = await supabase
    .from("clients")
    .insert({ user_id: userId, name: "Test Client", email: "client@test.com", physical_address: "2 Test Ave" })
    .select()
    .single();
  const { data: invoiceRow } = await supabase
    .from("invoices")
    .insert({
      user_id: userId,
      client_id: clientRow!.id,
      invoice_number: "1",
      amount_cents: 10000,
      due_date: "2020-01-01",
      status: "overdue",
    })
    .select()
    .single();
  const sixDaysAgo = new Date(Date.now() - 6 * 24 * 60 * 60 * 1000).toISOString();
  const { data: stopRequest } = await supabase
    .from("stop_requests")
    .insert({ client_id: clientRow!.id, user_id: userId, originating_invoice_id: invoiceRow!.id, requested_at: sixDaysAgo })
    .select()
    .single();
  await supabase
    .from("stop_request_invoices")
    .insert({ stop_request_id: stopRequest!.id, invoice_id: invoiceRow!.id });

  await runStopRequestBackstop(supabase, new Date());

  const { data: notifications } = await supabase
    .from("notifications")
    .select()
    .eq("type", "auto_pause_backstop")
    .eq("user_id", userId);
  assertEquals(notifications!.length, 1);
  assertExists(notifications![0].email_subject);
  assertExists(notifications![0].email_body);
});

Deno.test("tryAutoPauseInvoice does not pause an invoice whose status already moved on (e.g. paid) since it was last read", async () => {
  const supabase = createClient(localUrl, localServiceRoleKey);
  const { invoices } = await seedClientWithInvoices(supabase, 1, ["paid"]);

  const claimed = await tryAutoPauseInvoice(supabase, invoices[0].id, new Date());

  assertEquals(claimed, false);
  const { data: invoiceRow } = await supabase
    .from("invoices")
    .select("status")
    .eq("id", invoices[0].id)
    .single();
  assertEquals(invoiceRow!.status, "paid");
});

Deno.test("tryAutoPauseInvoice pauses an invoice that is still overdue/escalating", async () => {
  const supabase = createClient(localUrl, localServiceRoleKey);
  const { invoices } = await seedClientWithInvoices(supabase, 1, ["overdue"]);

  const claimed = await tryAutoPauseInvoice(supabase, invoices[0].id, new Date());

  assertEquals(claimed, true);
  const { data: invoiceRow } = await supabase
    .from("invoices")
    .select("status")
    .eq("id", invoices[0].id)
    .single();
  assertEquals(invoiceRow!.status, "paused");
});

Deno.test("a stop request less than 5 days old is left untouched", async () => {
  const supabase = createClient(localUrl, localServiceRoleKey);
  const { user, client, invoices } = await seedClientWithInvoices(supabase, 1, ["overdue"]);
  const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
  await seedStopRequest(supabase, user.id, client.id, invoices[0].id, [invoices[0].id], twoDaysAgo);

  await runStopRequestBackstop(supabase, new Date());

  const { data: invoiceRow } = await supabase
    .from("invoices")
    .select("status")
    .eq("id", invoices[0].id)
    .single();
  assertEquals(invoiceRow!.status, "overdue");
});
