import type { APIRoute } from "astro";
import { createSupabaseAdminClient } from "../../../lib/supabase";
import { fetchAll } from "../../../lib/fetchAll";
import { copyImageToStorage, copyGallery, listGallery } from "../../../lib/storage";
import {
  ebayConfigured, ebaySeller, extractItemId, getItem, listSellerItems, listSellerStore, mapItem, storeListingDetails, type MappedItem,
} from "../../../lib/ebay";
import { syncEbayStock } from "../../../lib/ebaySync";
import { loadRegions, regionsOn, regionByCode } from "../../../lib/regions";

export const prerender = false;
const json = (d: unknown, s = 200) =>
  new Response(JSON.stringify(d), { status: s, headers: { "content-type": "application/json" } });

const slugify = (s: string) =>
  s.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);

async function categoryMap(admin: any): Promise<Map<string, string>> {
  const { data } = await admin.from("categories").select("id, name");
  const m = new Map<string, string>();
  for (const c of data || []) m.set(String(c.name).toLowerCase(), c.id);
  return m;
}
const resolveCat = (m: Map<string, string>, name: string) =>
  m.get(name.toLowerCase()) || m.get("video games") || [...m.values()][0] || null;

// Persist a mapped eBay item onto a product + variant that already exist.
// Copies the primary photo + image gallery into our storage, fills metadata,
// tags the eBay id. `galleryMax` caps how many gallery photos to copy. Never
// touches the region: on the paste-a-listing path staff chose it in the form.
async function attachMedia(admin: any, productId: string, variantId: string | null, mi: MappedItem, galleryMax = 16) {
  let imageUrl: string | null = null;
  if (mi.primaryImage) imageUrl = await copyImageToStorage(admin, mi.primaryImage, "ebay");
  // Full gallery → per-product folder (the PDP lists it; no DB column needed).
  if (mi.images.length && galleryMax > 0) await copyGallery(admin, mi.images, productId, galleryMax);

  // Add the eBay tag; never drop the listing's other tags (pricecharting:…).
  const { data: cur } = await admin.from("products").select("tags").eq("id", productId).maybeSingle();
  const tags: string[] = Array.isArray(cur?.tags) ? cur!.tags : [];
  const patch: Record<string, unknown> = { tags: tags.includes(`ebay:${mi.ebayItemId}`) ? tags : [...tags, `ebay:${mi.ebayItemId}`] };
  if (imageUrl) patch.image_url = imageUrl;
  if (mi.description) patch.description = mi.description;
  if (mi.brand) patch.brand = mi.brand;
  if (mi.releaseYear) patch.release_year = mi.releaseYear;
  if (mi.platform) patch.platform = mi.platform;
  await admin.from("products").update(patch).eq("id", productId);

  // The UPC is the LISTING's, from eBay's product catalog (src/lib/upcFinder.ts),
  // not the seller-typed one, and not pinned to one condition row.
  return imageUrl;
}

// Import a single eBay listing as a product + variant (with media). Skips if
// already imported (tagged). Used by both the single-id path and bulk.
async function importOne(admin: any, cats: Map<string, string>, legacyId: string, galleryMax: number) {
  const { data: existing } = await admin.from("products")
    .select("id").contains("tags", [`ebay:${legacyId}`]).maybeSingle();
  if (existing) return { skipped: true as const };

  const mi = mapItem(await getItem(legacyId));
  const slug = `${slugify(mi.title)}-${mi.ebayItemId.slice(-5)}`;
  // The listing's region (eBay's Region Code aspect…), when it's one of the
  // store's and the column exists (migration 20261005000001) — else the
  // default fills in.
  const regions = await loadRegions(admin);
  const region = regionsOn(regions) ? regionByCode(mi.region, regions) : null;
  const rgReady = !!region && !(await admin.from("products").select("region_code").limit(1)).error;
  const { data: prod, error: pErr } = await admin.from("products").insert({
    title: mi.title, platform: mi.platform || null, category_id: resolveCat(cats, mi.categoryName), slug,
    ...(rgReady ? { region_code: region!.code } : {}),
  }).select("id").single();
  if (pErr) throw new Error(pErr.message);

  const { data: variant } = await admin.from("product_variants").insert({
    product_id: prod.id,
    condition: mi.conditionLabel || "Used",
    completeness_code: mi.completenessCode || null,
    grade_code: mi.gradeCode || null,
    price_cents: mi.priceCents,
    quantity: 1,
  }).select("id").single();

  const imageUrl = await attachMedia(admin, prod.id, variant?.id || null, mi, galleryMax);
  return { created: true as const, title: mi.title, imageUrl, priceCents: mi.priceCents };
}

export const POST: APIRoute = async ({ locals, request }) => {
  // Auth: a staff session, OR the CRON_SECRET bearer (used by the background
  // bulk-import / scheduled jobs so they can reuse this exact import logic).
  const cronAuthed =
    !!import.meta.env.CRON_SECRET &&
    request.headers.get("authorization") === `Bearer ${import.meta.env.CRON_SECRET}`;
  if (!locals.user && !cronAuthed) return json({ error: "unauthorized" }, 401);
  if (!ebayConfigured()) return json({ error: "eBay API keys not configured on the server" }, 400);

  const b = await request.json().catch(() => ({}));
  const mode = b.mode || "preview";
  const isManager = cronAuthed || locals.can("inventory.manage");
  const admin = createSupabaseAdminClient();

  try {
    // -- Parse one listing and return the mapped fields (no DB writes) --------
    if (mode === "preview") {
      const id = extractItemId(b.input || "");
      if (!id) return json({ error: "Couldn't find an eBay item ID in that. Paste the listing URL or the numeric item number." }, 400);
      const mi = mapItem(await getItem(id));
      return json({ ok: true, item: mi });
    }

    // -- Copy media/metadata onto an already-created product -----------------
    if (mode === "attach") {
      if (!b.productId) return json({ error: "productId required" }, 400);
      const id = extractItemId(b.input || "");
      if (!id) return json({ error: "missing eBay item id" }, 400);
      const imageUrl = await attachMedia(admin, b.productId, b.variantId || null, mapItem(await getItem(id)));
      return json({ ok: true, imageUrl });
    }

    // -- Sync stock down from eBay (out of stock / ended → 0 on website) -----
    if (mode === "sync") {
      if (!isManager) return json({ error: "Managers only" }, 403);
      return json({ ok: true, ...(await syncEbayStock(admin)) });
    }

    // -- eBay importer: the whole store for the review table ----------------
    // Listings already in the POS (any listing tagged ebay:<id>, drafts too)
    // come back marked so the dialog can leave them out.
    if (mode === "store-list") {
      if (!isManager) return json({ error: "Managers only" }, 403);
      const seller = ebaySeller();
      if (!seller) return json({ error: "EBAY_SELLER not set" }, 400);
      const listings = await listSellerStore(seller);
      const { data: tagged } = await fetchAll((from, to) => admin.from("products").select("id, title, tags").not("tags", "is", null).order("id").range(from, to));
      const have = new Map<string, { productId: string; title: string }>();
      for (const p of tagged || [])
        for (const t of p.tags || []) if (String(t).startsWith("ebay:")) have.set(String(t).slice(5), { productId: p.id, title: p.title });
      return json({ ok: true, listings: listings.map((l) => ({ ...l, imported: have.get(l.id) ?? null })) });
    }

    // -- eBay importer: item specifics for up to 20 listings ----------------
    // Platform / Game Name / Region Code / qty live only on the full record.
    // A few at a time so a burst doesn't trip eBay's rate limit; a failed
    // listing comes back with an error instead of failing the batch.
    if (mode === "store-details") {
      if (!isManager) return json({ error: "Managers only" }, 403);
      const ids: string[] = (Array.isArray(b.ids) ? b.ids : []).map((x: unknown) => String(x)).filter((x: string) => /^\d{9,15}$/.test(x)).slice(0, 20);
      const out: any[] = [];
      const CONC = 4;
      for (let i = 0; i < ids.length; i += CONC) {
        out.push(...(await Promise.all(ids.slice(i, i + CONC).map(async (id) => {
          try { return { ok: true, ...storeListingDetails(await getItem(id)) }; }
          catch (e: any) { return { ok: false, id, ended: /not found|404|no longer available/i.test(String(e?.message)), error: String(e?.message || "eBay error") }; }
        }))));
      }
      return json({ ok: true, details: out });
    }

    // -- eBay importer: photos + details onto a staged listing ---------------
    // Photos, description and item specifics (brand, year, franchise / series,
    // genre, character) only fill what the listing doesn't have yet, so a
    // listing that already existed keeps its own. Always adds the ebay:<id>
    // tag (never removes other tags).
    if (mode === "media") {
      if (!isManager) return json({ error: "Managers only" }, 403);
      const legacyId = String(b.legacyItemId || "");
      if (!b.productId || !/^\d{9,15}$/.test(legacyId)) return json({ error: "productId and legacyItemId required" }, 400);
      const galleryMax = Math.max(0, Math.min(12, Math.round(Number(b.galleryMax ?? 0)) || 0));
      // products.character ships with migration 20261006000001 — left alone until then.
      const hasCharacter = !(await admin.from("products").select("character").limit(1)).error;
      const { data: prod } = await admin.from("products")
        .select(`id, image_url, description, brand, release_year, franchise, genre, tags${hasCharacter ? ", character" : ""}`)
        .eq("id", b.productId).maybeSingle() as { data: any };
      if (!prod) return json({ error: "Listing not found" }, 404);
      const mi = mapItem(await getItem(legacyId));
      const patch: Record<string, unknown> = {};
      const tags: string[] = Array.isArray(prod.tags) ? prod.tags : [];
      if (!tags.includes(`ebay:${legacyId}`)) patch.tags = [...tags, `ebay:${legacyId}`];
      let imageUrl: string | null = prod.image_url || null;
      if (!imageUrl && mi.primaryImage) {
        imageUrl = await copyImageToStorage(admin, mi.primaryImage, "ebay");
        if (imageUrl) patch.image_url = imageUrl;
      }
      // "1 photo" = the cover only. More → the gallery (its first photo is the
      // cover), unless the listing already has one.
      let gallery = 0;
      if (galleryMax > 1 && mi.images.length > 1 && !(await listGallery(admin, prod.id)).length)
        gallery = await copyGallery(admin, mi.images, prod.id, galleryMax);
      if (!prod.description && mi.description) patch.description = mi.description;
      if (!prod.brand && mi.brand) patch.brand = mi.brand;
      if (!prod.release_year && mi.releaseYear) patch.release_year = mi.releaseYear;
      if (!prod.franchise && mi.franchise) patch.franchise = mi.franchise;
      if (!prod.genre && mi.genre) patch.genre = mi.genre;
      if (hasCharacter && !prod.character && mi.character) patch.character = mi.character;
      if (Object.keys(patch).length) {
        const { error } = await admin.from("products").update(patch).eq("id", prod.id);
        if (error) return json({ error: error.message }, 500);
      }
      const { tags: _t, ...fields } = patch;
      return json({ ok: true, imageUrl, gallery, fields });
    }

    // -- eBay importer: a category picked as "＋ New category…" --------------
    if (mode === "ensure-category") {
      if (!isManager) return json({ error: "Managers only" }, 403);
      const name = String(b.name || "").replace(/\s+/g, " ").trim().slice(0, 40);
      if (!name) return json({ error: "Category name required" }, 400);
      const { data: cats } = await admin.from("categories").select("id, name, color, sort_order");
      const hit = (cats || []).find((c: any) => String(c.name).toLowerCase() === name.toLowerCase());
      if (hit) return json({ ok: true, category: { id: hit.id, name: hit.name, color: hit.color } });
      const PALETTE = ["#ff6b6b", "#f7b801", "#7bdff2", "#b388eb", "#80ff72", "#ff9f1c", "#4cc9f0"];
      const sort = Math.max(0, ...(cats || []).map((c: any) => Number(c.sort_order) || 0)) + 1;
      const { data: made, error } = await admin.from("categories")
        .insert({ name, color: PALETTE[(cats || []).length % PALETTE.length], sort_order: sort })
        .select("id, name, color").single();
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true, category: made });
    }

    // -- Bulk step 1: enumerate the WHOLE store (all categories) -------------
    // Returns the list of not-yet-imported item ids; the client then imports
    // them one at a time via "bulk-item" (so hundreds never time out).
    if (mode === "bulk-list") {
      if (!isManager) return json({ error: "Managers only" }, 403);
      const seller = ebaySeller();
      if (!seller) return json({ error: "EBAY_SELLER not set" }, 400);

      const all = await listSellerItems(seller);
      // Drop ids we've already imported (tagged ebay:<id>).
      const { data: tagged } = await fetchAll((from, to) => admin.from("products").select("id, tags").not("tags", "is", null).order("id").range(from, to));
      const have = new Set<string>();
      for (const p of tagged || [])
        for (const t of p.tags || []) if (String(t).startsWith("ebay:")) have.add(String(t).slice(5));
      const todo = all.filter((i) => !have.has(i.legacyItemId));
      return json({ ok: true, total: all.length, alreadyImported: all.length - todo.length, items: todo });
    }

    // -- Bulk step 2: import ONE listing ------------------------------------
    if (mode === "bulk-item") {
      if (!isManager) return json({ error: "Managers only" }, 403);
      const legacyId = String(b.legacyItemId || extractItemId(b.input || "") || "");
      if (!legacyId) return json({ error: "legacyItemId required" }, 400);
      const cats = await categoryMap(admin);
      const r = await importOne(admin, cats, legacyId, Math.max(0, Number(b.galleryMax ?? 6)));
      return json({ ok: true, ...r });
    }

    return json({ error: "Unknown mode" }, 400);
  } catch (e: any) {
    return json({ error: e.message || "eBay import failed" }, 500);
  }
};
