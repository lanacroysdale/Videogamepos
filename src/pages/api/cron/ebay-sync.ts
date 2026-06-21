import type { APIRoute } from "astro";
import { createSupabaseAdminClient } from "../../../lib/supabase";
import { ebayConfigured } from "../../../lib/ebay";
import { syncEbayStock } from "../../../lib/ebaySync";

export const prerender = false;
const json = (d: unknown, s = 200) =>
  new Response(JSON.stringify(d), { status: s, headers: { "content-type": "application/json" } });

// Scheduled eBay stock sync. Vercel Cron hits this with a GET and the
// `Authorization: Bearer ${CRON_SECRET}` header (set CRON_SECRET in Vercel +
// reference it in vercel.json). This route is OUTSIDE /api/pos so the auth
// middleware lets it through; the secret is the gate.
export const GET: APIRoute = async ({ request }) => {
  const secret = import.meta.env.CRON_SECRET;
  if (!secret) return json({ error: "CRON_SECRET not configured" }, 503);
  if (request.headers.get("authorization") !== `Bearer ${secret}`)
    return json({ error: "unauthorized" }, 401);
  if (!ebayConfigured()) return json({ error: "eBay not configured" }, 400);

  const result = await syncEbayStock(createSupabaseAdminClient());
  return json({ ok: true, ...result });
};
