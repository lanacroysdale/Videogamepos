// Listing UPCs from eBay's PRODUCT CATALOG — server only (eBay app token).
//
// How a game gets its UPC, with no extra eBay consent:
//   1. Browse search "<title> <platform>" in Video Games (139973).
//   2. Group the listings by the eBay catalog product (epid) sellers listed
//      them under; only a product at least TWO listings agree on counts.
//   3. Read that product (getItem fieldgroups=PRODUCT): its title, platform,
//      region and GTINs are eBay's catalog data, not what a seller typed.
//   4. Keep it only if it is the same release on the same platform for the US
//      market (upcMatch.ts); two different matching products → "ambiguous".
// Unsure → no UPC ("Needs UPC" shows it). Shared by the per-listing endpoint,
// the "Fill missing UPCs" button and the daily cron trickle.
import { searchGameListings, searchByGtin, getItemWithProduct, ebayConfigured } from "./ebay";
import { sameRelease, platformAgrees, regionAgrees, aspectMap, usUpcs, upcEligible, upcForms, canonicalUpc, catalogTitleClean, sameBoxRelease, sameGameName } from "./upcMatch";
import { withoutTrailingPlatform, resolveStaticPlatform } from "./smartSearch";
import { itemKind } from "./collectionImport";
import { lbPlatform, lbImageUrl } from "./launchbox";
import { fetchAll } from "./fetchAll";
import { barcodeEq } from "./gtin";
import { type Region, loadRegions, regionsOn, displayTitle, regionFromEbayAspect, splitTitleRegion } from "./regions";

export type UpcStatus = "found" | "not_found" | "ambiguous" | "conflict" | "error" | "rejected";
export interface UpcLookup { status: UpcStatus; upcs: string[]; evidence: string }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// eBay throttles bursts (~30 fast calls → empty results), so calls are spaced.
const GAP_MS = 250;

// The eBay calls, swappable for tests.
const EBAY = { search: searchGameListings, getItem: getItemWithProduct };

export async function findCatalogUpcs(title: string, platform: string, ebay = EBAY): Promise<UpcLookup> {
  const name = withoutTrailingPlatform(title.replace(/[[\]()]/g, " ").replace(/\s+/g, " ").trim(), platform);
  let found;
  try { found = await ebay.search(`${name} ${platform}`); }
  catch (e: any) { return { status: "error", upcs: [], evidence: String(e?.message || e) }; }
  if (!found.items.length) return { status: "not_found", upcs: [], evidence: "No eBay listings found" };

  const byProduct = new Map<string, string[]>();
  for (const it of found.items) if (it.epid && it.legacyItemId) byProduct.set(it.epid, [...(byProduct.get(it.epid) ?? []), it.legacyItemId]);
  const ranked = [...byProduct.entries()].filter(([, ids]) => ids.length >= 2).sort((a, b) => b[1].length - a[1].length).slice(0, 3);
  if (!ranked.length) return { status: "not_found", upcs: [], evidence: "No eBay catalog product that 2+ listings agree on" };

  const matches: { epid: string; title: string; upcs: string[]; listings: number }[] = [];
  const rejected: string[] = [];
  for (const [epid, ids] of ranked) {
    let item: any = null;
    for (const id of ids.slice(0, 2)) {
      await sleep(GAP_MS);
      try { item = await ebay.getItem(id); break; } catch { /* try the next listing */ }
    }
    const prod = item?.product;
    const ptitle = String(prod?.title || "").trim();
    if (!ptitle) continue;
    const aspects = aspectMap(prod.aspectGroups, item.localizedAspects);
    const platforms = aspects.get("platform") ?? [];
    if (!sameRelease(title, ptitle, platform)) { rejected.push(`“${ptitle}” is a different release`); continue; }
    if (!platformAgrees(platforms, platform)) { rejected.push(`“${ptitle}” is for ${platforms.join(" / ") || "an unknown platform"}`); continue; }
    if (!regionAgrees(aspects.get("region code") ?? [])) { rejected.push(`“${ptitle}” isn't a US release`); continue; }
    const upcs = usUpcs(prod.gtins);
    if (!upcs.length) { rejected.push(`“${ptitle}” has no US UPC on eBay`); continue; }
    matches.push({ epid, title: ptitle, upcs, listings: ids.length });
  }
  if (!matches.length) return { status: "not_found", upcs: [], evidence: rejected.slice(0, 3).join("; ") || "eBay had no catalog details" };
  const first = matches[0];
  // A second matching product with a DIFFERENT code = two releases look alike
  // (an original and a reprint) — don't guess.
  if (matches.some((m) => !m.upcs.some((u) => first.upcs.includes(u))))
    return { status: "ambiguous", upcs: [], evidence: `More than one eBay release matches: ${matches.map((m) => `${m.title} (${m.upcs.join(", ")})`).join(" · ")}` };
  const upcs = [...new Set(matches.flatMap((m) => m.upcs))];
  return { status: "found", upcs, evidence: `eBay catalog: ${first.title} (${first.listings} listings agree)` };
}

/** products.region_code exists (migration 20261005000001)? PostgREST
 *  rejects a select naming an unknown column. */
export async function regionColumnReady(admin: any): Promise<boolean> {
  const { error } = await admin.from("products").select("region_code").limit(1);
  return !error;
}
// How messages name another listing: "Okami HD [JP]" — two releases of one
// game share a title, the region tag tells them apart.
interface Naming { regions: Region[]; rg: string }
async function naming(admin: any): Promise<Naming> {
  const regions = await loadRegions(admin);
  return { regions, rg: regionsOn(regions) && (await regionColumnReady(admin)) ? ", region_code" : "" };
}

/** Another LISTING already using this code (as its UPC or a condition's
 *  barcode) — its title (with its region tag), or null. Every 12/13/14-digit
 *  spelling counts. */
export async function upcOwner(admin: any, upc: string, productId: string, nm?: Naming): Promise<string | null> {
  const { regions, rg } = nm ?? (await naming(admin));
  const name = (p: any) => (p?.title ? displayTitle(p.title, p.region_code, regions) : "another listing");
  const forms = upcForms(upc);
  const { data: u } = await admin.from("product_upcs").select(`product_id, product:products(title${rg})`).in("upc", forms).neq("product_id", productId).limit(1);
  if (u?.length) return name(u[0].product);
  const { data: v } = await admin.from("product_variants").select(`product_id, product:products(title${rg})`).in("barcode", forms).neq("product_id", productId).limit(1);
  if (v?.length) return name(v[0].product);
  const { data: b } = await admin.from("product_barcodes").select(`variant:product_variants(product_id, product:products(title${rg}))`).in("barcode", forms).limit(5);
  const other = (b || []).find((r: any) => r.variant && r.variant.product_id !== productId);
  return other ? name(other.variant.product) : null;
}

/** Attach codes to a listing (skipping ones another listing owns). */
export async function attachUpcs(admin: any, productId: string, upcs: string[], source: "ebay" | "manual" | "import", evidence: string | null) {
  const added: { id: string; upc: string; source: string }[] = [];
  const conflicts: string[] = [];
  const nm = upcs.length ? await naming(admin) : undefined;
  for (const upc of upcs) {
    const owner = await upcOwner(admin, upc, productId, nm);
    if (owner) { conflicts.push(`${upc} is already on “${owner}”`); continue; }
    const { data, error } = await admin.from("product_upcs").insert({ product_id: productId, upc, source, evidence }).select("id, upc, source").single();
    if (data) added.push(data);
    else if (error?.code !== "23505") throw new Error(error?.message || "Couldn't save the UPC");
    // 23505: this listing (or a race) already has it — nothing to add.
  }
  return { added, conflicts };
}

export async function upcTablesReady(admin: any): Promise<boolean> {
  const { error } = await admin.from("product_upcs").select("id").limit(1);
  return !error;
}

export interface FillResult { id: string; status: UpcStatus | "has" | "ineligible" | "skipped"; upcs: { id: string; upc: string; source: string }[]; evidence: string }

/**
 * Look up listings' UPCs and save what's found. Either the given listings, or
 * (no ids) the listings that still need one, oldest-checked first, until
 * `deadline`/`max`. Stamps upc_checked_at BEFORE each lookup, so a run cut off
 * mid-way moves on next time instead of retrying the same listing.
 */
export async function fillListingUpcs(admin: any, opts: { productIds?: string[]; force?: boolean; deadline?: number; max?: number } = {}): Promise<{ results: FillResult[]; stopped?: string }> {
  if (!ebayConfigured()) return { results: [], stopped: "eBay isn't connected on the server (EBAY_CLIENT_ID / EBAY_CLIENT_SECRET)" };
  // region_code only once the regions migration ran (an import never gets a US code).
  const rg = (await regionColumnReady(admin)) ? ", region_code" : "";
  const cols = `id, title, platform${rg}, deleted_at, upc_status, upc_checked_at, upc_rejected, category:categories(name), product_upcs(id, upc, source)`;
  let rows: any[] = [];
  if (opts.productIds?.length) {
    const { data, error } = await admin.from("products").select(cols).in("id", opts.productIds.slice(0, 50));
    if (error) throw new Error(error.message);
    rows = data || [];
  } else {
    const { data, error } = await fetchAll((from, to) => admin.from("products").select(cols).is("deleted_at", null).order("id").range(from, to));
    if (error) throw new Error(error.message);
    rows = needingUpc(data || []);
  }
  const results: FillResult[] = [];
  let errorsInARow = 0;
  for (const p of rows) {
    if (opts.deadline && Date.now() > opts.deadline) return { results, stopped: "time" };
    if (opts.max && results.filter((r) => r.status !== "has" && r.status !== "ineligible").length >= opts.max) return { results, stopped: "max" };
    const have = (p.product_upcs || []).map((u: any) => ({ id: u.id, upc: u.upc, source: u.source }));
    if (p.deleted_at) { results.push({ id: p.id, status: "skipped", upcs: have, evidence: "Deleted" }); continue; }
    if (have.length && !opts.force) { results.push({ id: p.id, status: "has", upcs: have, evidence: "" }); continue; }
    if (p.upc_status === "rejected" && !opts.force) { results.push({ id: p.id, status: "skipped", upcs: have, evidence: "A manager removed the automatic UPC — add it by hand" }); continue; }
    if (!upcEligible({ title: p.title, platform: p.platform, categoryName: p.category?.name, regionCode: p.region_code })) {
      results.push({ id: p.id, status: "ineligible", upcs: have, evidence: "Not a US game on a known platform — add its UPC by hand" });
      continue;
    }
    await admin.from("products").update({ upc_checked_at: new Date().toISOString() }).eq("id", p.id);
    const look = await findCatalogUpcs(p.title, p.platform);
    let status: UpcStatus = look.status;
    let evidence = look.evidence;
    let upcs = have;
    if (look.status === "found") {
      // Never re-attach a code a manager removed from this listing.
      const rejected: string[] = p.upc_rejected || [];
      const allowed = look.upcs.filter((u) => !rejected.some((r) => barcodeEq(r, u)));
      if (!allowed.length) { status = "rejected"; evidence = `eBay's UPC ${look.upcs.join(", ")} was removed by a manager — add the right one by hand`; }
      const fresh = allowed.filter((u) => !have.some((h: any) => h.upc === u));
      const { added, conflicts } = await attachUpcs(admin, p.id, fresh, "ebay", look.evidence);
      upcs = [...have, ...added];
      if (status === "rejected") { /* evidence set above */ }
      else if (!upcs.length && conflicts.length) { status = "conflict"; evidence = conflicts.join("; "); }
      else if (conflicts.length) evidence += ` — skipped ${conflicts.join("; ")}`;
    }
    await admin.from("products").update({ upc_status: status, upc_checked_at: new Date().toISOString() }).eq("id", p.id);
    results.push({ id: p.id, status, upcs, evidence });
    // Several failures in a row = eBay is down or throttling: stop, resume later.
    errorsInARow = status === "error" ? errorsInARow + 1 : 0;
    if (errorsInARow >= 3) return { results, stopped: "eBay isn't answering — try again later" };
    await sleep(GAP_MS);
  }
  return { results };
}

// How long before the automatic lookup tries a listing again.
// "rejected" = a manager removed the automatic UPC: never automatically again.
// "found" with no UPC left = someone removed it by hand: look again in a month.
const RETRY_DAYS: Record<string, number> = { found: 30, not_found: 30, ambiguous: 60, conflict: 60, error: 1, rejected: Infinity };

/** Listings the automatic lookup should try now: eligible, no UPC yet, not
 *  tried recently — never-tried first, then the longest ago. Rows carry
 *  region_code once the regions migration ran. */
export function needingUpc(rows: any[], now = Date.now()): any[] {
  return rows
    .filter((p) => !(p.product_upcs || []).length && upcEligible({ title: p.title, platform: p.platform, categoryName: p.category?.name, regionCode: p.region_code }))
    .filter((p) => {
      if (!p.upc_checked_at) return true;
      const days = RETRY_DAYS[p.upc_status] ?? 1;
      return now - new Date(p.upc_checked_at).getTime() > days * 86_400_000;
    })
    .sort((a, b) => (a.upc_checked_at ? new Date(a.upc_checked_at).getTime() : 0) - (b.upc_checked_at ? new Date(b.upc_checked_at).getTime() : 0));
}

// The identity's region: "" for the US (eBay's catalog is the US one) / unknown.
const usOrBlank = (code: string | null | undefined) => (code && code.toUpperCase() !== "US" ? code.toUpperCase() : "");

// ---------------------------------------------------------------------------
// The other direction: a scanned UPC → which game is it? (for a box that isn't
// in inventory yet). eBay's catalog names the product; only a catalog product
// whose OWN UPC list holds this exact code counts. Its name is then matched to
// our game database for the official title + box art.
export interface UpcIdentity {
  found: boolean;
  upc: string;
  title?: string;          // official title when the game database knows it, else eBay's (no region tags)
  platform?: string;       // our platform name ("Nintendo 3DS")
  region?: string;         // region code ("JP", "PAL"); "" = unknown / US
  catalogTitle?: string;   // eBay's catalog name, for reference
  cover?: string | null;   // box art (LaunchBox) when matched
  kind?: string;           // "" game | console | accessory | collectible
  inCatalog?: { productId: string; title: string } | null;
  pending?: boolean;       // inCatalog is on an unfinished entry draft
  evidence: string;
  error?: boolean;
}
const EBAY_ID = { searchGtin: searchByGtin, getItem: getItemWithProduct, configured: ebayConfigured };

export async function identifyUpc(admin: any, raw: string, ebay = EBAY_ID): Promise<UpcIdentity> {
  const upc = canonicalUpc(raw);
  if (!upc) return { found: false, upc: String(raw ?? ""), evidence: "That isn't a valid UPC" };
  // Already ours (another station added it since this page loaded)?
  // A listing on an unfinished entry draft says so; a soft-deleted one doesn't count.
  if (admin && (await upcTablesReady(admin))) {
    const rg = (await regionColumnReady(admin)) ? ", region_code" : "";
    const { data } = await admin.from("product_upcs").select(`product_id, product:products(title, deleted_at, pending_entry_id${rg})`).in("upc", upcForms(upc)).limit(5);
    const live = (data || []).find((r: any) => r.product && !r.product.deleted_at);
    if (live) {
      const title = live.product.title || "";
      const region = usOrBlank(live.product.region_code);
      return live.product.pending_entry_id
        ? { found: true, upc, inCatalog: { productId: live.product_id, title }, title, region, pending: true, evidence: "On an unfinished inventory entry" }
        : { found: true, upc, inCatalog: { productId: live.product_id, title }, title, region, evidence: "Already in inventory" };
    }
  }
  if (!ebay.configured()) return { found: false, upc, error: true, evidence: "eBay isn't connected on the server" };
  let res;
  try {
    res = await ebay.searchGtin(upc);
    if (!res.items.length && upc.length === 12) res = await ebay.searchGtin("0" + upc); // some listings carry the EAN-13 form
  } catch (e: any) { return { found: false, upc, error: true, evidence: String(e?.message || e) }; }
  const byProduct = new Map<string, string[]>();
  for (const it of res.items) if (it.epid && it.legacyItemId) byProduct.set(it.epid, [...(byProduct.get(it.epid) ?? []), it.legacyItemId]);
  const ranked = [...byProduct.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, 3);
  if (!ranked.length) return { found: false, upc, evidence: res.items.length ? "eBay has listings with this code but no catalog product" : "eBay doesn't know this code" };
  let failures = 0, read = 0;
  // Before the regions migration a title tag is the only record of an
  // import's region, so it stays in the title (the old behavior).
  const regionField = !admin || regionsOn(await loadRegions(admin));
  for (const [, ids] of ranked) {
    let item: any = null;
    for (const id of ids.slice(0, 2)) {
      await sleep(GAP_MS); // eBay throttles bursts into empty answers
      try { item = await ebay.getItem(id); read++; break; } catch { failures++; }
    }
    const prod = item?.product;
    // The product must carry THIS code (any GTIN form — an import's EAN-13 too).
    if (!prod?.title || !(Array.isArray(prod.gtins) ? prod.gtins : []).some((g: any) => canonicalUpc(String(g)) === upc)) continue;
    const aspects = aspectMap(prod.aspectGroups, item.localizedAspects);
    const platform = (aspects.get("platform") ?? []).map((v) => resolveStaticPlatform(v)).find(Boolean) || resolveStaticPlatform(String(prod.title)) || "";
    // "(Controller Bundle)" / "(Nintendo Selects)" stay as "[…]" tags — the
    // store's own title style — so the base game's box art can still match.
    const clean0 = catalogTitleClean(String(prod.title), platform, { bracketTags: true }) || String(prod.title).trim();
    // A region tag ("(Japan Import)", "(PAL)") is the region field, not the name.
    const tagSplit = splitTitleRegion(clean0);
    const clean = regionField ? tagSplit.title : clean0, tagRegion = tagSplit.code;
    // eBay's Region Code aspect, else a Japanese JAN (13 digits, 45/49), else the tag.
    const region = usOrBlank(regionFromEbayAspect(aspects.get("region code") ?? []) || (/^4[59]\d{11}$/.test(upc) ? "JP" : "") || tagRegion);
    // Judged on eBay's own title, where "(Controller Bundle)" stays in brackets
    // — that's a game with a controller, not an accessory.
    const kind = itemKind(String(prod.title), platform);
    // A game's name loses a trailing " - Nintendo 3DS"; hardware keeps its platform words.
    const catalogTitle = kind ? clean : withoutTrailingPlatform(clean, platform);
    let title = catalogTitle, cover: string | null = null;
    // A game: the game database's official name + box art (same release first).
    const lbp = platform && !kind ? lbPlatform(platform) : null;
    if (admin && lbp) {
      const { data } = await admin.rpc("search_games", { p_query: catalogTitle.replace(/\[[^\]]*\]/g, " ").replace(/\s+/g, " ").trim(), p_platform: lbp, p_limit: 10 });
      const cands: any[] = Array.isArray(data) ? data : [];
      // The official NAME only from the same release ("Halo 3 Legendary
      // Edition" stays itself); the same game's box art is fine for the picture.
      const same = cands.find((c) => sameBoxRelease(catalogTitle, String(c.name ?? ""), platform));
      const art = same || cands.find((c) => sameGameName(catalogTitle, String(c.name ?? ""), platform));
      if (same) title = regionField ? splitTitleRegion(String(same.name)).title : String(same.name);
      if (art) { const f = art.box_3d || art.box_front; cover = f ? lbImageUrl(f) : null; }
    }
    return { found: true, upc, title, platform, region, catalogTitle, cover, kind, inCatalog: null, evidence: `eBay catalog: ${prod.title}` };
  }
  // Nothing readable because eBay failed (not because it doesn't know the code) → retryable.
  if (!read && failures) return { found: false, upc, error: true, evidence: "eBay didn't answer — try again in a moment" };
  return { found: false, upc, evidence: "eBay's catalog products for this code don't list it as their UPC" };
}

