// Showcase sample — real path: supabase/functions/_shared/cron_auth.ts.
//
// Shared by every Edge Function meant to be called only by a pg_cron job
// (run-escalations, run-stop-request-backstop, send-notification-digests).
// These functions keep the project's default verify_jwt = true (see each
// function's own [functions.*] block in supabase/config.toml), which only
// proves the caller holds *some* valid Supabase JWT -- the app's public anon
// key satisfies that too. This explicit bearer-token check is what actually
// restricts calls to trusted callers (the pg_cron job, using the service-role
// key from Vault). Do not use this as a substitute for verify_jwt or vice
// versa -- disabling verify_jwt would additionally drop Supabase's own
// JWT-shape/signature validation ahead of this check.
// Matches the constant-time comparison every other secret check in this
// codebase uses (recipient_token.ts, stripe/verify_signature.ts,
// resend/verify_webhook.ts) -- each keeps its own copy rather than a shared
// import, per this codebase's convention for helpers this small.
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

export function isAuthorizedCronRequest(req: Request): boolean {
  const authHeader = req.headers.get("Authorization");
  if (authHeader === null) return false;
  const expectedAuth = `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!}`;
  return timingSafeEqual(authHeader, expectedAuth);
}
