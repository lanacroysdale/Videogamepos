import type { APIRoute } from "astro";
import { createSupabaseAdminClient } from "../../../lib/supabase";
import { ebayConfigured } from "../../../lib/ebay";
import { syncEbayStock } from "../../../lib/ebaySync";
import { fillListingUpcs, upcTablesReady } from "../../../lib/upcFinder";

export const prerender = false;
const json = (d: unknown, s = 200) =>
  new Response(JSON.stringify(d), { status: s, headers: { "content-type": "application/json" } });

// Leave room under the function's time limit (300s on Vercel with Fluid
// Compute) for the response; the UPC trickle stops starting lookups after this.
const BUDGET_MS = 200_000;

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

  const t0 = Date.now();
  const admin = createSupabaseAdminClient();
  const result = await syncEbayStock(admin);
  // Then a daily trickle of listing UPCs from eBay's catalog (the Hobby plan
  // allows only two crons, so it rides along here). Its own failure must
  // never hide the stock sync's result.
  let upc: Record<string, unknown> = { skipped: "migration not applied" };
  try {
    if (await upcTablesReady(admin)) {
      const r = await fillListingUpcs(admin, { deadline: t0 + BUDGET_MS, max: 150 });
      const count = (s: string) => r.results.filter((x) => x.status === s).length;
      upc = { tried: r.results.length, found: count("found"), notFound: count("not_found"), unsure: count("ambiguous") + count("conflict"), errors: count("error"), stopped: r.stopped ?? null };
    }
  } catch (e: any) { upc = { error: String(e?.message || e) }; }
  return json({ ok: true, ...result, upc });
};
