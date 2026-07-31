import type { APIRoute } from "astro";
import { createSupabaseAdminClient } from "../../../lib/supabase";

export const prerender = false;
const json = (d: unknown, s = 200) =>
  new Response(JSON.stringify(d), { status: s, headers: { "content-type": "application/json" } });

// Inventory TYPES + LOCATIONS config — managers/owners (operational config, not
// the owner-locked departments treatment). Writes go through the service-role
// client after the role check; RLS blocks direct authenticated writes.
const slugify = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40) || "type";

export const GET: APIRoute = async ({ locals }) => {
  if (!locals.user) return json({ error: "unauthorized" }, 401);
  if (!["owner", "manager"].includes(locals.profile?.role ?? "")) return json({ error: "Managers only" }, 403);
  const admin = createSupabaseAdminClient();
  const [{ data: types }, { data: locations }] = await Promise.all([
    admin.from("store_inventory_types").select("*").order("sort_order").order("name"),
    admin.from("store_locations").select("*").order("sort_order").order("name"),
  ]);
  return json({ ok: true, types: types ?? [], locations: locations ?? [] });
};

export const POST: APIRoute = async ({ locals, request }) => {
  if (!locals.user) return json({ error: "unauthorized" }, 401);
  if (!["owner", "manager"].includes(locals.profile?.role ?? "")) return json({ error: "Managers only" }, 403);

  const admin = createSupabaseAdminClient();
  const b = await request.json().catch(() => ({} as any));
  const a = b.action;
  const fail = (e: any) => json({ error: e?.message || "Failed" }, 500);

  // ---- Inventory types ----
  if (a === "saveType") {
    const name = String(b.name ?? "").trim().slice(0, 60);
    if (!name) return json({ error: "Type name is required" }, 400);
    const fields: Record<string, unknown> = {
      name,
      icon: b.icon ? String(b.icon).slice(0, 8) : null,
      color: b.color ? String(b.color).slice(0, 16) : null,
      allow_website_sync: b.allowWebsiteSync === undefined ? true : !!b.allowWebsiteSync,
      block_at_checkout: !!b.blockAtCheckout,
    };
    // Only touch sort_order when the caller sent one — the edit modal doesn't,
    // and clobbering it to 0 would reshuffle every type list.
    if (b.sortOrder !== undefined && Number.isFinite(Number(b.sortOrder))) fields.sort_order = Math.round(Number(b.sortOrder));
    if (b.id) {
      const { error } = await admin.from("store_inventory_types").update(fields).eq("id", b.id);
      return error ? fail(error) : json({ ok: true });
    }
    if (fields.sort_order === undefined) fields.sort_order = 0;
    // New type — derive a unique key.
    let key = slugify(b.key || name);
    const { data: keys } = await admin.from("store_inventory_types").select("key");
    const taken = new Set((keys ?? []).map((k: any) => k.key));
    if (taken.has(key)) { let i = 2; while (taken.has(`${key}_${i}`)) i++; key = `${key}_${i}`; }
    const { data, error } = await admin.from("store_inventory_types").insert({ ...fields, key, is_system: false }).select("id").single();
    return error ? fail(error) : json({ ok: true, id: data.id });
  }

  // Quick toggle for the expo switch (also reachable via saveType).
  if (a === "setTypeFlag") {
    if (!b.id || !["allow_website_sync", "block_at_checkout"].includes(String(b.flag))) return json({ error: "id + flag required" }, 400);
    const { error } = await admin.from("store_inventory_types").update({ [String(b.flag)]: !!b.value }).eq("id", b.id);
    return error ? fail(error) : json({ ok: true });
  }

  if (a === "deleteType") {
    if (!b.id) return json({ error: "id required" }, 400);
    const { data: t } = await admin.from("store_inventory_types").select("is_system, name").eq("id", b.id).maybeSingle();
    if (!t) return json({ error: "Type not found." }, 404);
    if (t.is_system) return json({ error: "Core inventory types can't be deleted." }, 400);
    const { count } = await admin.from("product_variants").select("id", { count: "exact", head: true }).eq("inventory_type_id", b.id);
    if ((count ?? 0) > 0) return json({ error: `${count} item(s) still use “${t.name}” — reassign them first.` }, 409);
    const { error } = await admin.from("store_inventory_types").delete().eq("id", b.id);
    return error ? fail(error) : json({ ok: true });
  }

  // ---- Locations ----
  if (a === "saveLocation") {
    const name = String(b.name ?? "").trim().slice(0, 60);
    const key = String(b.key ?? "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6);
    if (!name || !key) return json({ error: "Location needs a name and a short code (e.g. PDX)." }, 400);
    if (b.id) {
      const { error } = await admin.from("store_locations").update({ name, key }).eq("id", b.id);
      return error ? fail(error) : json({ ok: true });
    }
    const { count: locCount } = await admin.from("store_locations").select("id", { count: "exact", head: true });
    const { data, error } = await admin.from("store_locations")
      .insert({ name, key, is_default: (locCount ?? 0) === 0 }) // first location becomes the default
      .select("id").single();
    return error ? fail(error) : json({ ok: true, id: data.id });
  }

  if (a === "deleteLocation") {
    if (!b.id) return json({ error: "id required" }, 400);
    const { data: loc } = await admin.from("store_locations").select("is_default").eq("id", b.id).maybeSingle();
    if (!loc) return json({ error: "Location not found." }, 404);
    const { count } = await admin.from("store_locations").select("id", { count: "exact", head: true });
    if (loc.is_default && (count ?? 0) > 1) return json({ error: "Set another location as the default first." }, 409);
    const { error } = await admin.from("store_locations").delete().eq("id", b.id); // variants keep, location_id → null
    return error ? fail(error) : json({ ok: true });
  }

  if (a === "setDefaultLocation") {
    if (!b.id) return json({ error: "id required" }, 400);
    // Confirm the target still exists BEFORE clearing the old default (a stale
    // tab pointing at a deleted location must not leave the store default-less).
    const { data: target } = await admin.from("store_locations").select("id").eq("id", b.id).maybeSingle();
    if (!target) return json({ error: "That location no longer exists — refresh the page." }, 404);
    await admin.from("store_locations").update({ is_default: false }).eq("is_default", true);
    const { data: set, error } = await admin.from("store_locations").update({ is_default: true }).eq("id", b.id).select("id");
    if (error) return fail(error);
    if (!set || set.length === 0) return json({ error: "That location no longer exists — refresh the page." }, 404);
    return json({ ok: true });
  }

  // ---- Ordering (shared) ----
  if (a === "reorderTypes" || a === "reorderLocations") {
    const table = a === "reorderTypes" ? "store_inventory_types" : "store_locations";
    const ids: string[] = Array.isArray(b.ids) ? b.ids : [];
    for (let i = 0; i < ids.length; i++) await admin.from(table).update({ sort_order: i }).eq("id", ids[i]);
    return json({ ok: true });
  }

  return json({ error: "Unknown action" }, 400);
};
