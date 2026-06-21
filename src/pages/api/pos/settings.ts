import type { APIRoute } from "astro";
import { createSupabaseAdminClient } from "../../../lib/supabase";
import { THEME_KEYS } from "../../../lib/themeSettings";

export const prerender = false;
const json = (d: unknown, s = 200) =>
  new Response(JSON.stringify(d), { status: s, headers: { "content-type": "application/json" } });

// Save store settings (the low-stock badge config, etc.) into the
// store_settings.settings jsonb. Managers/owners only.
export const POST: APIRoute = async ({ locals, request }) => {
  if (!locals.user) return json({ error: "unauthorized" }, 401);
  if (!["owner", "manager"].includes(locals.profile?.role ?? "")) return json({ error: "Managers only" }, 403);

  const b = await request.json().catch(() => ({}));
  const admin = createSupabaseAdminClient();
  const { data: cur } = await admin.from("store_settings").select("settings").eq("id", 1).maybeSingle();
  const settings: Record<string, unknown> = { ...(cur?.settings ?? {}) };

  if (b.lowStockEnabled !== undefined) settings.lowStockEnabled = !!b.lowStockEnabled;
  if (b.lowStockThreshold !== undefined) settings.lowStockThreshold = Math.max(0, Math.round(Number(b.lowStockThreshold)) || 0);
  if (b.lowStockMinPriceCents !== undefined) settings.lowStockMinPriceCents = Math.max(0, Math.round(Number(b.lowStockMinPriceCents)) || 0);
  if (b.lowStockHoverOnly !== undefined) settings.lowStockHoverOnly = !!b.lowStockHoverOnly;
  if (b.freeShipEnabled !== undefined) settings.freeShipEnabled = !!b.freeShipEnabled;
  if (b.freeShipThresholdCents !== undefined) settings.freeShipThresholdCents = Math.max(0, Math.round(Number(b.freeShipThresholdCents)) || 0);
  if (b.defaultTheme !== undefined) settings.defaultTheme = THEME_KEYS.includes(String(b.defaultTheme)) ? String(b.defaultTheme) : "default";
  if (b.gemEffectEnabled !== undefined) settings.gemEffectEnabled = !!b.gemEffectEnabled;

  const { error } = await admin.from("store_settings").update({ settings }).eq("id", 1);
  if (error) return json({ error: error.message }, 500);
  return json({ ok: true, settings });
};
