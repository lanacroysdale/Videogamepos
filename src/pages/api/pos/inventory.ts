import type { APIRoute } from "astro";

export const prerender = false;
const json = (d: unknown, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { "content-type": "application/json" } });

export const POST: APIRoute = async ({ locals, request }) => {
  if (!locals.user) return json({ error: "unauthorized" }, 401);
  const b = await request.json().catch(() => ({}));
  const sb = locals.supabase;
  const uid = locals.user.id;

  // Log a receiving line onto an entry + the stock_movements ledger. Best-effort
  // by design: a logging hiccup must never lose the stock change itself. Only
  // OPEN entries accept lines — a committed entry's history is frozen (another
  // station may have finished it; see the client's stale-session recovery).
  const logReceive = async (entryId: string, variantId: string, qty: number, priceCents: number, unitCostCents: number | null, wasNew: boolean) => {
    if (!entryId || qty <= 0) return;
    const { data: entry } = await sb.from("inventory_entries").select("status").eq("id", entryId).maybeSingle();
    if (!entry || entry.status !== "open") return;
    await sb.from("inventory_entry_items").insert({
      entry_id: entryId, variant_id: variantId, qty_added: qty,
      unit_cost_cents: unitCostCents, price_cents_at_entry: priceCents, was_new_variant: wasNew,
    });
    await sb.from("stock_movements").insert({
      variant_id: variantId, delta: qty, reason: wasNew ? "initial" : "receive", channel: "in_store", employee_id: uid,
    });
  };

  switch (b.action) {
    // ---- Receiving entries (sessions) ----
    case "startEntry": {
      // Reuse the caller's newest open entry so refreshes don't orphan sessions.
      const { data: open } = await sb
        .from("inventory_entries").select("id, human_id")
        .eq("employee_id", uid).eq("status", "open")
        .order("created_at", { ascending: false }).limit(1).maybeSingle();
      if (open) return json({ ok: true, entry: open, resumed: true });
      const { data, error } = await sb
        .from("inventory_entries")
        .insert({ employee_id: uid, source: ["manual", "trade_in", "ebay_import", "adjustment"].includes(b.source) ? b.source : "manual", note: b.note ? String(b.note).slice(0, 300) : null })
        .select("id, human_id").single();
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true, entry: data, resumed: false });
    }
    case "receiveStock": {
      // Immediate quantity bump (quick adjust from the edit modal). With entry
      // DRAFTS this no longer requires a session — no entryId = bump + ledger
      // only; with an entryId it also logs a legacy (already-applied) line.
      const qty = Math.max(1, Math.round(Number(b.qtyAdded)) || 1);
      if (!b.variantId) return json({ error: "variantId required" }, 400);
      if (b.entryId) {
        const { data: entry } = await sb.from("inventory_entries").select("status").eq("id", b.entryId).maybeSingle();
        if (!entry || entry.status !== "open") return json({ error: "That entry is closed — start a new receiving session." }, 409);
      }
      const { data: v } = await sb.from("product_variants").select("id, price_cents").eq("id", b.variantId).maybeSingle();
      if (!v) return json({ error: "Variant not found." }, 404);
      // Atomic relative increment (RPC) — two stations receiving the same
      // variant concurrently must both land, matching the ledger they write.
      const { data: newQty, error } = await sb.rpc("receive_stock", { p_variant_id: b.variantId, p_qty: qty });
      if (error) return json({ error: error.message }, 500);
      const cost = b.unitCostCents == null ? null : Math.max(0, Math.round(Number(b.unitCostCents)) || 0);
      if (b.entryId) await logReceive(b.entryId, b.variantId, qty, v.price_cents ?? 0, cost, false);
      else await sb.from("stock_movements").insert({ variant_id: b.variantId, delta: qty, reason: "receive", channel: "in_store", employee_id: uid });
      return json({ ok: true, newQuantity: Number(newQty ?? 0) });
    }
    // ---- Entry DRAFTS (staged lines; nothing applies until commit) ----
    case "stageItem": {
      const qty = Math.max(1, Math.round(Number(b.qty)) || 1);
      if (!b.entryId || !b.variantId) return json({ error: "entryId and variantId required" }, 400);
      const { data: entry } = await sb.from("inventory_entries").select("status").eq("id", b.entryId).maybeSingle();
      if (!entry || entry.status !== "open") return json({ error: "That draft is closed — start a new entry." }, 409);
      const { data: v } = await sb.from("product_variants").select("id, price_cents").eq("id", b.variantId).maybeSingle();
      if (!v) return json({ error: "Variant not found." }, 404);
      const { data: item, error } = await sb.from("inventory_entry_items").insert({
        entry_id: b.entryId, variant_id: b.variantId, qty_added: qty,
        unit_cost_cents: b.unitCostCents == null ? null : Math.max(0, Math.round(Number(b.unitCostCents)) || 0),
        price_cents_at_entry: v.price_cents ?? 0, was_new_variant: !!b.wasNew,
        applied: false,
        // supplier column ships with 20260801000003 — key omitted unless sent
        ...(b.supplier ? { supplier: String(b.supplier).slice(0, 120) } : {}),
      }).select("id").single();
      if (error) return json({ error: /applied/.test(error.message) ? "Run migration 20260801000002_entry_drafts.sql first." : error.message }, 500);
      return json({ ok: true, itemId: item.id });
    }
    case "updateEntryItem": {
      if (!b.itemId) return json({ error: "itemId required" }, 400);
      const patch: Record<string, unknown> = {};
      if (b.qty != null) patch.qty_added = Math.max(1, Math.round(Number(b.qty)) || 1);
      if (b.unitCostCents !== undefined) patch.unit_cost_cents = b.unitCostCents == null ? null : Math.max(0, Math.round(Number(b.unitCostCents)) || 0);
      if (b.supplier !== undefined) patch.supplier = b.supplier ? String(b.supplier).slice(0, 120) : null;
      if (!Object.keys(patch).length) return json({ error: "Nothing to update" }, 400);
      // RLS only matches lines on OPEN entries — a frozen line comes back null.
      const { data, error } = await sb.from("inventory_entry_items").update(patch).eq("id", b.itemId).select("id").maybeSingle();
      if (error) return json({ error: error.message }, 500);
      if (!data) return json({ error: "That line is on a committed entry." }, 409);
      return json({ ok: true });
    }
    case "removeEntryItem": {
      if (!b.itemId) return json({ error: "itemId required" }, 400);
      const { data, error } = await sb.from("inventory_entry_items").delete().eq("id", b.itemId).select("id").maybeSingle();
      if (error) return json({ error: error.message }, 500);
      if (!data) return json({ error: "That line is on a committed entry." }, 409);
      return json({ ok: true });
    }
    case "setOrderTotal": {
      if (!b.entryId) return json({ error: "entryId required" }, 400);
      const cents = b.orderTotalCents == null ? null : Math.max(0, Math.round(Number(b.orderTotalCents)) || 0);
      const { data, error } = await sb.from("inventory_entries").update({ order_total_cents: cents }).eq("id", b.entryId).eq("status", "open").select("id").maybeSingle();
      if (error) return json({ error: error.message }, 500);
      if (!data) return json({ error: "Draft not found or already committed." }, 409);
      return json({ ok: true });
    }
    case "setEntrySupplier": {
      if (!b.entryId) return json({ error: "entryId required" }, 400);
      const { data, error } = await sb.from("inventory_entries")
        .update({ supplier: b.supplier ? String(b.supplier).slice(0, 120) : null })
        .eq("id", b.entryId).eq("status", "open").select("id").maybeSingle();
      if (error) return json({ error: error.message }, 500);
      if (!data) return json({ error: "Draft not found or already committed." }, 409);
      return json({ ok: true });
    }
    case "revertEntry": {
      // Delete a COMMITTED entry = reverse the stock it applied. Managers
      // only, ≤24h — the RPC re-enforces both; typed-DELETE UX is client-side.
      if (!b.entryId) return json({ error: "entryId required" }, 400);
      if (!locals.can("inventory.manage")) return json({ error: "You don't have permission for this inventory action." }, 403);
      const { data: reversed, error } = await sb.rpc("revert_entry", { p_entry_id: b.entryId });
      if (error) {
        const missing = (error as any).code === "PGRST202" || /could not find the function/i.test(error.message);
        return json({ error: missing ? "Run migration 20260801000003_entry_edit_sources.sql first." : error.message }, 400);
      }
      return json({ ok: true, reversed: Number(reversed ?? 0) });
    }
    case "addSupplierLink": {
      if (!locals.can("inventory.manage")) return json({ error: "You don't have permission for this inventory action." }, 403);
      if (!b.productId || !String(b.label ?? "").trim()) return json({ error: "Product and label required" }, 400);
      const url = b.url ? String(b.url).trim().slice(0, 500) : null;
      if (url && !/^https?:\/\//i.test(url)) return json({ error: "Links must start with http(s)://" }, 400);
      const { data, error } = await sb.from("product_suppliers")
        .insert({ product_id: b.productId, label: String(b.label).trim().slice(0, 120), url })
        .select("id, label, url").single();
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true, link: data });
    }
    case "deleteSupplierLink": {
      if (!locals.can("inventory.manage")) return json({ error: "You don't have permission for this inventory action." }, 403);
      if (!b.id) return json({ error: "id required" }, 400);
      const { error } = await sb.from("product_suppliers").delete().eq("id", b.id);
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true });
    }
    case "deleteEntry": {
      if (!b.entryId) return json({ error: "entryId required" }, 400);
      // Open drafts only (RLS enforces too); lines cascade with the entry.
      const { data, error } = await sb.from("inventory_entries").delete().eq("id", b.entryId).eq("status", "open").select("id").maybeSingle();
      if (error) return json({ error: error.message }, 500);
      if (!data) return json({ error: "Draft not found or already committed." }, 409);
      return json({ ok: true });
    }
    case "commitEntry": {
      if (!b.entryId) return json({ error: "entryId required" }, 400);
      // Drafts: commit_entry() applies staged lines (quantity + ledger) and
      // commits atomically. Pre-migration the function doesn't exist — fall
      // back to the legacy status flip (those entries applied at receive time).
      const { data: applied, error: rpcErr } = await sb.rpc("commit_entry", { p_entry_id: b.entryId });
      if (!rpcErr) return json({ ok: true, applied: Number(applied ?? 0) });
      // Only a genuinely MISSING function falls back to the legacy flip — any
      // other RPC failure must surface (a silent flip would commit a draft
      // without ever applying its stock).
      const rpcMissing = (rpcErr as any).code === "PGRST202" || /could not find the function/i.test(rpcErr.message);
      if (!rpcMissing) {
        return json({ error: rpcErr.message }, /already committed/i.test(rpcErr.message) ? 409 : 500);
      }
      const { data, error } = await sb
        .from("inventory_entries")
        .update({ status: "committed", committed_at: new Date().toISOString() })
        .eq("id", b.entryId).eq("status", "open").select("id").maybeSingle();
      if (error) return json({ error: error.message }, 500);
      if (!data) return json({ error: "Entry already committed." }, 409);
      return json({ ok: true, applied: 0 });
    }
    case "listEntries": {
      const { data, error } = await sb
        .from("inventory_entries")
        .select("id, human_id, source, status, note, created_at, committed_at, employee:profiles(full_name), inventory_entry_items(qty_added)")
        .order("created_at", { ascending: false })
        .limit(Math.min(100, Math.max(1, Math.round(Number(b.limit)) || 30)));
      if (error) return json({ error: error.message }, 500);
      const entries = (data ?? []).map((e: any) => ({
        id: e.id, humanId: e.human_id, source: e.source, status: e.status, note: e.note,
        createdAt: e.created_at, committedAt: e.committed_at,
        employee: e.employee?.full_name ?? "—",
        lineCount: (e.inventory_entry_items ?? []).length,
        unitCount: (e.inventory_entry_items ?? []).reduce((s: number, it: any) => s + (it.qty_added || 0), 0),
      }));
      return json({ ok: true, entries });
    }
    case "getEntry": {
      if (!b.entryId) return json({ error: "entryId required" }, 400);
      // label_code / order_total_cents / supplier ship in later migrations —
      // probe so these selects can't 400 pre-migration.
      const [{ error: lcErr }, { error: otErr }, { error: supErr }] = await Promise.all([
        sb.from("product_variants").select("label_code").limit(1),
        sb.from("inventory_entries").select("order_total_cents").limit(1),
        sb.from("inventory_entries").select("supplier").limit(1),
      ]);
      const lcCol = lcErr ? "" : ", label_code";
      const otCol = otErr ? "" : ", order_total_cents";
      const supCol = supErr ? "" : ", supplier";
      const [{ data: entry }, { data: items, error }] = await Promise.all([
        sb.from("inventory_entries").select(`id, human_id, source, status, note, created_at, committed_at${otCol}${supCol}, employee:profiles(full_name)`).eq("id", b.entryId).maybeSingle(),
        sb.from("inventory_entry_items")
          .select(`id, qty_added, unit_cost_cents, price_cents_at_entry, was_new_variant, created_at${supCol}, variant:product_variants(id, sku, internal_code${lcCol}, price_cents, quantity, completeness_code, grade_code, condition, inventory_type_id, location_id, product:products(title, platform, category:categories(name)))`)
          .eq("entry_id", b.entryId).order("created_at"),
      ]);
      if (!entry) return json({ error: "Entry not found." }, 404);
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true, entry, items: items ?? [] });
    }
    case "updateVariant": {
      const patch: Record<string, unknown> = {};
      if (b.priceCents != null) patch.price_cents = Math.max(0, Math.round(Number(b.priceCents)));
      if (b.quantity != null) patch.quantity = Math.max(0, Math.round(Number(b.quantity)));
      if (b.condition) patch.condition = String(b.condition).slice(0, 40);
      if (b.completeness !== undefined) patch.completeness = b.completeness || null;
      if (b.sku !== undefined) patch.sku = b.sku ? String(b.sku).slice(0, 60) : null;
      if (b.completenessCode !== undefined) patch.completeness_code = b.completenessCode || null;
      if (b.gradeCode !== undefined) patch.grade_code = b.gradeCode || null;
      if (b.onlineVisible !== undefined) patch.online_visible = !!b.onlineVisible;
      if (b.onlinePriceCents !== undefined)
        patch.online_price_cents = b.onlinePriceCents == null ? null : Math.max(0, Math.round(Number(b.onlinePriceCents)));
      if (b.inventoryTypeId) patch.inventory_type_id = String(b.inventoryTypeId);
      if (b.locationId !== undefined) patch.location_id = b.locationId || null;
      if (!Object.keys(patch).length) return json({ error: "Nothing to update" }, 400);
      const { error } = await sb.from("product_variants").update(patch).eq("id", b.id);
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true });
    }
    case "updateProduct": {
      const patch: Record<string, unknown> = {};
      if (b.title !== undefined) {
        if (!String(b.title).trim()) return json({ error: "Title is required" }, 400);
        patch.title = String(b.title).trim().slice(0, 200);
      }
      if (b.platform !== undefined) patch.platform = b.platform || null;
      if (b.franchise !== undefined) patch.franchise = b.franchise || null;
      if (b.genre !== undefined) patch.genre = b.genre || null;
      if (b.categoryId !== undefined) patch.category_id = b.categoryId || null;
      if (b.description !== undefined) patch.description = b.description || null;
      if (b.imageUrl !== undefined) patch.image_url = b.imageUrl || null;
      if (!Object.keys(patch).length) return json({ error: "Nothing to update" }, 400);
      const { error } = await sb.from("products").update(patch).eq("id", b.id);
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true });
    }
    case "addBarcode": {
      if (!b.variantId || !String(b.barcode ?? "").trim()) return json({ error: "Variant and barcode required" }, 400);
      const { data, error } = await sb
        .from("product_barcodes")
        .insert({ variant_id: b.variantId, barcode: String(b.barcode).trim(), label: b.label || null })
        .select()
        .single();
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true, barcode: data });
    }
    case "removeBarcode": {
      const { error } = await sb.from("product_barcodes").delete().eq("id", b.id);
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true });
    }
    case "addProduct": {
      if (!String(b.title ?? "").trim() || !b.categoryId) return json({ error: "Title and category required" }, 400);
      const slug = String(b.title).trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
      const { data: prod, error: pErr } = await sb
        .from("products")
        .insert({ title: String(b.title).trim(), platform: b.platform || null, franchise: b.franchise || null, category_id: b.categoryId, slug })
        .select()
        .single();
      if (pErr) return json({ error: pErr.message }, 500);
      const { data: variant, error: vErr } = await sb
        .from("product_variants")
        .insert({
          product_id: prod.id,
          condition: b.condition || "Used",
          completeness_code: b.completenessCode || null,
          grade_code: b.gradeCode || null,
          price_cents: Math.max(0, Math.round(Number(b.priceCents)) || 0),
          // Staged onto a draft → the variant starts at qty 0 (invisible to the
          // website's qty>0 filters) and the qty lands when the draft commits.
          quantity: b.stageEntryId ? 0 : Math.max(0, Math.round(Number(b.quantity)) || 0),
          sku: b.sku || null,
          barcode: b.barcode || null,
          // Keys OMITTED when absent (pre-migration PostgREST rejects unknown
          // columns outright); omitted → the DB trigger defaults to Retail.
          ...(b.inventoryTypeId ? { inventory_type_id: b.inventoryTypeId } : {}),
          ...(b.locationId ? { location_id: b.locationId } : {}),
        })
        .select()
        .single();
      if (vErr) return json({ error: vErr.message }, 500);
      if (b.stageEntryId) {
        const { data: st, error: stErr } = await sb.from("inventory_entry_items").insert({
          entry_id: b.stageEntryId, variant_id: variant.id,
          qty_added: Math.max(1, Math.round(Number(b.quantity)) || 1),
          unit_cost_cents: b.unitCostCents == null ? null : Math.max(0, Math.round(Number(b.unitCostCents)) || 0),
          price_cents_at_entry: variant.price_cents ?? 0, was_new_variant: true, applied: false,
        }).select("id").single();
        if (stErr) return json({ error: stErr.message }, 500);
        return json({ ok: true, productId: prod.id, variantId: variant.id, internalCode: variant.internal_code ?? "", itemId: st.id });
      }
      if (b.entryId && variant.quantity > 0) {
        await logReceive(b.entryId, variant.id, variant.quantity, variant.price_cents ?? 0,
          b.unitCostCents == null ? null : Math.max(0, Math.round(Number(b.unitCostCents)) || 0), true);
      }
      return json({ ok: true, productId: prod.id, variantId: variant.id, internalCode: variant.internal_code ?? "" });
    }
    case "addVariant": {
      if (!b.productId) return json({ error: "productId required" }, 400);
      const { data, error } = await sb
        .from("product_variants")
        .insert({
          product_id: b.productId,
          condition: b.condition || "Used",
          completeness_code: b.completenessCode || null,
          grade_code: b.gradeCode || null,
          price_cents: Math.max(0, Math.round(Number(b.priceCents)) || 0),
          quantity: b.stageEntryId ? 0 : Math.max(0, Math.round(Number(b.quantity)) || 0),
          ...(b.inventoryTypeId ? { inventory_type_id: b.inventoryTypeId } : {}),
          ...(b.locationId ? { location_id: b.locationId } : {}),
        })
        .select("id, internal_code, quantity, price_cents")
        .single();
      if (error) return json({ error: error.message }, 500);
      if (b.stageEntryId) {
        const { data: st, error: stErr } = await sb.from("inventory_entry_items").insert({
          entry_id: b.stageEntryId, variant_id: data.id,
          qty_added: Math.max(1, Math.round(Number(b.quantity)) || 1),
          unit_cost_cents: b.unitCostCents == null ? null : Math.max(0, Math.round(Number(b.unitCostCents)) || 0),
          price_cents_at_entry: data.price_cents ?? 0, was_new_variant: true, applied: false,
        }).select("id").single();
        if (stErr) return json({ error: stErr.message }, 500);
        return json({ ok: true, variant: data, itemId: st.id });
      }
      if (b.entryId && data.quantity > 0) {
        await logReceive(b.entryId, data.id, data.quantity, data.price_cents ?? 0,
          b.unitCostCents == null ? null : Math.max(0, Math.round(Number(b.unitCostCents)) || 0), true);
      }
      return json({ ok: true, variant: data });
    }
    case "bulkSetOnline": {
      // Publish/unpublish many products at once (all of their variants).
      const ids = Array.isArray(b.productIds) ? b.productIds.filter(Boolean) : [];
      if (!ids.length) return json({ error: "No items selected" }, 400);
      const { data, error } = await sb
        .from("product_variants")
        .update({ online_visible: !!b.online })
        .in("product_id", ids)
        .select("id");
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true, updated: data?.length ?? 0 });
    }
    case "bulkDelete": {
      // Soft-delete: stamp deleted_at → items move to "Recently deleted" for
      // 7 days (restorable), then the inventory page purges them permanently.
      if (!locals.can("inventory.manage")) return json({ error: "You don't have permission for this inventory action." }, 403);
      const ids = Array.isArray(b.productIds) ? b.productIds.filter(Boolean) : [];
      if (!ids.length) return json({ error: "No items selected" }, 400);
      const { error } = await sb.from("products").update({ deleted_at: new Date().toISOString() }).in("id", ids);
      if (error) {
        return json({ error: /deleted_at/.test(error.message) ? "Database migration needed first (product_soft_delete) — run npx supabase db push." : error.message }, 500);
      }
      // A deleted item must never sell: pull it off the website immediately.
      await sb.from("product_variants").update({ online_visible: false }).in("product_id", ids);
      return json({ ok: true, deleted: ids.length });
    }
    case "bulkRestore": {
      if (!locals.can("inventory.manage")) return json({ error: "You don't have permission for this inventory action." }, 403);
      const ids = Array.isArray(b.productIds) ? b.productIds.filter(Boolean) : [];
      if (!ids.length) return json({ error: "No items selected" }, 400);
      // Comes back unpublished (variants stayed online_visible=false) — staff
      // republish deliberately after checking the listing over.
      const { error } = await sb.from("products").update({ deleted_at: null }).in("id", ids);
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true, restored: ids.length });
    }
    case "repriceProduct": {
      // Condition-pricing engine: re-price the product's other conditions from
      // this one. Gated server-side by store_settings.condition_pricing_enabled.
      if (!b.variantId) return json({ error: "variantId required" }, 400);
      const { data, error } = await sb.rpc("reprice_product", { p_variant_id: b.variantId });
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true, updated: data ?? [] });
    }
    default:
      return json({ error: "Unknown action" }, 400);
  }
};
