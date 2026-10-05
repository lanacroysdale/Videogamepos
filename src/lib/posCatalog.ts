// The sellable catalog for the checkout screen — one flat row per variant with
// everything the cashier UI needs (title/platform for search, codes for scans,
// price/qty, and the inventory-type gate). Shared by the checkout page's
// server render AND /api/pos/catalog so a station that stays open all day can
// re-pull the same shape and pick up edits (price, stock, a type flipped from
// Personal Collection to Retail) without a reload. Flags here are UX only: the
// checkout API re-checks live type flags on submit.
import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchAll } from "./fetchAll";

type Client = SupabaseClient<any, any, any>;

export type PosCatalogRow = {
  variantId: string;
  productId: string;
  /** The LISTING's UPCs (every condition shares them) — a scan of one asks
   *  which condition when the listing has several. */
  upcs: string[];
  title: string;
  platform: string;
  /** The listing's region code (migration 20261005000001); "" before it —
   *  compare via regionOf(code, regions), where "" means the default. */
  regionCode: string;
  condition: string | null;
  completeness: string | null;
  priceCents: number;
  qty: number;
  sku: string | null;
  barcode: string | null;
  internalCode: string;
  labelCode: string;
  altBarcodes: string[];
  blocked: boolean;
  typeName: string;
  categoryId: string | null;
  categoryName: string;
  categoryColor: string;
};

export async function loadPosCatalog(supabase: Client): Promise<PosCatalogRow[]> {
  // Inventory types (empty pre-migration) drive the blocked-at-checkout hint.
  const { data: invTypeRows } = await supabase.from("store_inventory_types").select("id, key, name, icon, block_at_checkout");
  const hasTypes = !!invTypeRows;
  const typeInfoById = new Map((invTypeRows ?? []).map((t: any) => [t.id, t]));
  // Numeric label codes ship in migration 20260801000001 — probe before selecting.
  const { error: lcProbeErr } = await supabase.from("product_variants").select("label_code").limit(1);
  const hasLabelCodes = !lcProbeErr;
  // Soft-deleted products (migration 20260903000001) must not be scannable/sellable.
  const { error: delProbeErr } = await supabase.from("products").select("deleted_at").limit(1);
  // Rows an unfinished entry draft created (migration 20260930000001) aren't for sale yet.
  const { error: pendProbeErr } = await supabase.from("products").select("pending_entry_id").limit(1);
  const pend = pendProbeErr ? "" : ", pending_entry_id";
  // Listing UPCs (migration 20260930000003).
  const { error: upcProbeErr } = await supabase.from("product_upcs").select("id").limit(1);
  const upcEmbed = upcProbeErr ? "" : ", product_upcs(upc)";
  // Listing region (migration 20261005000001) — badges, the region filter and
  // the "[JP]" in a sale line's description.
  const { error: rgProbeErr } = await supabase.from("products").select("region_code").limit(1);
  const rgCol = rgProbeErr ? "" : ", region_code";

  // Paged: a single request stops at 1,000 rows, which silently dropped the
  // cheapest items from checkout scanning once the catalog grew past that.
  const { data: variantRows } = await fetchAll((from, to) => supabase
    .from("product_variants")
    .select(`id, product_id, condition, completeness, price_cents, quantity, sku, barcode, internal_code${hasLabelCodes ? ", label_code" : ""}${hasTypes ? ", inventory_type_id" : ""}${pend}, product_barcodes(barcode), product:products(title, platform${rgCol}${delProbeErr ? "" : ", deleted_at"}${pend}${upcEmbed}, category:categories(id,name,color,is_trackable))`)
    .order("price_cents", { ascending: false })
    .order("id")
    .range(from, to));

  return (variantRows ?? []).filter((v: any) => !v.product?.deleted_at && !v.pending_entry_id && !v.product?.pending_entry_id).map((v: any) => ({
    variantId: v.id,
    productId: v.product_id,
    upcs: (v.product?.product_upcs ?? []).map((u: any) => u.upc),
    title: v.product?.title ?? "Item",
    platform: v.product?.platform ?? "",
    regionCode: v.product?.region_code ?? "",
    condition: v.condition,
    completeness: v.completeness,
    priceCents: v.price_cents,
    qty: v.quantity,
    sku: v.sku,
    barcode: v.barcode,
    internalCode: v.internal_code ?? "",
    labelCode: v.label_code ?? "",
    altBarcodes: (v.product_barcodes ?? []).map((b: any) => b.barcode),
    blocked: hasTypes ? !!typeInfoById.get(v.inventory_type_id)?.block_at_checkout : false,
    typeName: hasTypes ? (typeInfoById.get(v.inventory_type_id)?.name ?? "") : "",
    categoryId: v.product?.category?.id ?? null,
    categoryName: v.product?.category?.name ?? "",
    categoryColor: v.product?.category?.color ?? "#2ce6e0",
  }));
}
