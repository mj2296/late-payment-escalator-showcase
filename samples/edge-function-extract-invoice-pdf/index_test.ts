// Showcase sample — test suite for the function above, at
// supabase/functions/extract-invoice-pdf/index_test.ts (runs against a real
// local Supabase instance, not mocks; only the Claude API call is stubbed).
import { assertEquals, assertRejects } from "jsr:@std/assert@1";
import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  ensureAnthropicApiKeyConfigured,
  extractInvoicePdfForUser,
  isOversizedBase64,
  resolveUserId,
} from "./index.ts";

const localUrl = "http://127.0.0.1:54321";
const localServiceRoleKey =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU";
const localAnonKey =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0";

// "%PDF-" + arbitrary bytes, base64-encoded -- a minimal payload that passes the
// magic-byte check without needing a real PDF file on disk.
const VALID_PDF_BASE64 = btoa("%PDF-1.4 fake pdf bytes");
const WRONG_MAGIC_BASE64 = btoa("not a pdf at all");
const OVERSIZED_BASE64 = btoa("%PDF-" + "x".repeat(6 * 1024 * 1024));
// Between the new 2MB cap and the old 5MB cap -- would have passed the
// extraction-specific size check before this fix, and must not now. This is
// big enough to also trip the base64-length pre-check (isOversizedBase64)
// before decoding -- see JUST_OVER_DECODED_BASE64 below for a payload that
// specifically exercises the *post-decode* pdfBytes.length check instead.
const MID_SIZED_BASE64 = btoa("%PDF-" + "x".repeat(3 * 1024 * 1024));
// Decodes to exactly 3 bytes over the 2MB cap, but its base64-encoded length
// (2,796,208 chars) sits exactly AT MAX_PDF_BASE64_LENGTH, so isOversizedBase64
// (a strict ">") lets it through -- this is the one payload shape that can
// only be caught by the post-decode `pdfBytes.length > MAX_PDF_BYTES` check.
const JUST_OVER_DECODED_BASE64 = btoa("%PDF-" + "x".repeat(2 * 1024 * 1024 - 5 + 3));

// extractInvoicePdfForUser now gates on has_escalation_eligibility(p_user_id
// uuid), which requires both a real uuid and (to be eligible) either an
// active subscription or an unexhausted trial. A freshly-inserted profiles
// row with no subscription and default (unstarted) trial columns satisfies
// the trial branch, matching a brand new real user.
async function createEligibleUserId(supabase: SupabaseClient): Promise<string> {
  const email = `extract-eligible-${Date.now()}-${
    Math.random().toString(36).slice(2)
  }@test.com`;
  const { data, error } = await supabase.auth.admin.createUser({
    email,
    password: "password123",
    email_confirm: true,
  });
  if (error) throw error;
  const userId = data.user!.id;
  const { error: profileError } = await supabase.from("profiles").insert({
    id: userId,
    business_name: "Test Business",
    physical_address: "1 Test St",
    contact_email: email,
  });
  if (profileError) throw profileError;
  return userId;
}

function stubAnthropicFetch(body: unknown) {
  const originalFetch = globalThis.fetch;
  let called = false;
  globalThis.fetch = ((url: string, init?: RequestInit) => {
    if (url.toString().includes("api.anthropic.com")) {
      called = true;
      return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
    }
    return originalFetch(url, init);
  }) as typeof fetch;
  return { originalFetch, wasCalled: () => called };
}

Deno.test("rejects a non-PDF payload without calling Claude", async () => {
  const supabase = createClient(localUrl, localServiceRoleKey);
  const userId = await createEligibleUserId(supabase);
  const { originalFetch, wasCalled } = stubAnthropicFetch({ content: [] });

  try {
    const result = await extractInvoicePdfForUser(
      supabase,
      userId,
      WRONG_MAGIC_BASE64,
      { anthropicApiKey: "sk-ant-fake" },
    );

    assertEquals(result.body.success, false);
    assertEquals(result.body.reason, "invalid_pdf");
    assertEquals(wasCalled(), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("rejects an oversized payload without calling Claude", async () => {
  const supabase = createClient(localUrl, localServiceRoleKey);
  const userId = await createEligibleUserId(supabase);
  const { originalFetch, wasCalled } = stubAnthropicFetch({ content: [] });

  try {
    const result = await extractInvoicePdfForUser(
      supabase,
      userId,
      OVERSIZED_BASE64,
      { anthropicApiKey: "sk-ant-fake" },
    );

    assertEquals(result.body.success, false);
    assertEquals(result.body.reason, "invalid_pdf");
    assertEquals(wasCalled(), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("rejects a payload between the new 2MB cap and the old 5MB cap without calling Claude", async () => {
  const supabase = createClient(localUrl, localServiceRoleKey);
  const userId = await createEligibleUserId(supabase);
  const { originalFetch, wasCalled } = stubAnthropicFetch({ content: [] });

  try {
    const result = await extractInvoicePdfForUser(
      supabase,
      userId,
      MID_SIZED_BASE64,
      { anthropicApiKey: "sk-ant-fake" },
    );

    assertEquals(result.body.success, false);
    assertEquals(result.body.reason, "invalid_pdf");
    assertEquals(wasCalled(), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("rejects a payload that passes the base64-length pre-check but is 3 bytes over 2MB once decoded", async () => {
  const supabase = createClient(localUrl, localServiceRoleKey);
  const userId = await createEligibleUserId(supabase);
  // Confirms the pre-check genuinely lets this one through -- otherwise this
  // test would pass for the wrong reason (the pre-check, not the post-decode
  // check actually being exercised).
  assertEquals(isOversizedBase64(JUST_OVER_DECODED_BASE64), false);
  const { originalFetch, wasCalled } = stubAnthropicFetch({ content: [] });

  try {
    const result = await extractInvoicePdfForUser(
      supabase,
      userId,
      JUST_OVER_DECODED_BASE64,
      { anthropicApiKey: "sk-ant-fake" },
    );

    assertEquals(result.body.success, false);
    assertEquals(result.body.reason, "invalid_pdf");
    assertEquals(wasCalled(), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("throws when has_escalation_eligibility errors (e.g. a malformed user id)", async () => {
  const supabase = createClient(localUrl, localServiceRoleKey);
  const { originalFetch, wasCalled } = stubAnthropicFetch({ content: [] });

  try {
    // Not a valid uuid -- the RPC's `p_user_id uuid` parameter fails to cast,
    // so has_escalation_eligibility itself errors rather than returning
    // true/false. extractInvoicePdfForUser must surface that as a thrown
    // error (caught by Deno.serve's try/catch into a 500), not silently
    // treat it as ineligible or eligible.
    await assertRejects(
      () =>
        extractInvoicePdfForUser(
          supabase,
          "not-a-real-uuid",
          VALID_PDF_BASE64,
          { anthropicApiKey: "sk-ant-fake" },
        ),
      Error,
      "has_escalation_eligibility failed",
    );
    assertEquals(wasCalled(), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("short-circuits without calling Claude once the burst rate-limit tier is exhausted", async () => {
  const supabase = createClient(localUrl, localServiceRoleKey);
  const userId = await createEligibleUserId(supabase);
  const bucket = `extract-invoice-pdf:${userId}:burst`;
  // Exhaust the burst tier (max 15) directly via the same RPC the function under
  // test will call, rather than looping the function itself 15 times.
  for (let i = 0; i < 15; i++) {
    await supabase.rpc("check_rate_limit", { p_bucket: bucket, p_max: 15, p_window_seconds: 600 });
  }
  const { originalFetch, wasCalled } = stubAnthropicFetch({ content: [] });

  try {
    const result = await extractInvoicePdfForUser(
      supabase,
      userId,
      VALID_PDF_BASE64,
      { anthropicApiKey: "sk-ant-fake" },
    );

    assertEquals(result.body.success, false);
    assertEquals(result.body.reason, "rate_limited");
    assertEquals(wasCalled(), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("returns extracted fields on success", async () => {
  const supabase = createClient(localUrl, localServiceRoleKey);
  const userId = await createEligibleUserId(supabase);
  const { originalFetch } = stubAnthropicFetch({
    content: [
      {
        type: "text",
        text: JSON.stringify({
          document_type: "invoice",
          invoice_number: "1045",
          amount_cents: 100000,
          currency: "USD",
          due_date: "2026-09-01",
          description: "Website redesign",
          client_name: "Harborview Studios",
          client_email: "contact@harborviewstudios.com",
          client_address: "44 Dock Street",
        }),
      },
    ],
  });

  try {
    const result = await extractInvoicePdfForUser(
      supabase,
      userId,
      VALID_PDF_BASE64,
      { anthropicApiKey: "sk-ant-fake" },
    );

    assertEquals(result.body.success, true);
    assertEquals(result.body.fields?.invoice_number, "1045");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("returns success:false when Claude errors", async () => {
  const supabase = createClient(localUrl, localServiceRoleKey);
  const userId = await createEligibleUserId(supabase);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((url: string, init?: RequestInit) => {
    if (url.toString().includes("api.anthropic.com")) {
      return Promise.resolve(new Response("server error", { status: 500 }));
    }
    return originalFetch(url, init);
  }) as typeof fetch;

  try {
    const result = await extractInvoicePdfForUser(
      supabase,
      userId,
      VALID_PDF_BASE64,
      { anthropicApiKey: "sk-ant-fake" },
    );

    assertEquals(result.body.success, false);
    assertEquals(result.body.reason, "extraction_failed");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("has_escalation_eligibility returning false short-circuits to not_eligible without calling Claude", async () => {
  const supabase = createClient(localUrl, localServiceRoleKey);
  // A real uuid with no profiles row and no subscription -- ineligible under
  // has_escalation_eligibility's trial-or-subscription logic.
  const userId = crypto.randomUUID();
  const { originalFetch, wasCalled } = stubAnthropicFetch({ content: [] });

  try {
    const result = await extractInvoicePdfForUser(
      supabase,
      userId,
      VALID_PDF_BASE64,
      { anthropicApiKey: "sk-ant-fake" },
    );

    assertEquals(result.body.success, false);
    assertEquals(result.body.reason, "not_eligible");
    assertEquals(wasCalled(), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("isOversizedBase64 rejects a base64 string past the 2MB cap", () => {
  assertEquals(isOversizedBase64(OVERSIZED_BASE64), true);
  assertEquals(isOversizedBase64(MID_SIZED_BASE64), true);
});

Deno.test("isOversizedBase64 allows a base64 string within the 2MB cap", () => {
  assertEquals(isOversizedBase64(VALID_PDF_BASE64), false);
});

Deno.test("ensureAnthropicApiKeyConfigured returns a distinct 500 when the key is missing", async () => {
  const response = ensureAnthropicApiKeyConfigured(undefined);

  assertEquals(response?.status, 500);
  const body = await response!.json();
  assertEquals(body.error, "Server misconfigured");
});

Deno.test("ensureAnthropicApiKeyConfigured returns null when the key is present", () => {
  assertEquals(ensureAnthropicApiKeyConfigured("sk-ant-fake"), null);
});

Deno.test("resolveUserId returns null when the Authorization header is missing", async () => {
  const req = new Request("http://localhost/extract-invoice-pdf");

  const resolvedUserId = await resolveUserId(req, localUrl, localAnonKey);

  assertEquals(resolvedUserId, null);
});

Deno.test("resolveUserId returns the real user's id for a valid bearer token", async () => {
  const adminClient = createClient(localUrl, localServiceRoleKey);
  const email = `extract-resolve-${Date.now()}@test.com`;
  const password = "password123";
  const { data: userData, error: userError } = await adminClient.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (userError) throw userError;
  const userId = userData.user!.id;

  const anonClient = createClient(localUrl, localAnonKey);
  const { data: signInData, error: signInError } = await anonClient.auth.signInWithPassword({
    email,
    password,
  });
  if (signInError) throw signInError;
  const accessToken = signInData.session!.access_token;

  const req = new Request("http://localhost/extract-invoice-pdf", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  const resolvedUserId = await resolveUserId(req, localUrl, localAnonKey);

  assertEquals(resolvedUserId, userId);
});
