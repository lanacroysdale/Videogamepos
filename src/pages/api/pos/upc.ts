import type { APIRoute } from "astro";
import { createSupabaseAdminClient } from "../../../lib/supabase";
import { fetchAll } from "../../../lib/fetchAll";
import { fillListingUpcs, attachUpcs, upcTablesReady, needingUpc } from "../../../lib/upcFinder";
import { canonicalUpc } from "../../../lib/upcMatch";

export const prerender = false;
const json = (d: unknown, s = 200) =>
  new Response(JSON.stringify(d), { status: s, headers: { "content-type": "application/json" } });

// Listing UPCs.
//   { action: "fill", productIds (≤5), force? } → look them up on eBay's catalog
//       and save what's found (force = look again even if it has one; managers).
//   { action: "missing" } → listings that still need one (managers; the
//       "Fill missing UPCs" button then fills them a few at a time).
//   { action: "add", productId, upc } → a UPC typed or scanned by staff.
//   { action: "remove", id } → managers; an automatic UPC removed by hand is
//       never auto-filled again for that listing ("rejected").
export const POST: APIRoute = async ({ locals, request }) => {
  if (!locals.user || !locals.profile) return json({ error: "unauthorized" }, 401);
  const b = await request.json().catch(() => ({}));
  const admin = createSupabaseAdminClient();
  const manager = locals.can("inventory.manage");
  if (!(await upcTablesReady(admin)))
    return json({ error: "Run supabase/migrations/20260930000003_listing_upcs.sql in the Supabase SQL editor first." }, 400);

  try {
    if (b.action === "fill") {
      const ids: string[] = Array.isArray(b.productIds) ? b.productIds.filter((x: unknown) => typeof x === "string").slice(0, 5) : [];
      if (!ids.length) return json({ error: "productIds required" }, 400);
      if (b.force && !manager) return json({ error: "Managers only" }, 403);
      const r = await fillListingUpcs(admin, { productIds: ids, force: !!b.force });
      return json({ ok: true, ...r });
    }

    if (b.action === "missing") {
      if (!manager) return json({ error: "Managers only" }, 403);
      const { data, error } = await fetchAll((from, to) => admin.from("products")
        .select("id, title, platform, upc_status, upc_checked_at, category:categories(name), product_upcs(id)")
        .is("deleted_at", null).order("id").range(from, to));
      if (error) return json({ error: error.message }, 500);
      // A run started by hand re-tries anything not looked at in the last day
      // (the daily trickle waits longer), except UPCs a manager rejected.
      const day = Date.now() - 86_400_000;
      const stale = (p: any) => p.upc_status !== "rejected" && p.upc_checked_at && new Date(p.upc_checked_at).getTime() < day;
      const todo = needingUpc((data || []).map((p: any) => (stale(p) ? { ...p, upc_checked_at: null } : p)));
      return json({ ok: true, items: todo.map((p: any) => ({ id: p.id, title: p.title, platform: p.platform })) });
    }

    if (b.action === "add") {
      const upc = canonicalUpc(b.upc);
      if (!b.productId) return json({ error: "productId required" }, 400);
      if (!upc) return json({ error: "That isn't a valid UPC — check the digits (the last one is a check digit)." }, 400);
      const { added, conflicts } = await attachUpcs(admin, b.productId, [upc], "manual", null);
      if (conflicts.length) return json({ error: `UPC ${conflicts[0]}.` }, 409);
      await admin.from("products").update({ upc_status: "found", upc_checked_at: new Date().toISOString() }).eq("id", b.productId);
      const { data: all } = await admin.from("product_upcs").select("id, upc, source").eq("product_id", b.productId).order("created_at");
      return json({ ok: true, added: added[0] ?? null, upcs: all || [] });
    }

    if (b.action === "remove") {
      if (!manager) return json({ error: "Managers only" }, 403);
      const { data: row } = await admin.from("product_upcs").select("id, product_id, source").eq("id", b.id).maybeSingle();
      if (!row) return json({ ok: true, upcs: [] });
      await admin.from("product_upcs").delete().eq("id", row.id);
      const { data: all } = await admin.from("product_upcs").select("id, upc, source").eq("product_id", row.product_id).order("created_at");
      // Removing an automatic match means it was wrong: don't re-add it.
      if (row.source === "ebay" && !(all || []).length)
        await admin.from("products").update({ upc_status: "rejected", upc_checked_at: new Date().toISOString() }).eq("id", row.product_id);
      return json({ ok: true, upcs: all || [] });
    }

    return json({ error: "Unknown action" }, 400);
  } catch (e: any) {
    return json({ error: e?.message || "UPC lookup failed" }, 500);
  }
};
