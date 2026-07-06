import type { APIRoute } from "astro";
import { createSupabaseAdminClient } from "../../../lib/supabase";
import { barSettings, withinClosingWindow } from "../../../lib/barSettings";
import { autoCloseOpenTabs } from "../../../lib/tabs";

export const prerender = false;
const json = (d: unknown, s = 200) =>
  new Response(JSON.stringify(d), { status: s, headers: { "content-type": "application/json" } });

// Nightly auto-close of bar tabs left open at closing time. Vercel Cron hits this
// hourly (vercel.json) with `Authorization: Bearer ${CRON_SECRET}`; the handler
// only sweeps when Portland-local time is within the post-closing window, so an
// hourly schedule fires a few runs right after close and never during the day.
// This is the backstop — the manager "Close out all" button is the precise control.
export const GET: APIRoute = async ({ request }) => {
  const secret = import.meta.env.CRON_SECRET;
  if (!secret) return json({ error: "CRON_SECRET not configured" }, 503);
  if (request.headers.get("authorization") !== `Bearer ${secret}`) return json({ error: "unauthorized" }, 401);

  const admin = createSupabaseAdminClient();
  const { data: row } = await admin.from("store_settings").select("settings").eq("id", 1).maybeSingle();
  const bs = barSettings(row?.settings);

  if (!bs.tabClosingTime) return json({ ok: true, skipped: "no closing time set" });
  if (!withinClosingWindow(bs.tabClosingTime, new Date())) return json({ ok: true, skipped: "outside closing window" });

  const res = await autoCloseOpenTabs(admin, {
    gratuityPercent: bs.tabAutoGratuityEnabled ? bs.tabAutoGratuityPercent : 0,
    note: "Auto-closed at closing",
  });
  return json({ ok: true, ...res });
};
