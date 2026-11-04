// Showcase sample — real path: supabase/functions/_shared/cron_auth_test.ts.
import { assertEquals } from "jsr:@std/assert@1";
import { isAuthorizedCronRequest } from "./cron_auth.ts";

const originalKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

function withServiceRoleKey(key: string, fn: () => void) {
  Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", key);
  try {
    fn();
  } finally {
    if (originalKey === undefined) {
      Deno.env.delete("SUPABASE_SERVICE_ROLE_KEY");
    } else {
      Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", originalKey);
    }
  }
}

Deno.test("returns true when the Authorization header matches Bearer + the service role key", () => {
  withServiceRoleKey("test-service-role-key", () => {
    const req = new Request("http://localhost", {
      headers: { Authorization: "Bearer test-service-role-key" },
    });
    assertEquals(isAuthorizedCronRequest(req), true);
  });
});

Deno.test("returns false when the Authorization header is missing", () => {
  withServiceRoleKey("test-service-role-key", () => {
    const req = new Request("http://localhost");
    assertEquals(isAuthorizedCronRequest(req), false);
  });
});

Deno.test("returns false when the Authorization header doesn't match the service role key", () => {
  withServiceRoleKey("test-service-role-key", () => {
    const req = new Request("http://localhost", {
      headers: { Authorization: "Bearer wrong-key" },
    });
    assertEquals(isAuthorizedCronRequest(req), false);
  });
});

Deno.test("returns false for the public anon key even though verify_jwt would accept it", () => {
  // This is the exact gap the explicit check exists to close: verify_jwt = true
  // only proves *some* valid Supabase JWT, which the public anon key satisfies
  // too -- this function is what actually restricts callers to the service role.
  withServiceRoleKey("test-service-role-key", () => {
    const req = new Request("http://localhost", {
      headers: { Authorization: "Bearer some-anon-or-user-jwt" },
    });
    assertEquals(isAuthorizedCronRequest(req), false);
  });
});
