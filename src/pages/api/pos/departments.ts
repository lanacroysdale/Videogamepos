import type { APIRoute } from "astro";
import { createSupabaseAdminClient } from "../../../lib/supabase";

export const prerender = false;
const json = (d: unknown, s = 200) =>
  new Response(JSON.stringify(d), { status: s, headers: { "content-type": "application/json" } });

// Business departments (the POS spine) are GOVERNED: owner-only, and locked in
// normal operation. Editing requires unlocking, which needs the owner and — if
// the licensor (TimeLag) provisions a LICENSE_UNLOCK_CODE — that company code too.
// All ops use the service-role admin client AFTER an in-code owner check.

const VALID_KINDS = ["retail", "food_bev", "arcade", "service", "other"];
const slugify = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40) || "dept";

export const GET: APIRoute = async ({ locals }) => {
  if (!locals.user) return json({ error: "unauthorized" }, 401);
  if (!locals.can("departments.manage")) return json({ error: "You don't have permission to manage departments" }, 403);
  const admin = createSupabaseAdminClient();
  const { data: depts } = await admin.from("store_departments").select("*").order("sort_order").order("name");
  const { data: ss } = await admin.from("store_settings").select("settings").eq("id", 1).maybeSingle();
  return json({ ok: true, departments: depts ?? [], locked: (ss?.settings as any)?.departmentsLocked === true });
};

export const POST: APIRoute = async ({ locals, request }) => {
  if (!locals.user) return json({ error: "unauthorized" }, 401);
  if (!locals.can("departments.manage")) return json({ error: "You don't have permission to manage departments" }, 403);

  const admin = createSupabaseAdminClient();
  const b = await request.json().catch(() => ({} as any));
  const a = b.action;
  const fail = (e: any) => json({ error: e?.message || "Failed" }, 500);

  const { data: ss } = await admin.from("store_settings").select("settings").eq("id", 1).maybeSingle();
  const settings: Record<string, unknown> = { ...(ss?.settings ?? {}) };
  const locked = settings.departmentsLocked === true;

  // ---- Lock / unlock (governance) ----
  if (a === "lock") {
    settings.departmentsLocked = true;
    const { error } = await admin.from("store_settings").update({ settings }).eq("id", 1);
    return error ? fail(error) : json({ ok: true, locked: true });
  }
  if (a === "unlock") {
    const code = import.meta.env.LICENSE_UNLOCK_CODE;
    if (code && String(b.code ?? "") !== String(code)) {
      return json({ error: "Company authorization code is required to unlock." }, 403);
    }
    settings.departmentsLocked = false;
    const { error } = await admin.from("store_settings").update({ settings }).eq("id", 1);
    return error ? fail(error) : json({ ok: true, locked: false });
  }

  // ---- Edits below require the config to be unlocked ----
  if (locked) return json({ error: "Departments are locked. Unlock to edit." }, 409);

  if (a === "save") {
    const name = String(b.name ?? "").trim().slice(0, 60);
    if (!name) return json({ error: "Department name is required" }, 400);
    const fields = {
      name,
      kind: VALID_KINDS.includes(String(b.kind)) ? String(b.kind) : "other",
      icon: b.icon ? String(b.icon).slice(0, 8) : null,
      color: b.color ? String(b.color).slice(0, 16) : null,
      is_enabled: b.isEnabled === undefined ? true : !!b.isEnabled,
      sort_order: Number.isFinite(Number(b.sortOrder)) ? Math.round(Number(b.sortOrder)) : 0,
    };
    if (b.id) {
      // System (seeded) departments can be renamed/recolored/toggled but keep
      // their key + kind so reports + gating stay stable.
      const { data: existing } = await admin.from("store_departments").select("is_system").eq("id", b.id).maybeSingle();
      const upd = existing?.is_system
        ? { name: fields.name, icon: fields.icon, color: fields.color, is_enabled: fields.is_enabled, sort_order: fields.sort_order }
        : fields;
      const { error } = await admin.from("store_departments").update(upd).eq("id", b.id);
      return error ? fail(error) : json({ ok: true });
    }
    // New department — derive a unique key.
    let key = slugify(b.key || name);
    const { data: keys } = await admin.from("store_departments").select("key");
    const taken = new Set((keys ?? []).map((k: any) => k.key));
    if (taken.has(key)) { let i = 2; while (taken.has(`${key}_${i}`)) i++; key = `${key}_${i}`; }
    const { data, error } = await admin.from("store_departments").insert({ ...fields, key, is_system: false }).select("id").single();
    return error ? fail(error) : json({ ok: true, id: data.id });
  }

  if (a === "set-enabled") {
    if (!b.id) return json({ error: "id required" }, 400);
    const { error } = await admin.from("store_departments").update({ is_enabled: !!b.enabled }).eq("id", b.id);
    return error ? fail(error) : json({ ok: true });
  }

  if (a === "delete") {
    if (!b.id) return json({ error: "id required" }, 400);
    const { data: dep } = await admin.from("store_departments").select("is_system").eq("id", b.id).maybeSingle();
    if (dep?.is_system) return json({ error: "Core departments can't be deleted — disable them instead." }, 400);
    const { error } = await admin.from("store_departments").delete().eq("id", b.id);
    return error ? fail(error) : json({ ok: true });
  }

  if (a === "reorder") {
    const ids: string[] = Array.isArray(b.ids) ? b.ids : [];
    for (let i = 0; i < ids.length; i++) await admin.from("store_departments").update({ sort_order: i }).eq("id", ids[i]);
    return json({ ok: true });
  }

  return json({ error: "Unknown action" }, 400);
};
