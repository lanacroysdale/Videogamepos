import type { APIRoute } from "astro";
import { createSupabaseServerClient, createSupabaseAdminClient } from "../../lib/supabase";
import { can, loadRoles } from "../../lib/permissions";

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
      .select("*") // "*" so this still works before the removed_at migration is applied
      .eq("id", user.id)
      .maybeSingle();
    if (!profile || profile.removed_at) return json({ role: null });
    const { roles } = await loadRoles(createSupabaseAdminClient());
    // `elevated` = may open Settings; that is what the toolbar keys off.
    return json({ role: profile.role, name: profile.full_name, elevated: can(profile, roles, "settings.manage") });
  } catch {
    return json({ role: null });
  }
};
