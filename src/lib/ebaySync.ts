import { checkAvailability, ebaySeller } from "./ebay";
import { fetchAll } from "./fetchAll";
import { syncableTypeIds } from "./inventoryTypes";

// Pull stock DOWN from eBay: for every product imported from eBay (tagged
// `ebay:<id>`), if the listing has ended or gone out of stock on eBay, set its
// variants to quantity 0 and hide them online — so the website matches eBay.
// We never raise quantity (that would clobber local/in-store counts) and we
// skip transient API errors so a blip can't wrongly zero a live listing.
//
// Only the store's OWN eBay stock is zeroed: when the store has an "eBay"
// inventory type (key "ebay"), only stock rows of that type — a Retail /
// Personal copy on the same listing, or a quick-add copied from another
// seller's listing, is never touched. A listing another seller runs (seen
// while it's still up) is skipped too. A listing carrying several eBay items
// (two copies listed separately) is zeroed only once every one is gone.
export async function syncEbayStock(admin: any) {
  // Non-web-syncable pools (e.g. a copy reassigned to Personal Collection) are
  // not eBay's to zero — treat them as not-live. Null pre-migration → no gate.
  const allowedTypeIds = await syncableTypeIds(admin);
  const { data: ebayType, error: etErr } = await admin.from("store_inventory_types").select("id").eq("key", "ebay").maybeSingle();
  const ebayTypeId: string | null = !etErr && ebayType?.id ? ebayType.id : null;
  const ours = (ebaySeller() || "").toLowerCase();
  const variantCols = `id, quantity, online_visible${allowedTypeIds ? ", inventory_type_id" : ""}`;
  const { data: prods } = await fetchAll((from, to) => admin
    .from("products")
    .select(`id, title, tags, product_variants(${variantCols})`)
    .not("tags", "is", null)
    .order("id")
    .range(from, to));

  const tagged = (prods || [])
    .map((p: any) => ({ ...p, ebayIds: (p.tags || []).filter((t: string) => t.startsWith("ebay:")).map((t: string) => t.slice(5)) }))
    .filter((p: any) => p.ebayIds.length);

  let zeroed = 0, inStock = 0, errors = 0, notOurs = 0;
  const changed: { title: string; status: string }[] = [];

  for (const p of tagged) {
    const avs = [];
    for (const id of p.ebayIds) avs.push(await checkAvailability(id));
    if (avs.some((a) => a.seller && ours && a.seller.toLowerCase() !== ours)) { notOurs++; continue; }
    if (avs.some((a) => a.status === "error")) { errors++; continue; }
    if (avs.some((a) => a.status === "in_stock")) { inStock++; continue; }
    const live = (p.product_variants || []).filter((v: any) => (v.quantity > 0 || v.online_visible)
      && (ebayTypeId ? v.inventory_type_id === ebayTypeId : !allowedTypeIds || allowedTypeIds.includes(v.inventory_type_id)));
    if (live.length) {
      await admin.from("product_variants")
        .update({ quantity: 0, online_visible: false })
        .in("id", live.map((v: any) => v.id));
      zeroed++;
      changed.push({ title: p.title, status: avs.every((a) => a.status === "ended") ? "ended" : "out_of_stock" });
    }
  }

  return { checked: tagged.length, zeroed, inStock, errors, notOurs, changed };
}
