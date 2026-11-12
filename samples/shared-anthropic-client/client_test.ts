// Showcase sample — test suite for the Claude client above, at
// supabase/functions/_shared/anthropic/client_test.ts (stubs fetch, no real
// API key or network call needed).
import { assertEquals } from "jsr:@std/assert@1";
import { extractInvoiceFields } from "./client.ts";

function stubAnthropicFetch(status: number, body: unknown) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((url: string, init?: RequestInit) => {
    if (url.toString().includes("api.anthropic.com/v1/messages")) {
      return Promise.resolve(new Response(JSON.stringify(body), { status }));
    }
    return originalFetch(url, init);
  }) as typeof fetch;
  return originalFetch;
}

// Like stubAnthropicFetch, but also captures the request body so tests can
// assert on exactly what was sent to Claude (e.g. thinking/max_tokens).
function stubAnthropicFetchCapturingRequest(status: number, body: unknown) {
  const originalFetch = globalThis.fetch;
  let capturedBody: Record<string, unknown> | undefined;
  globalThis.fetch = ((url: string, init?: RequestInit) => {
    if (url.toString().includes("api.anthropic.com/v1/messages")) {
      capturedBody = JSON.parse(init!.body as string);
      return Promise.resolve(new Response(JSON.stringify(body), { status }));
    }
    return originalFetch(url, init);
  }) as typeof fetch;
  return { originalFetch, capturedBody: () => capturedBody };
}

Deno.test("parses a well-formed Claude response into ExtractedInvoiceFields", async () => {
  const originalFetch = stubAnthropicFetch(200, {
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
    const result = await extractInvoiceFields("sk-ant-fake", "ZmFrZS1wZGY=");

    assertEquals(result.ok, true);
    assertEquals(result.data?.document_type, "invoice");
    assertEquals(result.data?.invoice_number, "1045");
    assertEquals(result.data?.amount_cents, 100000);
    assertEquals(result.data?.client_email, "contact@harborviewstudios.com");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("a response missing some fields still parses the ones present", async () => {
  const originalFetch = stubAnthropicFetch(200, {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          document_type: "invoice",
          invoice_number: "1045",
          amount_cents: null,
          currency: null,
          due_date: null,
          description: null,
          client_name: null,
          client_email: null,
          client_address: null,
        }),
      },
    ],
  });

  try {
    const result = await extractInvoiceFields("sk-ant-fake", "ZmFrZS1wZGY=");

    assertEquals(result.ok, true);
    assertEquals(result.data?.invoice_number, "1045");
    assertEquals(result.data?.amount_cents, null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("returns ok:false on a non-2xx response from Claude", async () => {
  const originalFetch = stubAnthropicFetch(400, { error: { message: "bad request" } });

  try {
    const result = await extractInvoiceFields("sk-ant-fake", "ZmFrZS1wZGY=");

    assertEquals(result.ok, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("returns ok:false (not a throw) on a network error", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (() => Promise.reject(new Error("network down"))) as typeof fetch;

  try {
    const result = await extractInvoiceFields("sk-ant-fake", "ZmFrZS1wZGY=");

    assertEquals(result.ok, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("request body disables thinking and raises max_tokens to 4096", async () => {
  const { originalFetch, capturedBody } = stubAnthropicFetchCapturingRequest(200, {
    content: [{ type: "text", text: JSON.stringify({ document_type: "invoice" }) }],
  });

  try {
    await extractInvoiceFields("sk-ant-fake", "ZmFrZS1wZGY=");

    const body = capturedBody();
    assertEquals(body?.max_tokens, 4096);
    assertEquals(body?.thinking, { type: "disabled" });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("a response with unparseable text produces an error message containing stop_reason", async () => {
  const originalFetch = stubAnthropicFetch(200, {
    stop_reason: "max_tokens",
    content: [{ type: "text", text: "{not valid json" }],
  });

  try {
    const result = await extractInvoiceFields("sk-ant-fake", "ZmFrZS1wZGY=");

    assertEquals(result.ok, false);
    assertEquals(result.error?.includes("stop_reason: max_tokens"), true);
    assertEquals(result.error?.includes("Network error"), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
