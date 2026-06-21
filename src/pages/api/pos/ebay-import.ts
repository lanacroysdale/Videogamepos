import type { APIRoute } from "astro";
import { createSupabaseAdminClient } from "../../../lib/supabase";
import { copyImageToStorage, copyGallery } from "../../../lib/storage";
import {
  ebayConfigured, ebaySeller, extractItemId, getItem, searchSeller, mapItem, type MappedItem,
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

export const POST: APIRoute = async ({ locals, request }) => {
  if (!locals.user) return json({ error: "unauthorized" }, 401);
  if (!ebayConfigured()) return json({ error: "eBay API keys not configured on the server" }, 400);

  const b = await request.json().catch(() => ({}));
  const mode = b.mode || "preview";
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
      const role = locals.profile?.role ?? "";
      if (!["owner", "manager"].includes(role)) return json({ error: "Managers only" }, 403);
      return json({ ok: true, ...(await syncEbayStock(admin)) });
    }

    // -- Bulk: import a page of the seller's store ---------------------------
    if (mode === "bulk") {
      const role = locals.profile?.role ?? "";
      if (!["owner", "manager"].includes(role)) return json({ error: "Managers only" }, 403);
      const seller = ebaySeller();
      if (!seller) return json({ error: "EBAY_SELLER not set" }, 400);

      const limit = Math.min(12, Math.max(1, Number(b.limit) || 8));
      const offset = Math.max(0, Number(b.offset) || 0);
      const { items: summaries, total } = await searchSeller(seller, { limit, offset });
      const cats = await categoryMap(admin);

      const results: any[] = [];
      let created = 0, skipped = 0;
      // Sequential keeps eBay + storage gentle and ordering predictable.
      for (const s of summaries) {
        const legacyId = String(s.legacyItemId || "");
        try {
          // Skip anything already imported (tagged with its eBay id).
          const { data: existing } = await admin.from("products")
            .select("id").contains("tags", [`ebay:${legacyId}`]).maybeSingle();
          if (existing) { skipped++; results.push({ title: s.title, skipped: true }); continue; }

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

          const imageUrl = await attachMedia(admin, prod.id, variant?.id || null, mi, 6);
          created++;
          results.push({ title: mi.title, imageUrl, priceCents: mi.priceCents });
        } catch (e: any) {
          results.push({ title: s.title, error: e.message });
        }
      }

      const nextOffset = offset + summaries.length;
      return json({ ok: true, total, processed: summaries.length, created, skipped, results, nextOffset: nextOffset < total ? nextOffset : null });
    }

    return json({ error: "Unknown mode" }, 400);
  } catch (e: any) {
    return json({ error: e.message || "eBay import failed" }, 500);
  }
};
