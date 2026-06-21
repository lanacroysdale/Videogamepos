import type { APIRoute } from "astro";
import { createSupabaseServerClient } from "../../lib/supabase";

export const prerender = false;

// Lightweight "is the owner signed in?" probe used by the floating owner toolbar
// on BOTH the public marketing pages (static — no middleware) and the POS app.
// Returns only the current session's own role/name — no privileged data.
export const GET: APIRoute = async (context) => {
  const json = (d: unknown) =>
    new Response(JSON.stringify(d), {
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    });
  try {
    const supabase = createSupabaseServerClient(context);
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return json({ role: null });
    const { data: profile } = await supabase
      .from("profiles")
      .select("role, full_name")
      .eq("id", user.id)
      .maybeSingle();
    return json({ role: profile?.role ?? null, name: profile?.full_name ?? null });
  } catch {
    return json({ role: null });
  }
};
