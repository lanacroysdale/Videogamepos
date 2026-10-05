import type { APIRoute } from "astro";
import { createSupabaseAdminClient } from "../lib/supabase";
import { syncableTypeIds } from "../lib/inventoryTypes";
import { loadRegions, regionsOn, regionOf, regionByCode, regionTag, seoTitle } from "../lib/regions";
import { SITE } from "../consts";

export const prerender = false;

// Google Merchant Center product feed (RSS 2.0 + g: namespace). Public on purpose
// so Google can fetch it — submit this URL in Merchant Center. One entry per
// in-stock, web-visible product (cheapest available variant). All items are
// fulfilled from the Portland, OR storefront.
const esc = (s: unknown) =>
  String(s ?? "").replace(/[<>&'"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" }[c] as string));

function gCondition(v: any): string {
  if (v.completeness_code === "NEW") return "new";
  if (/refurb/i.test(`${v.condition ?? ""}`)) return "refurbished";
  return "used";
}

export const GET: APIRoute = async () => {
  const admin = createSupabaseAdminClient();
  // Inventory-type gate: non-syncable pools (e.g. Personal Collection) stay out
  // of the feed. Null pre-migration → filter skipped.
  const allowedTypeIds = await syncableTypeIds(admin);
  // Listing UPCs (migration 20260930000003) → <g:gtin>.
  const { error: upcProbeErr } = await admin.from("product_upcs").select("id").limit(1);
  // Listing region (migration 20261005000001) → title / description / Region
  // detail. Probed so a pre-migration DB still serves the feed unchanged.
  const { error: rgProbeErr } = await admin.from("products").select("region_code").limit(1);
  const regions = rgProbeErr ? [] : await loadRegions(admin);
  let feedQ = admin
    .from("product_variants")
    .select(`price_cents, online_price_cents, quantity, condition, completeness_code, product:products(id, title, slug, platform, brand, genre, description, image_url, category:categories(name)${upcProbeErr ? "" : ", product_upcs(upc)"}${rgProbeErr ? "" : ", region_code"})`)
    .eq("online_visible", true)
    .gt("quantity", 0);
  if (allowedTypeIds) feedQ = feedQ.in("inventory_type_id", allowedTypeIds);
  const { data: rows } = await feedQ.order("price_cents", { ascending: true });

  // One offer per product — keep the cheapest available variant.
  const seen = new Set<string>();
  const items: string[] = [];
  for (const v of rows ?? []) {
    const p: any = (v as any).product;
    if (!p?.slug || seen.has(p.id)) continue;
    seen.add(p.id);
    const cents = (v as any).online_price_cents ?? (v as any).price_cents;
    if (cents == null) continue;
    const link = `${SITE.url}/shop/${p.slug}`;
    // US and JP copies of one game are separate listings (own id / GTIN) —
    // an import region goes into the title so Shopping can tell them apart.
    const region = regionsOn(regions) ? regionByCode(regionOf(p.region_code, regions), regions) : null;
    const isImport = !!regionTag(p.region_code, regions);
    const title = seoTitle(p.title, p.region_code, regions);
    const desc = ((isImport && region && p.description ? `Region: ${region.name}. ` : "") +
      (p.description || `${title}${p.platform ? ` for ${p.platform}` : ""} — in stock at ${SITE.name}, ${SITE.location}.`)).replace(/\s+/g, " ").trim().slice(0, 4000);
    items.push(
      `    <item>
      <g:id>${esc(p.id)}</g:id>
      <g:title>${esc(title)}</g:title>
      <g:description>${esc(desc)}</g:description>
      <g:link>${esc(link)}</g:link>
      ${p.image_url ? `<g:image_link>${esc(p.image_url)}</g:image_link>` : ""}
      <g:availability>in_stock</g:availability>
      <g:price>${(cents / 100).toFixed(2)} USD</g:price>
      <g:condition>${gCondition(v)}</g:condition>
      ${p.brand ? `<g:brand>${esc(p.brand)}</g:brand>` : ""}
      ${p.product_upcs?.[0]?.upc ? `<g:gtin>${esc(p.product_upcs[0].upc)}</g:gtin>` : "<g:identifier_exists>no</g:identifier_exists>"}
      <g:product_type>${esc(p.category?.name || "Video Games")}</g:product_type>
      <g:google_product_category>Electronics &gt; Video Games</g:google_product_category>
      ${region ? `<g:product_detail>
        <g:section_name>General</g:section_name>
        <g:attribute_name>Region</g:attribute_name>
        <g:attribute_value>${esc(region.name)}</g:attribute_value>
      </g:product_detail>
      <g:custom_label_0>${esc(region.code)}</g:custom_label_0>` : ""}
    </item>`,
    );
  }

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:g="http://base.google.com/ns/1.0">
  <channel>
    <title>${esc(SITE.name)}</title>
    <link>${SITE.url}/shop</link>
    <description>In-stock games, consoles, accessories &amp; collectibles at ${esc(SITE.name)}, ${esc(SITE.location)}.</description>
${items.join("\n")}
  </channel>
</rss>`;

  return new Response(xml, {
    headers: { "content-type": "application/xml; charset=utf-8", "cache-control": "public, max-age=3600" },
  });
};
