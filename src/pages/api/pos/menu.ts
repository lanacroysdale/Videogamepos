import type { APIRoute } from "astro";
import { createSupabaseAdminClient } from "../../../lib/supabase";

export const prerender = false;
const json = (d: unknown, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { "content-type": "application/json" } });
// Cap at $999,999.99 and reject non-finite (e.g. "1e308" → Infinity, "1e10" → absurd).
const cents = (d: any) => { const n = Math.round(Number(d) * 100); return Number.isFinite(n) && n > 0 ? Math.min(n, 99_999_999) : 0; };
const int = (d: any, def = 0) => { const n = Math.round(Number(d)); return Number.isFinite(n) ? n : def; };
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

// Bar / F&B menu builder. Managers/owners only (write); the public QR menu reads
// server-side via the service-role client elsewhere. Uses "replace children" on
// save so an item carries its sizes + attached modifier groups in one call.
export const POST: APIRoute = async ({ locals, request }) => {
  if (!locals.user) return json({ error: "unauthorized" }, 401);
  if (!["owner", "manager"].includes(locals.profile?.role ?? "")) return json({ error: "Managers only" }, 403);

  const admin = createSupabaseAdminClient();
  const b = await request.json().catch(() => ({} as any));
  const a = b.action;
  const uid = locals.user.id;
  const fail = (e: any) => json({ error: e?.message || "Save failed" }, 500);

  // ---- Sections ----
  if (a === "section-save") {
    const name = String(b.name ?? "").trim();
    if (!name) return json({ error: "Section name is required" }, 400);
    const row = { name: name.slice(0, 80), sort_order: int(b.sortOrder), is_active: b.isActive === undefined ? true : !!b.isActive };
    if (b.id) { const { error } = await admin.from("menu_sections").update(row).eq("id", b.id); return error ? fail(error) : json({ ok: true }); }
    const { data, error } = await admin.from("menu_sections").insert(row).select("id").single();
    return error ? fail(error) : json({ ok: true, id: data.id });
  }
  if (a === "section-delete") {
    if (!b.id) return json({ error: "id required" }, 400);
    const { error } = await admin.from("menu_sections").delete().eq("id", b.id); // items keep, section_id → null
    return error ? fail(error) : json({ ok: true });
  }

  // ---- Items (+ sizes + attached modifier groups) ----
  if (a === "item-save") {
    const name = String(b.name ?? "").trim();
    if (!name) return json({ error: "Item name is required" }, 400);
    const row: Record<string, unknown> = {
      section_id: b.sectionId || null,
      name: name.slice(0, 120),
      description: b.description ? String(b.description).slice(0, 1000) : null,
      base_price_cents: cents(b.basePrice),
      cost_cents: cents(b.cost),
      is_available: b.isAvailable === undefined ? true : !!b.isAvailable,
      online_orderable: b.onlineOrderable === undefined ? true : !!b.onlineOrderable,
      abv: b.abv === "" || b.abv == null || !Number.isFinite(Number(b.abv)) ? null : clamp(Number(b.abv), 0, 100),
      tags: Array.isArray(b.tags) ? b.tags.map((t: any) => String(t).trim()).filter(Boolean).slice(0, 20) : [],
      sort_order: int(b.sortOrder),
      updated_at: new Date().toISOString(),
    };
    let itemId = b.id as string | undefined;
    if (itemId) {
      const { error } = await admin.from("menu_items").update(row).eq("id", itemId);
      if (error) return fail(error);
    } else {
      const { data, error } = await admin.from("menu_items").insert({ ...row, created_by: uid }).select("id").single();
      if (error) return fail(error);
      itemId = data.id;
    }
    // Replace sizes.
    await admin.from("menu_item_sizes").delete().eq("menu_item_id", itemId);
    const sizes = (Array.isArray(b.sizes) ? b.sizes : [])
      .map((s: any, i: number) => ({ menu_item_id: itemId, label: String(s?.label ?? "").trim().slice(0, 60), price_cents: cents(s?.price), is_default: !!s?.isDefault, is_available: s?.isAvailable === undefined ? true : !!s?.isAvailable, sort_order: i }))
      .filter((s: any) => s.label);
    if (sizes.length) { const { error } = await admin.from("menu_item_sizes").insert(sizes); if (error) return fail(error); }
    // Replace attached modifier groups.
    await admin.from("menu_item_modifier_groups").delete().eq("menu_item_id", itemId);
    const groupIds = [...new Set((Array.isArray(b.groupIds) ? b.groupIds : []).map((g: any) => String(g)))];
    if (groupIds.length) {
      const links = groupIds.map((gid, i) => ({ menu_item_id: itemId, group_id: gid, sort_order: i }));
      const { error } = await admin.from("menu_item_modifier_groups").insert(links);
      if (error) return fail(error);
    }
    return json({ ok: true, id: itemId });
  }
  if (a === "item-delete") {
    if (!b.id) return json({ error: "id required" }, 400);
    const { error } = await admin.from("menu_items").delete().eq("id", b.id); // cascades sizes + links
    return error ? fail(error) : json({ ok: true });
  }

  // ---- Reusable modifier groups (+ options) ----
  if (a === "group-save") {
    const name = String(b.name ?? "").trim();
    if (!name) return json({ error: "Group name is required" }, 400);
    const max = b.maxSelect === "" || b.maxSelect == null ? null : clamp(int(b.maxSelect, 1), 1, 99);
    const row = { name: name.slice(0, 80), min_select: clamp(int(b.minSelect), 0, 99), max_select: max, sort_order: int(b.sortOrder) };
    let groupId = b.id as string | undefined;
    if (groupId) { const { error } = await admin.from("menu_modifier_groups").update(row).eq("id", groupId); if (error) return fail(error); }
    else { const { data, error } = await admin.from("menu_modifier_groups").insert(row).select("id").single(); if (error) return fail(error); groupId = data.id; }
    // Replace options.
    await admin.from("menu_modifier_options").delete().eq("group_id", groupId);
    const opts = (Array.isArray(b.options) ? b.options : [])
      .map((o: any, i: number) => ({ group_id: groupId, name: String(o?.name ?? "").trim().slice(0, 80), price_delta_cents: cents(o?.priceDelta), is_default: !!o?.isDefault, is_available: o?.isAvailable === undefined ? true : !!o?.isAvailable, sort_order: i }))
      .filter((o: any) => o.name);
    if (opts.length) { const { error } = await admin.from("menu_modifier_options").insert(opts); if (error) return fail(error); }
    return json({ ok: true, id: groupId });
  }
  if (a === "group-delete") {
    if (!b.id) return json({ error: "id required" }, 400);
    const { error } = await admin.from("menu_modifier_groups").delete().eq("id", b.id); // cascades options + item links
    return error ? fail(error) : json({ ok: true });
  }

  // ---- Quick 86 toggle (item or option) ----
  if (a === "set-available") {
    const table = b.kind === "option" ? "menu_modifier_options" : b.kind === "size" ? "menu_item_sizes" : "menu_items";
    if (!b.id) return json({ error: "id required" }, 400);
    const { error } = await admin.from(table).update({ is_available: !!b.available }).eq("id", b.id);
    return error ? fail(error) : json({ ok: true });
  }

  return json({ error: "Unknown action" }, 400);
};
