import type { APIRoute } from "astro";
import { createSupabaseAdminClient } from "../../../lib/supabase";
import { sanitizeSaved } from "../../../lib/labelMaker";

export const prerender = false;
const json = (d: unknown, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { "content-type": "application/json" } });

// Label maker — saved labels ("Includes IPS Screen Mod"…), shared by every
// station: store_settings.settings.labelMakerSaved. Any staff member may save
// or remove one (they're print shortcuts, not store settings).
//   { action: "save", label }  → adds it (same text + size replaces), newest first
//   { action: "delete", id }   → removes it
export const POST: APIRoute = async ({ locals, request }) => {
  if (!locals.user) return json({ error: "unauthorized" }, 401);
  const b = await request.json().catch(() => ({} as any));
  const admin = createSupabaseAdminClient();
  const { data: cur, error: rErr } = await admin.from("store_settings").select("settings").eq("id", 1).maybeSingle();
  if (rErr) return json({ error: rErr.message }, 500);
  const settings = { ...((cur as any)?.settings ?? {}) };
  let saved = sanitizeSaved(settings.labelMakerSaved);

  if (b.action === "save") {
    const [label] = sanitizeSaved([{ ...(b.label ?? {}), id: Math.random().toString(36).slice(2, 10) }]);
    if (!label) return json({ error: "Type something first." }, 400);
    saved = [label, ...saved.filter((s) => !(s.text === label.text && s.sizeKey === label.sizeKey && s.landscape === label.landscape))].slice(0, 60);
  } else if (b.action === "delete") {
    saved = saved.filter((s) => s.id !== String(b.id ?? ""));
  } else return json({ error: "Unknown action" }, 400);

  settings.labelMakerSaved = saved;
  const { error } = await admin.from("store_settings").update({ settings }).eq("id", 1);
  if (error) return json({ error: error.message }, 500);
  return json({ ok: true, saved });
};
