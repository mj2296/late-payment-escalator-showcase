// Showcase sample — the Claude API client used for AI-assisted invoice-field
// extraction, at supabase/functions/_shared/anthropic/client.ts in the full
// repo. Takes an uploaded invoice PDF and asks Claude to extract structured
// fields (invoice number, amount, due date, client contact details) to
// prefill the Add/Edit Invoice form, instead of a user retyping everything.
export type ExtractedDocumentType = "invoice" | "uncertain" | "not_invoice";

export interface ExtractedInvoiceFields {
  document_type: ExtractedDocumentType;
  invoice_number: string | null;
  amount_cents: number | null;
  currency: string | null;
  due_date: string | null;
  description: string | null;
  client_name: string | null;
  client_email: string | null;
  client_address: string | null;
}

export interface AnthropicApiResult<T> {
  ok: boolean;
  data?: T;
  error?: string;
}

// Dated per Anthropic's current API version header -- bump deliberately (after
// checking Anthropic's changelog) the same way stripe_client.ts's pinned
// STRIPE_API_VERSION is reviewed periodically, not left stale indefinitely.
const ANTHROPIC_API_VERSION = "2026-10-21";

// Sonnet, not Opus: this is bounded single-document field extraction, not open-ended
// reasoning, and may run once per invoice for a user working through a large backlog
// (design doc Decision 5). Swap this one constant if manual testing shows accuracy
// needs Opus instead.
const EXTRACTION_MODEL = "claude-sonnet-5";

const EXTRACTION_PROMPT =
  "Extract invoice details from this PDF to prefill an invoicing app's form. " +
  "First set document_type: \"invoice\" if this is clearly an invoice, " +
  "\"not_invoice\" if you are confident it is something else entirely (e.g. a " +
  "photo, a contract, an unrelated document), or \"uncertain\" if you cannot " +
  "confidently tell either way. Then extract whatever of the following you can " +
  "find on the invoice; use null for anything not present or not confidently " +
  "readable. amount_cents is the total amount due, as an integer number of " +
  "cents (e.g. 1000.50 USD is 100050). currency is an ISO 4217 code (e.g. USD, " +
  "GBP, EUR). due_date is in YYYY-MM-DD format. description is a short one-line " +
  "summary of what the invoice is for. client_name, client_email, and " +
  "client_address describe the client being invoiced, not the invoice's issuer.";

const EXTRACTION_SCHEMA = {
  type: "object",
  properties: {
    document_type: { type: "string", enum: ["invoice", "uncertain", "not_invoice"] },
    invoice_number: { type: ["string", "null"] },
    amount_cents: { type: ["integer", "null"] },
    currency: { type: ["string", "null"] },
    due_date: { type: ["string", "null"] },
    description: { type: ["string", "null"] },
    client_name: { type: ["string", "null"] },
    client_email: { type: ["string", "null"] },
    client_address: { type: ["string", "null"] },
  },
  required: [
    "document_type",
    "invoice_number",
    "amount_cents",
    "currency",
    "due_date",
    "description",
    "client_name",
    "client_email",
    "client_address",
  ],
  additionalProperties: false,
};

export async function extractInvoiceFields(
  apiKey: string,
  pdfBase64: string,
): Promise<AnthropicApiResult<ExtractedInvoiceFields>> {
  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": ANTHROPIC_API_VERSION,
        "content-type": "application/json",
      },
      signal: AbortSignal.timeout(30000),
      body: JSON.stringify({
        model: EXTRACTION_MODEL,
        max_tokens: 4096,
        // This is bounded single-document field extraction with a fixed JSON
        // schema, not open-ended reasoning -- thinking tokens would just eat
        // into max_tokens for no benefit here.
        thinking: { type: "disabled" },
        messages: [
          {
            role: "user",
            content: [
              {
                type: "document",
                source: { type: "base64", media_type: "application/pdf", data: pdfBase64 },
              },
              { type: "text", text: EXTRACTION_PROMPT },
            ],
          },
        ],
        output_config: {
          effort: "low",
          format: { type: "json_schema", schema: EXTRACTION_SCHEMA },
        },
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      return { ok: false, error: `Anthropic API error ${response.status}: ${text}` };
    }

    const data = await response.json();
    const textBlock = (data.content as Array<{ type: string; text?: string }> | undefined)
      ?.find((block) => block.type === "text");
    if (!textBlock?.text) {
      return { ok: false, error: "Anthropic response had no text content block" };
    }

    try {
      const fields = JSON.parse(textBlock.text) as ExtractedInvoiceFields;
      return { ok: true, data: fields };
    } catch (parseError) {
      // Distinct from the outer catch: this is a malformed/truncated response
      // from a successful call, not a network failure, and stop_reason (e.g.
      // "max_tokens") is the key diagnostic for telling those apart.
      return {
        ok: false,
        error: `Failed to parse Anthropic response as JSON (stop_reason: ${data.stop_reason}): ${
          parseError instanceof Error ? parseError.message : String(parseError)
        }`,
      };
    }
  } catch (error) {
    return {
      ok: false,
      error: `Network error calling Anthropic: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
