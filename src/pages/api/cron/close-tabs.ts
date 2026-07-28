import type { APIRoute } from "astro";
import { createSupabaseAdminClient } from "../../../lib/supabase";
import { barSettings } from "../../../lib/barSettings";
import { autoCloseOpenTabs } from "../../../lib/tabs";

export const prerender = false;
const json = (d: unknown, s = 200) =>
  new Response(JSON.stringify(d), { status: s, headers: { "content-type": "application/json" } });

// Daily auto-close of bar tabs left open overnight. Vercel Cron hits this ONCE a
// day in the early morning (vercel.json — the free/Hobby plan allows only one cron
// run per day) with `Authorization: Bearer ${CRON_SECRET}`, sweeping any tab still
// open from the night before. The manager "Close out all" button is the precise,
// in-shift control; this is just the safety net.
export const GET: APIRoute = async ({ request }) => {
  const secret = import.meta.env.CRON_SECRET;
  if (!secret) return json({ error: "CRON_SECRET not configured" }, 503);
  if (request.headers.get("authorization") !== `Bearer ${secret}`) return json({ error: "unauthorized" }, 401);

  const admin = createSupabaseAdminClient();
  const { data: row } = await admin.from("store_settings").select("settings").eq("id", 1).maybeSingle();
  const bs = barSettings(row?.settings);

  // Opt-in: a store turns on overnight auto-close by setting a closing time.
  if (!bs.tabClosingTime) return json({ ok: true, skipped: "auto-close disabled (no closing time set)" });

  const res = await autoCloseOpenTabs(admin, {
    gratuityPercent: bs.tabAutoGratuityEnabled ? bs.tabAutoGratuityPercent : 0,
    note: "Auto-closed overnight",
  });
  return json({ ok: true, ...res });
};
