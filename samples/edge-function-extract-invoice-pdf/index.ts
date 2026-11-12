// Showcase sample — the Edge Function that fronts AI-assisted invoice-field
// extraction, at supabase/functions/extract-invoice-pdf/index.ts in the full
// repo. Picked as a sample specifically for its cost/abuse-safety layering:
// an eligibility gate (no Claude call for a non-paying/trial-exhausted user),
// a size cap independent of the client's own cap, tiered per-user rate
// limits, and a distinct 500 for a misconfigured API key rather than a
// generic failure -- see supabase/functions/_shared/anthropic/client.ts
// (also sampled here) for the Claude API call itself.
import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { extractInvoiceFields, ExtractedInvoiceFields } from "../_shared/anthropic/client.ts";

// This is a cap specific to this Edge Function, bounding Claude API cost on
// large documents -- intentionally independent of (and smaller than) the
// Flutter client's own 5MB attach-feature cap (maxOriginalPdfBytes in
// add_edit_invoice_screen.dart), which exists for a different purpose (what
// original PDF a user may keep on file) and is not changed by this.
const MAX_PDF_BYTES = 2 * 1024 * 1024;
const PDF_MAGIC_BYTES = [0x25, 0x50, 0x44, 0x46, 0x2D]; // "%PDF-"

// Base64 encodes 3 bytes as 4 characters; this is a safe upper bound on
// encoded length (accounting for padding) that lets us reject an oversized
// payload by string length alone, before paying the cost of decoding it.
const MAX_PDF_BASE64_LENGTH = Math.ceil(MAX_PDF_BYTES / 3) * 4 + 4;

export function isOversizedBase64(base64: string): boolean {
  return base64.length > MAX_PDF_BASE64_LENGTH;
}

function looksLikePdf(bytes: Uint8Array): boolean {
  if (bytes.length < PDF_MAGIC_BYTES.length) return false;
  for (let i = 0; i < PDF_MAGIC_BYTES.length; i++) {
    if (bytes[i] !== PDF_MAGIC_BYTES[i]) return false;
  }
  return true;
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// Three layered, per-user tiers (design doc Decision 6) -- never a shared/global
// bucket, which would throttle legitimate users as the user base grows. Burst
// catches scripted bursts no human picking files one at a time could produce;
// hourly covers a long backlog-entry session; daily bounds worst-case sustained
// cost per account.
const RATE_LIMIT_TIERS: Array<{ suffix: string; max: number; windowSeconds: number }> = [
  { suffix: "burst", max: 15, windowSeconds: 600 },
  { suffix: "hourly", max: 40, windowSeconds: 3600 },
  { suffix: "daily", max: 200, windowSeconds: 86400 },
];

export interface ExtractRequestEnv {
  anthropicApiKey: string;
}

export interface ExtractResult {
  status: number;
  body: { success: boolean; fields?: ExtractedInvoiceFields; reason?: string };
}

export async function extractInvoicePdfForUser(
  supabase: SupabaseClient,
  userId: string,
  pdfBase64: string,
  env: ExtractRequestEnv,
): Promise<ExtractResult> {
  // Same server-side gate run-escalations actually enforces (see
  // supabase/migrations/0009_subscription_eligibility.sql) -- an active
  // subscription or an unexhausted free trial. This endpoint spends real
  // money per call, so it must not run for a user who isn't eligible,
  // regardless of what the client-side UI shows.
  const { data: eligible, error: eligibilityError } = await supabase.rpc(
    "has_escalation_eligibility",
    { p_user_id: userId },
  );
  if (eligibilityError) {
    throw new Error(`has_escalation_eligibility failed: ${eligibilityError.message}`);
  }
  if (!eligible) {
    return { status: 200, body: { success: false, reason: "not_eligible" } };
  }

  // Cheap length check on the base64 string itself, before paying the cost of
  // decoding a potentially huge payload.
  if (isOversizedBase64(pdfBase64)) {
    return { status: 200, body: { success: false, reason: "invalid_pdf" } };
  }

  const pdfBytes = base64ToBytes(pdfBase64);
  if (pdfBytes.length > MAX_PDF_BYTES || !looksLikePdf(pdfBytes)) {
    // The client already checks this (add_edit_invoice_screen.dart's
    // _looksLikePdf/maxOriginalPdfBytes), but this endpoint spends real money per
    // call, so a scripted caller bypassing the Flutter UI must not be able to
    // force arbitrarily large or non-PDF payloads into the Claude call.
    return { status: 200, body: { success: false, reason: "invalid_pdf" } };
  }

  for (const tier of RATE_LIMIT_TIERS) {
    const { data: allowed, error } = await supabase.rpc("check_rate_limit", {
      p_bucket: `extract-invoice-pdf:${userId}:${tier.suffix}`,
      p_max: tier.max,
      p_window_seconds: tier.windowSeconds,
    });
    if (error) throw new Error(`check_rate_limit failed: ${error.message}`);
    if (!allowed) {
      return { status: 200, body: { success: false, reason: "rate_limited" } };
    }
  }

  const result = await extractInvoiceFields(env.anthropicApiKey, pdfBase64);
  if (!result.ok || !result.data) {
    console.error("extractInvoiceFields failed:", result.error);
    return { status: 200, body: { success: false, reason: "extraction_failed" } };
  }

  return { status: 200, body: { success: true, fields: result.data } };
}

// Resolves the calling user's id from their own Supabase JWT, the same pattern as
// create-checkout-session/index.ts's resolveUserId -- duplicated rather than shared,
// matching this codebase's existing convention of one copy per function rather than
// a generic _shared auth helper.
export async function resolveUserId(
  req: Request,
  supabaseUrl: string,
  anonKey: string,
): Promise<string | null> {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return null;

  const userClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
  });
  try {
    const { data: userData, error: userError } = await userClient.auth.getUser();
    if (userError || !userData.user) return null;
    return userData.user.id;
  } catch {
    return null;
  }
}

// A missing ANTHROPIC_API_KEY secret would otherwise surface as a plain
// Anthropic 401, which extractInvoicePdfForUser folds into the same
// {success:false, reason:"extraction_failed"} shape as a genuinely bad PDF --
// indistinguishable from a bad-accuracy symptom in logs/monitoring. This exact
// failure shape (a misconfigured secret silently breaking a feature with no
// diagnosable signal) already happened once in this project with a different
// secret, so this check returns a visibly distinct response instead. Exported
// as its own function so the check is testable without a real Deno.serve request.
export function ensureAnthropicApiKeyConfigured(apiKey: string | undefined): Response | null {
  if (apiKey) return null;
  console.error("extract-invoice-pdf: ANTHROPIC_API_KEY is not configured");
  return new Response(JSON.stringify({ error: "Server misconfigured" }), { status: 500 });
}

Deno.serve(async (req) => {
  const userId = await resolveUserId(
    req,
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
  );
  if (!userId) {
    return new Response(JSON.stringify({ error: "Not authenticated" }), { status: 401 });
  }

  try {
    const anthropicApiKey = Deno.env.get("ANTHROPIC_API_KEY");
    const misconfiguredResponse = ensureAnthropicApiKeyConfigured(anthropicApiKey);
    if (misconfiguredResponse) return misconfiguredResponse;

    const { pdf_base64 } = await req.json();
    if (typeof pdf_base64 !== "string") {
      return new Response(JSON.stringify({ error: "pdf_base64 is required" }), { status: 400 });
    }

    const adminClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const result = await extractInvoicePdfForUser(adminClient, userId, pdf_base64, {
      anthropicApiKey: anthropicApiKey!,
    });

    return new Response(JSON.stringify(result.body), {
      status: result.status,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("extract-invoice-pdf: unexpected error", error);
    return new Response(JSON.stringify({ error: "Internal error" }), { status: 500 });
  }
});
