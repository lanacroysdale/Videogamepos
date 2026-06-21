import type { APIRoute } from "astro";
import { createSupabaseAdminClient } from "../../../lib/supabase";
import { copyImageToStorage, copyGallery } from "../../../lib/storage";
import {
  ebayConfigured, ebaySeller, extractItemId, getItem, listSellerItems, mapItem, type MappedItem,
} from "../../../lib/ebay";
import { syncEbayStock } from "../../../lib/ebaySync";

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
// tags the eBay id. `galleryMax` caps how many gallery photos to copy.
async function attachMedia(admin: any, productId: string, variantId: string | null, mi: MappedItem, galleryMax = 16) {
  let imageUrl: string | null = null;
  if (mi.primaryImage) imageUrl = await copyImageToStorage(admin, mi.primaryImage, "ebay");
  // Full gallery → per-product folder (the PDP lists it; no DB column needed).
  if (mi.images.length && galleryMax > 0) await copyGallery(admin, mi.images, productId, galleryMax);

  const patch: Record<string, unknown> = { tags: [`ebay:${mi.ebayItemId}`] };
  if (imageUrl) patch.image_url = imageUrl;
  if (mi.description) patch.description = mi.description;
  if (mi.brand) patch.brand = mi.brand;
  if (mi.releaseYear) patch.release_year = mi.releaseYear;
  if (mi.platform) patch.platform = mi.platform;
  await admin.from("products").update(patch).eq("id", productId);

  // UPC → a scannable barcode on the variant (best-effort; ignore dupes).
  if (variantId && mi.upc) {
    await admin.from("product_barcodes")
      .insert({ variant_id: variantId, barcode: mi.upc, label: "UPC" })
      .then(undefined, () => {});
  }
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
  const { data: prod, error: pErr } = await admin.from("products").insert({
    title: mi.title, platform: mi.platform || null, category_id: resolveCat(cats, mi.categoryName), slug,
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
  const isManager = cronAuthed || ["owner", "manager"].includes(locals.profile?.role ?? "");
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

    // -- Bulk step 1: enumerate the WHOLE store (all categories) -------------
    // Returns the list of not-yet-imported item ids; the client then imports
    // them one at a time via "bulk-item" (so hundreds never time out).
    if (mode === "bulk-list") {
      if (!isManager) return json({ error: "Managers only" }, 403);
      const seller = ebaySeller();
      if (!seller) return json({ error: "EBAY_SELLER not set" }, 400);

      const all = await listSellerItems(seller);
      // Drop ids we've already imported (tagged ebay:<id>).
      const { data: tagged } = await admin.from("products").select("tags").not("tags", "is", null);
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
