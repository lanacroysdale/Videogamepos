import type { APIRoute } from "astro";
import { createSupabaseAdminClient } from "../../../lib/supabase";
import { THEME_KEYS, SIDEBAR_KEYS } from "../../../lib/themeSettings";
import { AI_PROVIDERS, AI_QUALITIES } from "../../../lib/ai";

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
  if (b.defaultSidebar !== undefined) settings.defaultSidebar = SIDEBAR_KEYS.includes(String(b.defaultSidebar)) ? String(b.defaultSidebar) : "default";
  if (b.themePosOnly !== undefined) settings.themePosOnly = !!b.themePosOnly;
  if (b.gemEffectEnabled !== undefined) settings.gemEffectEnabled = !!b.gemEffectEnabled;
  if (b.aiDescriptionPrompt !== undefined) settings.aiDescriptionPrompt = String(b.aiDescriptionPrompt).slice(0, 4000);
  if (b.notifyTaskComplete !== undefined) settings.notifyTaskComplete = !!b.notifyTaskComplete;
  if (b.menuEnabled !== undefined) settings.menuEnabled = !!b.menuEnabled;
  if (b.tabClosingTime !== undefined) settings.tabClosingTime = /^([01]\d|2[0-3]):[0-5]\d$/.test(String(b.tabClosingTime)) ? String(b.tabClosingTime) : "";
  if (b.tabAutoGratuityEnabled !== undefined) settings.tabAutoGratuityEnabled = !!b.tabAutoGratuityEnabled;
  if (b.tabAutoGratuityPercent !== undefined) settings.tabAutoGratuityPercent = Math.max(0, Math.min(100, Math.round(Number(b.tabAutoGratuityPercent)) || 0));
  if (b.leadNotifyEnabled !== undefined) settings.leadNotifyEnabled = !!b.leadNotifyEnabled;
  if (b.leadNotifyEmail !== undefined) settings.leadNotifyEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(b.leadNotifyEmail).trim()) ? String(b.leadNotifyEmail).trim().slice(0, 200) : "";
  if (b.aiProvider !== undefined && AI_PROVIDERS.some((p) => p.key === String(b.aiProvider))) settings.aiProvider = String(b.aiProvider);
  if (b.aiQuality !== undefined && AI_QUALITIES.some((q) => q.key === String(b.aiQuality))) settings.aiQuality = String(b.aiQuality);

  const { error } = await admin.from("store_settings").update({ settings }).eq("id", 1);
  if (error) return json({ error: error.message }, 500);
  return json({ ok: true, settings });
};
