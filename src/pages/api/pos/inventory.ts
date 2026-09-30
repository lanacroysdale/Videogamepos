import type { APIRoute } from "astro";

export const prerender = false;

// Thrown by the atomic stager when another attempt already staged the row.
class AlreadyStaged extends Error {
  constructor(public prev: { item_id: string; variant_id: string; product_id: string; created: string }) { super("already staged"); }
}
const json = (d: unknown, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { "content-type": "application/json" } });
const isDate = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && !isNaN(Date.parse(v));

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

  // /shop/<slug> looks the slug up with maybeSingle(), so it MUST be unique:
  // "mario-kart-64", else "…-<platform>", else a numeric suffix.
  const slugify = (t: string) => t.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const uniqueSlug = async (title: string, platform: string | null) => {
    const base = slugify(title) || "item";
    const alt = platform ? slugify(`${title} ${platform}`) : "";
    // Both prefixes: the alt slug ("item-nintendo-ds") need not start with base.
    // (Slugs are [a-z0-9-] only, so they're safe inside the or() filter.)
    const { data } = await sb.from("products").select("slug").or(alt ? `slug.like.${base}%,slug.like.${alt}%` : `slug.like.${base}%`);
    const taken = new Set((data ?? []).map((r: any) => r.slug));
    if (!taken.has(base)) return base;
    if (alt && !taken.has(alt)) return alt;
    for (let i = 2; ; i++) if (!taken.has(`${alt || base}-${i}`)) return `${alt || base}-${i}`;
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
      // received_on (migration 20260924000002): the client sends its local
      // date — the server runs UTC, which is "tomorrow" on a Portland evening.
      const { error: roErr } = await sb.from("inventory_entries").select("received_on").limit(1);
      const receivedOn = !roErr && isDate(b.receivedOn) ? { received_on: b.receivedOn } : {};
      const { data, error } = await sb
        .from("inventory_entries")
        .insert({ employee_id: uid, source: ["manual", "trade_in", "ebay_import", "adjustment"].includes(b.source) ? b.source : "manual", note: b.note ? String(b.note).slice(0, 300) : null, ...receivedOn })
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
    case "importStage": {
      // Bulk stage from a collection CSV (PriceCharting export etc.). Rows are
      // already RESOLVED client-side (existing variant / new variant on a
      // listing / new product); this just writes them onto the open draft.
      // Nothing applies to stock until the draft is finished. Per-row errors
      // come back in `results` so one bad line never aborts the batch.
      if (!b.entryId || !Array.isArray(b.rows)) return json({ error: "entryId and rows required" }, 400);
      const { data: entry } = await sb.from("inventory_entries").select("status").eq("id", b.entryId).maybeSingle();
      if (!entry || entry.status !== "open") return json({ error: "That draft is closed — start a new entry." }, 409);
      const rows = b.rows.slice(0, 40);
      const { data: existingLines } = await sb.from("inventory_entry_items").select("id, variant_id, qty_added, unit_cost_cents").eq("entry_id", b.entryId);
      const lineByVariant = new Map<string, { id: string; qty: number; cost: number | null }>();
      for (const l of existingLines ?? []) lineByVariant.set(l.variant_id, { id: l.id, qty: l.qty_added, cost: l.unit_cost_cents ?? null });
      // Idempotency (migration 20260929000001): every sheet row carries a stable
      // importKey. A retried batch whose first attempt DID land (response lost)
      // replays those rows instead of staging them twice. Pre-migration: off.
      const { error: keysErr } = await sb.from("inventory_entry_import_keys").select("import_key").limit(1);
      // Is the atomic stager installed (migration 20260929000002)? A call with
      // null args fails on the NOT NULL key — any error but "no such function"
      // means it exists. Nothing is written either way.
      let useRpc = false;
      if (!keysErr && rows.some((r: any) => r?.importKey)) {
        const { error: rpcErr } = await sb.rpc("stage_import_line", { p_entry: null, p_key: null, p_variant: null, p_product: null, p_created: null, p_qty: null, p_cost: null, p_price: null, p_was_new: null });
        useRpc = !rpcErr || !["PGRST202", "42883"].includes(rpcErr.code);
      }
      let rowKey = ""; // the current row's import key while the atomic path stages it
      let lastAlready = 0; // …and how many of its copies were already staged
      const { error: delErr } = await sb.from("products").select("deleted_at").limit(1);
      // Listings created in THIS request, by the client's group ref, so a Loose +
      // CIB pair of a brand-new game lands on ONE listing even within a batch.
      const createdByRef = new Map<string, string>();
      const cents = (v: unknown) => (v == null || v === "" ? null : Math.max(0, Math.round(Number(v)) || 0));
      const qtyOf = (v: unknown) => Math.max(1, Math.round(Number(v)) || 1);
      const tagPc = async (productId: string, pcId: string) => {
        // Remember the PriceCharting id on the listing so re-imports match exactly.
        const tag = `pricecharting:${String(pcId).slice(0, 40)}`;
        const { data: p } = await sb.from("products").select("tags").eq("id", productId).maybeSingle();
        const tags: string[] = Array.isArray(p?.tags) ? p!.tags : [];
        // First id wins — an employee mapping a PAL row onto the NTSC listing
        // must not re-tag it (client only sends this when the listing has none).
        if (!tags.some((t) => t.startsWith("pricecharting:"))) await sb.from("products").update({ tags: [...tags, tag] }).eq("id", productId);
      };
      // Stage a line, or bump the variant's line already on this draft (cost =
      // weighted average across the copies; whichever is known if only one is).
      const stageOrMerge = async (variantId: string, priceCents: number, qty: number, cost: number | null, wasNew: boolean, productId: string, created: "" | "product" | "variant") => {
        if (useRpc && rowKey) {
          // Claim key + insert/merge line + record, in ONE transaction
          // (migration 20260929000002) — a timeout can't leave it half done.
          const { data, error } = await sb.rpc("stage_import_line", {
            p_entry: b.entryId, p_key: rowKey, p_variant: variantId, p_product: productId, p_created: created,
            p_qty: qty, p_cost: cost, p_price: priceCents, p_was_new: wasNew,
          });
          if (error) throw new Error(error.code === "23505" ? "This row is being imported by another request — try again in a minute." : error.message);
          if (data?.replay) throw new AlreadyStaged(data);
          lastAlready = Number(data.already) || 0; // copies of this row already on the draft
          return { itemId: data.item_id as string, merged: !!data.merged };
        }
        const had = lineByVariant.get(variantId);
        if (had) {
          const newCost = cost == null ? had.cost : had.cost == null ? cost : Math.round((had.cost * had.qty + cost * qty) / (had.qty + qty));
          const { data, error } = await sb.from("inventory_entry_items").update({ qty_added: had.qty + qty, unit_cost_cents: newCost }).eq("id", had.id).select("id").maybeSingle();
          if (error) throw new Error(error.message);
          // RLS only matches lines on OPEN drafts — another station finished it.
          if (!data) throw new Error("That draft was finished on another station — nothing was added.");
          had.qty += qty; had.cost = newCost;
          return { itemId: had.id, merged: true };
        }
        const { data: st, error } = await sb.from("inventory_entry_items").insert({
          entry_id: b.entryId, variant_id: variantId, qty_added: qty, unit_cost_cents: cost,
          price_cents_at_entry: priceCents, was_new_variant: wasNew, applied: false,
        }).select("id").single();
        if (error) throw new Error(error.message);
        lineByVariant.set(variantId, { id: st.id, qty, cost });
        return { itemId: st.id as string, merged: false };
      };
      // Same condition + grade (+ inventory type) already on the listing? A
      // stale catalog on the client (another station just added it) must not
      // create a duplicate stock row.
      const findVariant = async (productId: string, v: { completeness_code: string | null; grade_code: string | null; inventory_type_id?: string }) => {
        let q = sb.from("product_variants").select("id, internal_code, price_cents").eq("product_id", productId);
        q = v.completeness_code ? q.eq("completeness_code", v.completeness_code) : q.is("completeness_code", null);
        q = v.grade_code ? q.eq("grade_code", v.grade_code) : q.is("grade_code", null);
        if (v.inventory_type_id) q = q.eq("inventory_type_id", v.inventory_type_id);
        const { data } = await q.limit(1);
        return data?.[0] ?? null;
      };
      // A live (not soft-deleted) listing with exactly this title + platform.
      const findListing = async (title: string, platform: string | null) => {
        let q = sb.from("products").select("id").eq("title", title);
        q = platform ? q.eq("platform", platform) : q.is("platform", null);
        if (!delErr) q = q.is("deleted_at", null);
        const { data } = await q.limit(1);
        return (data?.[0]?.id as string | undefined) ?? null;
      };
      const processRow = async (r: any): Promise<{ res: any; created: "" | "product" | "variant" }> => {
        const qty = qtyOf(r.qty), cost = cents(r.costCents);
        if (r.kind === "variant") {
          if (!r.variantId) throw new Error("variantId required");
          const { data: v } = await sb.from("product_variants").select("id, price_cents, product_id, internal_code").eq("id", r.variantId).maybeSingle();
          if (!v) throw new Error("Variant not found");
          const st = await stageOrMerge(v.id, v.price_cents ?? 0, qty, cost, false, v.product_id, "");
          if (r.tagPcId && r.productId) await tagPc(r.productId, r.tagPcId).catch(() => {});
          return { res: { ok: true, itemId: st.itemId, variantId: v.id, productId: v.product_id, internalCode: v.internal_code ?? "", merged: st.merged }, created: "" };
        }
        const variantRow = {
          condition: String(r.condition || "Used").slice(0, 40),
          completeness_code: r.completenessCode || null,
          grade_code: r.gradeCode || null,
          price_cents: cents(r.priceCents) ?? 0,
          quantity: 0, // staged → lands on Finish
          barcode: r.barcode ? String(r.barcode).slice(0, 40) : null,
          ...(r.inventoryTypeId ? { inventory_type_id: String(r.inventoryTypeId) } : {}),
          ...(r.locationId ? { location_id: r.locationId } : {}),
        };
        // Put the row on `productId`: its matching stock row if one exists,
        // else a new one.
        const onListing = async (productId: string, reused: boolean) => {
          const existing = await findVariant(productId, variantRow);
          if (existing) {
            const st = await stageOrMerge(existing.id, existing.price_cents ?? 0, qty, cost, false, productId, "");
            return { res: { ok: true, itemId: st.itemId, variantId: existing.id, productId, internalCode: existing.internal_code ?? "", merged: st.merged, reusedListing: reused }, created: "" as const };
          }
          const { data: v, error } = await sb.from("product_variants").insert({ product_id: productId, ...variantRow })
            .select("id, internal_code, price_cents").single();
          if (error) throw new Error(error.message);
          const st = await stageOrMerge(v.id, v.price_cents ?? 0, qty, cost, true, productId, "variant");
          return { res: { ok: true, itemId: st.itemId, variantId: v.id, productId, internalCode: v.internal_code ?? "", newVariant: true, reusedListing: reused }, created: "variant" as const };
        };
        if (r.kind === "newVariant") {
          let productId = r.productId || (r.productRef ? createdByRef.get(String(r.productRef)) : "");
          // Its listing may have been created in an EARLIER attempt (the ref row
          // replayed or failed after staging) — find it by title + platform.
          if (!productId && r.productRef && r.title) productId = (await findListing(String(r.title).trim().slice(0, 200), r.platform ? String(r.platform).slice(0, 80) : null)) ?? "";
          if (!productId) throw new Error(r.productRef ? "Its listing wasn't created (see the row it shares a listing with)" : "productId required");
          const out = await onListing(productId, false);
          if (r.tagPcId) await tagPc(productId, r.tagPcId).catch(() => {});
          return out;
        }
        if (r.kind === "newProduct") {
          const title = String(r.title ?? "").trim().slice(0, 200);
          const platform = r.platform ? String(r.platform).slice(0, 80) : null;
          if (!title || !r.categoryId) throw new Error("Title and category required");
          // Same title + platform already listed (catalog on the client was
          // stale)? Use it — one game, one listing.
          const sameId = await findListing(title, platform);
          if (sameId) {
            if (r.ref) createdByRef.set(String(r.ref), sameId);
            if (r.tagPcId) await tagPc(sameId, r.tagPcId).catch(() => {});
            return onListing(sameId, true);
          }
          const { data: prod, error: pErr } = await sb.from("products").insert({
            title, platform, category_id: r.categoryId, slug: await uniqueSlug(title, platform),
            ...(r.tagPcId ? { tags: [`pricecharting:${String(r.tagPcId).slice(0, 40)}`] } : {}),
          }).select("id, slug").single();
          if (pErr) throw new Error(pErr.message);
          if (r.ref) createdByRef.set(String(r.ref), prod.id);
          const { data: v, error: vErr } = await sb.from("product_variants").insert({ product_id: prod.id, ...variantRow })
            .select("id, internal_code, price_cents").single();
          if (vErr) throw new Error(vErr.message);
          const st = await stageOrMerge(v.id, v.price_cents ?? 0, qty, cost, true, prod.id, "product");
          return { res: { ok: true, itemId: st.itemId, variantId: v.id, productId: prod.id, slug: prod.slug, internalCode: v.internal_code ?? "", newProduct: true }, created: "product" };
        }
        throw new Error("Unknown row kind");
      };
      const results: any[] = [];
      // The row was staged by an earlier attempt: report it, don't redo it.
      const pushReplay = async (r: any, prev: { item_id: string; variant_id: string; product_id: string; created: string }) => {
        if (r.ref && prev.product_id) createdByRef.set(String(r.ref), prev.product_id); // its productRef partners still resolve
        const [{ data: pv }, { data: pp }] = await Promise.all([
          sb.from("product_variants").select("internal_code").eq("id", prev.variant_id).maybeSingle(),
          sb.from("products").select("slug").eq("id", prev.product_id).maybeSingle(),
        ]);
        results.push({ ok: true, replay: true, itemId: prev.item_id, variantId: prev.variant_id, productId: prev.product_id, slug: pp?.slug ?? "", internalCode: pv?.internal_code ?? "", newProduct: prev.created === "product", newVariant: prev.created === "variant" });
      };
      for (const r of rows) {
        const key = !keysErr && r.importKey ? String(r.importKey).slice(0, 200) : "";
        let claimed = false;
        rowKey = ""; lastAlready = 0;
        try {
          if (key && useRpc) {
            // Every copy (<key>#1…#qty) already staged? Replay without touching
            // listings. Otherwise stage_import_line claims + stages + records
            // only the copies that are new, in one transaction.
            const qty = qtyOf(r.qty);
            const { data: done } = await sb.from("inventory_entry_import_keys").select("import_key, item_id, variant_id, product_id, created")
              .eq("entry_id", b.entryId).in("import_key", Array.from({ length: qty }, (_, k) => `${key}#${k + 1}`));
            const first = (done ?? []).find((d: any) => d.import_key === `${key}#1`);
            if ((done ?? []).length === qty && (done ?? []).every((d: any) => d.item_id) && first) { await pushReplay(r, first); continue; }
            rowKey = key;
            const { res } = await processRow(r);
            if (lastAlready) res.already = lastAlready;
            results.push(res);
            continue;
          }
          if (key) {
            const { data: done } = await sb.from("inventory_entry_import_keys").select("item_id, variant_id, product_id, created").eq("entry_id", b.entryId).eq("import_key", key).maybeSingle();
            if (done?.item_id) { await pushReplay(r, done); continue; }
            // Fallback (pre-20260929000002): claim first; a unique violation = in flight or stale.
            const claim = () => sb.from("inventory_entry_import_keys").insert({ entry_id: b.entryId, import_key: key });
            let { error: claimErr } = await claim();
            if (claimErr) {
              if (claimErr.code !== "23505") throw new Error(claimErr.message);
              const { data: prev } = await sb.from("inventory_entry_import_keys").select("item_id, variant_id, product_id, created, created_at").eq("entry_id", b.entryId).eq("import_key", key).maybeSingle();
              if (prev?.item_id) { await pushReplay(r, prev); continue; }
              // Claimed but never finished. Still running on another request
              // (under 2 min) → wait; older = that request died → take it over.
              if (prev && Date.now() - new Date(prev.created_at).getTime() < 120_000) throw new Error("This row is still being imported — try again in a minute.");
              if (prev) await sb.from("inventory_entry_import_keys").delete().eq("entry_id", b.entryId).eq("import_key", key).is("item_id", null);
              ({ error: claimErr } = await claim());
              if (claimErr) throw new Error(claimErr.code === "23505" ? "This row is being imported by another request — try again in a minute." : claimErr.message);
            }
            claimed = true;
          }
          const { res, created } = await processRow(r);
          if (claimed) {
            // Record what the row became; retry once — an unrecorded claim would
            // block (then, after 2 min, re-stage) this row on a later attempt.
            const record = () => sb.from("inventory_entry_import_keys").update({ item_id: res.itemId, variant_id: res.variantId, product_id: res.productId, created }).eq("entry_id", b.entryId).eq("import_key", key);
            const { error: recErr } = await record();
            if (recErr) await record();
          }
          results.push(res);
        } catch (e: any) {
          // Another request finished this exact row first (atomic path).
          if (e instanceof AlreadyStaged) { await pushReplay(r, e.prev); continue; }
          // Release the claim so a retry can stage the row.
          if (claimed) await sb.from("inventory_entry_import_keys").delete().eq("entry_id", b.entryId).eq("import_key", key);
          results.push({ ok: false, error: e?.message || "Failed" });
        }
      }
      return json({ ok: true, results, idempotent: !keysErr, atomic: useRpc });
    }
    case "setEntryLineCondition": {
      // Change a STAGED line's completeness / grade. The line moves to the
      // matching stock row on the same listing (existing, or a new one) — it
      // never rewrites a stock row that holds other copies. A row this draft
      // created just for this line (nothing else uses it) is renamed in place,
      // or removed once the line has moved off it.
      // Each step is ONE statement, checked, in an order that stays correct if
      // "Finish" lands in between: the line either moves (then Finish applies it
      // to the new row) or the move is refused (then nothing else happens). No
      // line merging — two lines for one stock row are fine (each applies).
      if (!b.itemId) return json({ error: "itemId required" }, 400);
      const comp = b.completenessCode ? String(b.completenessCode) : null;
      const grade = b.gradeCode ? String(b.gradeCode) : null;
      const label = String(b.condition || "Used").slice(0, 40);
      const { data: line } = await sb.from("inventory_entry_items")
        .select("id, entry_id, variant_id, was_new_variant, applied, entry:inventory_entries(status)")
        .eq("id", b.itemId).maybeSingle();
      if (!line) return json({ error: "Line not found." }, 404);
      const closed = "That draft was finished — the line wasn't changed.";
      if ((line as any).entry?.status !== "open" || line.applied) return json({ error: closed }, 409);
      const { data: old } = await sb.from("product_variants")
        .select("id, product_id, completeness_code, grade_code, price_cents, quantity, inventory_type_id, location_id, barcode")
        .eq("id", line.variant_id).maybeSingle();
      if (!old) return json({ error: "Stock row not found." }, 404);
      if ((old.completeness_code ?? null) === comp && (old.grade_code ?? null) === grade) return json({ ok: true, mode: "unchanged", variantId: old.id });
      // Disposable = created for this line and used by nothing else.
      const [{ count: otherLines }, { count: sales }] = await Promise.all([
        sb.from("inventory_entry_items").select("id", { count: "exact", head: true }).eq("variant_id", old.id).neq("id", line.id),
        sb.from("transaction_items").select("id", { count: "exact", head: true }).eq("variant_id", old.id),
      ]);
      const disposable = !!line.was_new_variant && (old.quantity ?? 0) === 0 && !otherLines && !sales;
      let tq = sb.from("product_variants").select("id, price_cents, internal_code, barcode").eq("product_id", old.product_id).neq("id", old.id);
      tq = comp ? tq.eq("completeness_code", comp) : tq.is("completeness_code", null);
      tq = grade ? tq.eq("grade_code", grade) : tq.is("grade_code", null);
      if (old.inventory_type_id) tq = tq.eq("inventory_type_id", old.inventory_type_id);
      const { data: tgs } = await tq.limit(1);
      const target = tgs?.[0];
      if (!target && disposable) {
        // Rename the row in place — one statement; the line keeps pointing at it.
        const { data: rn, error } = await sb.from("product_variants").update({ completeness_code: comp, grade_code: grade, condition: label })
          .eq("id", old.id).eq("quantity", 0).select("id").maybeSingle();
        if (error) return json({ error: error.message }, 500);
        if (!rn) return json({ error: closed }, 409);
        return json({ ok: true, mode: "renamed", variantId: old.id, productId: old.product_id });
      }
      let dest = target;
      let created = false;
      if (!dest) {
        const { data: nv, error } = await sb.from("product_variants").insert({
          product_id: old.product_id, condition: label, completeness_code: comp, grade_code: grade,
          price_cents: old.price_cents ?? 0, quantity: 0,
          ...(old.inventory_type_id ? { inventory_type_id: old.inventory_type_id } : {}),
          ...(old.location_id ? { location_id: old.location_id } : {}),
        }).select("id, price_cents, internal_code, barcode").single();
        if (error) return json({ error: error.message }, 500);
        dest = nv; created = true;
      }
      // THE move — a single, checked statement (RLS + the open-draft trigger
      // refuse it once the draft is finished).
      const { data: moved, error: mErr } = await sb.from("inventory_entry_items")
        .update({ variant_id: dest!.id, was_new_variant: created, price_cents_at_entry: dest!.price_cents ?? 0 })
        .eq("id", line.id).eq("applied", false).select("id").maybeSingle();
      if (mErr || !moved) {
        if (created) await sb.from("product_variants").delete().eq("id", dest!.id).eq("quantity", 0); // undo the empty row
        return json({ error: mErr?.message || closed }, mErr ? 500 : 409);
      }
      // After a confirmed move: tidy up (safe in any order vs Finish).
      await sb.from("inventory_entry_import_keys").update({ variant_id: dest!.id }).eq("item_id", line.id);
      let removedVariantId: string | null = null;
      let movedBarcodes: string[] = [];
      if (disposable) {
        // Its barcodes (e.g. the sheet's UPC) follow the copy to its new stock row.
        const { data: mb } = await sb.from("product_barcodes").update({ variant_id: dest!.id }).eq("variant_id", old.id).select("barcode");
        movedBarcodes = (mb ?? []).map((x: any) => x.barcode);
        if (old.barcode && !dest!.barcode) await sb.from("product_variants").update({ barcode: old.barcode }).eq("id", dest!.id).is("barcode", null);
        const { data: gone } = await sb.from("product_variants").delete().eq("id", old.id).eq("quantity", 0).select("id");
        if (gone?.length) removedVariantId = old.id;
      }
      return json({ ok: true, mode: created ? "created" : "moved", variantId: dest!.id, productId: old.product_id,
        internalCode: dest!.internal_code ?? "", priceCents: dest!.price_cents ?? 0, removedVariantId,
        primaryBarcode: disposable && old.barcode && !dest!.barcode ? old.barcode : dest!.barcode ?? null, movedBarcodes });
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
    case "setEntryReceivedOn": {
      if (!b.entryId) return json({ error: "entryId required" }, 400);
      if (!isDate(b.receivedOn)) return json({ error: "Pick a valid date." }, 400);
      const { data, error } = await sb.from("inventory_entries")
        .update({ received_on: b.receivedOn })
        .eq("id", b.entryId).eq("status", "open").select("id").maybeSingle();
      if (error) return json({ error: /received_on/.test(error.message) ? "Run supabase/migrations/20260924000002_entry_received_on.sql in the Supabase SQL editor first." : error.message }, 500);
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
      const [{ error: lcErr }, { error: otErr }, { error: supErr }, { error: roErr }] = await Promise.all([
        sb.from("product_variants").select("label_code").limit(1),
        sb.from("inventory_entries").select("order_total_cents").limit(1),
        sb.from("inventory_entries").select("supplier").limit(1),
        sb.from("inventory_entries").select("received_on").limit(1),
      ]);
      const lcCol = lcErr ? "" : ", label_code";
      const otCol = otErr ? "" : ", order_total_cents";
      const supCol = supErr ? "" : ", supplier";
      const roCol = roErr ? "" : ", received_on";
      const [{ data: entry }, { data: items, error }] = await Promise.all([
        sb.from("inventory_entries").select(`id, human_id, source, status, note, created_at, committed_at${otCol}${supCol}${roCol}, employee:profiles(full_name)`).eq("id", b.entryId).maybeSingle(),
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
      const slug = await uniqueSlug(String(b.title).trim(), b.platform || null);
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
        return json({ ok: true, productId: prod.id, slug: prod.slug, variantId: variant.id, internalCode: variant.internal_code ?? "", itemId: st.id });
      }
      if (b.entryId && variant.quantity > 0) {
        await logReceive(b.entryId, variant.id, variant.quantity, variant.price_cents ?? 0,
          b.unitCostCents == null ? null : Math.max(0, Math.round(Number(b.unitCostCents)) || 0), true);
      }
      return json({ ok: true, productId: prod.id, slug: prod.slug, variantId: variant.id, internalCode: variant.internal_code ?? "" });
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
