import { checkAvailability } from "./ebay";
import { syncableTypeIds } from "./inventoryTypes";

// Pull stock DOWN from eBay: for every product imported from eBay (tagged
// `ebay:<id>`), if the listing has ended or gone out of stock on eBay, set its
// variants to quantity 0 and hide them online — so the website matches eBay.
// We never raise quantity (that would clobber local/in-store counts) and we
// skip transient API errors so a blip can't wrongly zero a live listing.
export async function syncEbayStock(admin: any) {
  // Non-web-syncable pools (e.g. a copy reassigned to Personal Collection) are
  // not eBay's to zero — treat them as not-live. Null pre-migration → no gate.
  const allowedTypeIds = await syncableTypeIds(admin);
  const variantCols = `id, quantity, online_visible${allowedTypeIds ? ", inventory_type_id" : ""}`;
  const { data: prods } = await admin
    .from("products")
    .select(`id, title, tags, product_variants(${variantCols})`)
    .not("tags", "is", null);

  const tagged = (prods || [])
    .map((p: any) => ({ ...p, ebayId: (p.tags || []).find((t: string) => t.startsWith("ebay:"))?.slice(5) }))
    .filter((p: any) => p.ebayId);

  let zeroed = 0, inStock = 0, errors = 0;
  const changed: { title: string; status: string }[] = [];

  for (const p of tagged) {
    const av = await checkAvailability(p.ebayId);
    if (av.status === "ended" || av.status === "out_of_stock") {
      const live = (p.product_variants || []).filter(
        (v: any) => (v.quantity > 0 || v.online_visible) && (!allowedTypeIds || allowedTypeIds.includes(v.inventory_type_id)),
      );
      if (live.length) {
        await admin.from("product_variants")
          .update({ quantity: 0, online_visible: false })
          .in("id", live.map((v: any) => v.id));
        zeroed++;
        changed.push({ title: p.title, status: av.status });
      }
    } else if (av.status === "in_stock") {
      inStock++;
    } else {
      errors++;
    }
  }

  return { checked: tagged.length, zeroed, inStock, errors, changed };
}
