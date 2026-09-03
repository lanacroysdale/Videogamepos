// The sellable catalog for the checkout screen — one flat row per variant with
// everything the cashier UI needs (title/platform for search, codes for scans,
// price/qty, and the inventory-type gate). Shared by the checkout page's
// server render AND /api/pos/catalog so a station that stays open all day can
// re-pull the same shape and pick up edits (price, stock, a type flipped from
// Personal Collection to Retail) without a reload. Flags here are UX only: the
// checkout API re-checks live type flags on submit.
import type { SupabaseClient } from "@supabase/supabase-js";

type Client = SupabaseClient<any, any, any>;

export type PosCatalogRow = {
  variantId: string;
  title: string;
  platform: string;
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

  const { data: variantRows } = await supabase
    .from("product_variants")
    .select(`id, condition, completeness, price_cents, quantity, sku, barcode, internal_code${hasLabelCodes ? ", label_code" : ""}${hasTypes ? ", inventory_type_id" : ""}, product_barcodes(barcode), product:products(title, platform${delProbeErr ? "" : ", deleted_at"}, category:categories(id,name,color,is_trackable))`)
    .order("price_cents", { ascending: false });

  return (variantRows ?? []).filter((v: any) => !v.product?.deleted_at).map((v: any) => ({
    variantId: v.id,
    title: v.product?.title ?? "Item",
    platform: v.product?.platform ?? "",
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
