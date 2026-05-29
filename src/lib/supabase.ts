import { createServerClient, parseCookieHeader } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";
import type { AstroCookies } from "astro";

const SUPABASE_URL = import.meta.env.PUBLIC_SUPABASE_URL;
const SUPABASE_ANON_KEY = import.meta.env.PUBLIC_SUPABASE_ANON_KEY;
const SERVICE_ROLE_KEY = import.meta.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY;

/**
 * Service-role client that bypasses RLS. Server-only — never import where it
 * could reach the browser. Used for admin tasks (card-login, return lookup).
 */
export function createSupabaseAdminClient() {
  return createClient(SUPABASE_URL, SERVICE_ROLE_KEY ?? "", {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

/**
 * Create a request-scoped Supabase client wired to Astro's cookies, so the
 * logged-in employee's session is read/refreshed and RLS applies to queries.
 */
export function createSupabaseServerClient(context: { request: Request; cookies: AstroCookies }) {
  return createServerClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    cookies: {
      getAll() {
        return parseCookieHeader(context.request.headers.get("Cookie") ?? "").map((c) => ({
          name: c.name,
          value: c.value ?? "",
        }));
      },
      setAll(cookiesToSet) {
        cookiesToSet.forEach(({ name, value, options }) => {
          context.cookies.set(name, value, options);
        });
      },
    },
  });
}
