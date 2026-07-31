// Inventory-type helpers shared by the website gate (shop / PDP / feed / eBay)
// and the checkout stamp/block pass. Types are a small table — fetch fresh per
// request; never cache flags for enforcement (the expo toggle must bite
// immediately).
import type { SupabaseClient } from "@supabase/supabase-js";

type Client = SupabaseClient<any, any, any>;

export type VariantTypeInfo = {
  key: string;
  name: string;
  block_at_checkout: boolean;
  allow_website_sync: boolean;
};

// Type ids allowed on the website/feeds. Returns null when the types table
// doesn't exist yet (pre-migration) so callers can skip the filter instead of
// hiding the whole catalog.
export async function syncableTypeIds(client: Client): Promise<string[] | null> {
  const { data, error } = await client.from("store_inventory_types").select("id").eq("allow_website_sync", true);
  if (error || !data) return null;
  return data.map((t: any) => t.id);
}

// variant_id → its type's behavior flags, for server-side stamp/block at sale
// time. `ready` is false pre-migration (or when nothing was looked up) so
// callers must NOT send the transaction_items.inventory_type column then —
// PostgREST rejects inserts with unknown keys, which would 500 every sale.
export async function typeMapByVariant(
  client: Client,
  variantIds: string[],
): Promise<{ ready: boolean; map: Map<string, VariantTypeInfo> }> {
  const map = new Map<string, VariantTypeInfo>();
  const ids = [...new Set(variantIds.filter(Boolean))];
  if (!ids.length) return { ready: false, map };
  const { data, error } = await client
    .from("product_variants")
    .select("id, inventory_type:store_inventory_types(key, name, block_at_checkout, allow_website_sync)")
    .in("id", ids);
  if (error || !data) return { ready: false, map };
  for (const v of data as any[]) {
    const t = v.inventory_type;
    if (t) map.set(v.id, { key: t.key, name: t.name, block_at_checkout: !!t.block_at_checkout, allow_website_sync: !!t.allow_website_sync });
  }
  return { ready: true, map };
}
