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
import { searchGameListings, getItemWithProduct, ebayConfigured } from "./ebay";
import { sameRelease, platformAgrees, regionAgrees, aspectMap, usUpcs, upcEligible, upcForms } from "./upcMatch";
import { withoutTrailingPlatform } from "./smartSearch";
import { fetchAll } from "./fetchAll";

export type UpcStatus = "found" | "not_found" | "ambiguous" | "conflict" | "error";
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

/** Another LISTING already using this code (as its UPC or a condition's
 *  barcode) — its title, or null. Every 12/13/14-digit spelling counts. */
export async function upcOwner(admin: any, upc: string, productId: string): Promise<string | null> {
  const forms = upcForms(upc);
  const { data: u } = await admin.from("product_upcs").select("product_id, product:products(title)").in("upc", forms).neq("product_id", productId).limit(1);
  if (u?.length) return u[0].product?.title || "another listing";
  const { data: v } = await admin.from("product_variants").select("product_id, product:products(title)").in("barcode", forms).neq("product_id", productId).limit(1);
  if (v?.length) return v[0].product?.title || "another listing";
  const { data: b } = await admin.from("product_barcodes").select("variant:product_variants(product_id, product:products(title))").in("barcode", forms).limit(5);
  const other = (b || []).find((r: any) => r.variant && r.variant.product_id !== productId);
  return other ? other.variant.product?.title || "another listing" : null;
}

/** Attach codes to a listing (skipping ones another listing owns). */
export async function attachUpcs(admin: any, productId: string, upcs: string[], source: "ebay" | "manual" | "import", evidence: string | null) {
  const added: { id: string; upc: string; source: string }[] = [];
  const conflicts: string[] = [];
  for (const upc of upcs) {
    const owner = await upcOwner(admin, upc, productId);
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
  const cols = "id, title, platform, deleted_at, upc_status, upc_checked_at, category:categories(name), product_upcs(id, upc, source)";
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
    if (!upcEligible({ title: p.title, platform: p.platform, categoryName: p.category?.name })) {
      results.push({ id: p.id, status: "ineligible", upcs: have, evidence: "Not a US game on a known platform — add its UPC by hand" });
      continue;
    }
    await admin.from("products").update({ upc_checked_at: new Date().toISOString() }).eq("id", p.id);
    const look = await findCatalogUpcs(p.title, p.platform);
    let status: UpcStatus = look.status;
    let evidence = look.evidence;
    let upcs = have;
    if (look.status === "found") {
      const fresh = look.upcs.filter((u) => !have.some((h: any) => h.upc === u));
      const { added, conflicts } = await attachUpcs(admin, p.id, fresh, "ebay", look.evidence);
      upcs = [...have, ...added];
      if (!upcs.length && conflicts.length) { status = "conflict"; evidence = conflicts.join("; "); }
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
const RETRY_DAYS: Record<string, number> = { not_found: 30, ambiguous: 60, conflict: 60, error: 1, rejected: Infinity };

/** Listings the automatic lookup should try now: eligible, no UPC yet, not
 *  tried recently — never-tried first, then the longest ago. */
export function needingUpc(rows: any[], now = Date.now()): any[] {
  return rows
    .filter((p) => !(p.product_upcs || []).length && upcEligible({ title: p.title, platform: p.platform, categoryName: p.category?.name }))
    .filter((p) => {
      if (!p.upc_checked_at) return true;
      const days = RETRY_DAYS[p.upc_status] ?? 1;
      return now - new Date(p.upc_checked_at).getTime() > days * 86_400_000;
    })
    .sort((a, b) => (a.upc_checked_at ? new Date(a.upc_checked_at).getTime() : 0) - (b.upc_checked_at ? new Date(b.upc_checked_at).getTime() : 0));
}
