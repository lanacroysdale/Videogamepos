import type { APIRoute } from "astro";
import { loadPosCatalog } from "../../../lib/posCatalog";

export const prerender = false;

// Fresh checkout catalog for a station that has been open a while (the page
// embeds a snapshot at render time). Same rows the page renders with.
export const GET: APIRoute = async ({ locals }) => {
  if (!locals.user) return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: { "content-type": "application/json" } });
  const catalog = await loadPosCatalog(locals.supabase);
  return new Response(JSON.stringify({ ok: true, catalog }), {
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
};
