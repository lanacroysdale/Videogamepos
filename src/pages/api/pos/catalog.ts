import type { APIRoute } from "astro";
import { loadPosCatalog } from "../../../lib/posCatalog";
import { loadRegions } from "../../../lib/regions";

export const prerender = false;

// Fresh checkout catalog for a station that has been open a while (the page
// embeds a snapshot at render time). Same rows the page renders with, plus the
// region list (badges / chips pick up a region edit — or the migration — too).
export const GET: APIRoute = async ({ locals }) => {
  if (!locals.user) return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: { "content-type": "application/json" } });
  const [catalog, regions] = await Promise.all([loadPosCatalog(locals.supabase), loadRegions(locals.supabase)]);
  return new Response(JSON.stringify({ ok: true, catalog, regions }), {
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
};
