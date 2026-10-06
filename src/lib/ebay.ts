// ============================================================================
// eBay Browse API client — paste-a-listing + bulk-store import.
//
// Uses the application access token (client-credentials OAuth) which can read
// any PUBLIC listing, so no per-seller consent is needed. We target the store
// by seller USERNAME (EBAY_SELLER, e.g. "timelag" — note the store NAME is
// "timelaggaming"). Keys are server-only (EBAY_CLIENT_ID / EBAY_CLIENT_SECRET).
// ============================================================================
import { regionFromEbayAspect, regionFromPlatform, splitTitleRegion } from "./regions";

const TOKEN_URL = "https://api.ebay.com/identity/v1/oauth2/token";
const API = "https://api.ebay.com/buy/browse/v1";
const MARKETPLACE = "EBAY_US";

export const ebayConfigured = () =>
  !!(import.meta.env.EBAY_CLIENT_ID && import.meta.env.EBAY_CLIENT_SECRET);

export const ebaySeller = (): string | null =>
  (import.meta.env.EBAY_SELLER || "").trim() || null;

// ---- app token (cached in-process until ~1 min before expiry) --------------
let cached: { token: string; exp: number } | null = null;
async function appToken(): Promise<string> {
  if (cached && cached.exp > Date.now() + 60_000) return cached.token;
  const basic = btoa(`${import.meta.env.EBAY_CLIENT_ID}:${import.meta.env.EBAY_CLIENT_SECRET}`);
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", authorization: `Basic ${basic}` },
    body: "grant_type=client_credentials&scope=" + encodeURIComponent("https://api.ebay.com/oauth/api_scope"),
  });
  const j = await res.json().catch(() => ({}));
  if (!j.access_token) throw new Error("eBay auth failed: " + (j.error_description || `HTTP ${res.status}`));
  cached = { token: j.access_token, exp: Date.now() + (j.expires_in ?? 7200) * 1000 };
  return cached.token;
}

async function ebayGet(path: string, extra: Record<string, string> = {}): Promise<any> {
  const token = await appToken();
  const res = await fetch(`${API}${path}`, {
    headers: { authorization: `Bearer ${token}`, "X-EBAY-C-MARKETPLACE-ID": MARKETPLACE, ...extra },
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = j?.errors?.[0]?.message || j?.message || `HTTP ${res.status}`;
    throw new Error("eBay: " + msg);
  }
  return j;
}

// Accept a raw numeric id, an eBay item URL, or a messy paste; pull the id out.
export function extractItemId(input: string): string | null {
  const s = String(input || "").trim();
  if (/^\d{9,15}$/.test(s)) return s;
  const url = s.match(/[?&](?:item|iid)=(\d{9,15})/) // ...?item=123456789012
    || s.match(/\/itm\/(?:[^/]+\/)?(\d{9,15})/)        // /itm/Title/123456789012
    || s.match(/(\d{11,15})(?:\D|$)/);                  // last long digit run
  return url ? url[1] : null;
}

// ---- single item -----------------------------------------------------------
// `shipZip` = the buyer's ZIP: without one eBay leaves CALCULATED shipping out.
export const getItem = (legacyItemId: string, shipZip?: string) =>
  ebayGet(`/item/get_item_by_legacy_id?legacy_item_id=${encodeURIComponent(legacyItemId)}`,
    shipZip && /^\d{5}$/.test(shipZip) ? { "X-EBAY-C-ENDUSERCTX": `contextualLocation=${encodeURIComponent(`country=US,zip=${shipZip}`)}` } : {});

/** The cheapest shipping option's cost (cents), or null when eBay gives none
 *  (calculated shipping without a buyer ZIP). */
export function shippingCents(item: any): { cents: number | null; type: string; service: string } {
  const opts = ((item?.shippingOptions || []) as any[])
    .map((o) => ({ cents: o?.shippingCost?.value != null ? Math.round(parseFloat(o.shippingCost.value) * 100) : null, type: String(o?.shippingCostType || ""), service: String(o?.shippingServiceCode || "") }))
    .filter((o) => o.cents != null && Number.isFinite(o.cents));
  if (!opts.length) return { cents: null, type: "", service: "" };
  opts.sort((a, b) => a.cents! - b.cents!);
  return opts[0];
}

// ---- availability (for stock sync) -----------------------------------------
// 404 = listing ended/sold; OUT_OF_STOCK / qty 0 = out of stock. A transient
// error returns "error" so callers can SKIP rather than wrongly zero stock.
export async function checkAvailability(
  legacyItemId: string,
): Promise<{ status: "in_stock" | "out_of_stock" | "ended" | "error"; quantity: number; priceCents?: number; seller?: string }> {
  try {
    const token = await appToken();
    const res = await fetch(`${API}/item/get_item_by_legacy_id?legacy_item_id=${encodeURIComponent(legacyItemId)}`, {
      headers: { authorization: `Bearer ${token}`, "X-EBAY-C-MARKETPLACE-ID": MARKETPLACE },
    });
    if (res.status === 404) return { status: "ended", quantity: 0 };
    if (!res.ok) return { status: "error", quantity: 0 };
    const item = await res.json();
    const av = item.estimatedAvailabilities?.[0];
    const qty = av?.estimatedAvailableQuantity ?? av?.estimatedRemainingQuantity ?? null;
    const priceCents = Math.round(parseFloat(item.price?.value || "0") * 100) || undefined;
    const seller = String(item.seller?.username || "") || undefined;
    if (av?.estimatedAvailabilityStatus === "OUT_OF_STOCK" || qty === 0)
      return { status: "out_of_stock", quantity: 0, priceCents, seller };
    return { status: "in_stock", quantity: qty ?? 1, priceCents, seller };
  } catch {
    return { status: "error", quantity: 0 };
  }
}

// The Browse API can't list a seller's items across ALL categories in one call
// (and the legacy Finding API that could is decommissioned), so we sweep the
// top-level categories a game/collectibles store actually uses and union the
// results. Add more ids here if the store lists in other departments.
const STORE_CATEGORIES = [
  "1249",   // Video Games & Consoles
  "1",      // Collectibles
  "220",    // Toys & Hobbies
  "261328", // Trading Cards
  "267",    // Books & Magazines
  "11232",  // Movies & TV
  "11233",  // Music
  "293",    // Consumer Electronics
  "58058",  // Computers/Tablets & Networking
  "172008", // Gift Cards & Coupons
];

// One page of one category for a seller.
async function sellerPage(username: string, category: string, offset: number) {
  const p = new URLSearchParams({
    category_ids: category,
    filter: `sellers:{${username}}`,
    limit: "200",
    offset: String(offset),
  });
  const j = await ebayGet(`/item_summary/search?${p.toString()}`);
  if ((j.warnings || []).some((w: any) => /username/i.test(w?.message || "")))
    throw new Error(`eBay doesn't recognise seller "${username}"`);
  return { items: (j.itemSummaries || []) as any[], total: (j.total || 0) as number };
}

// Every active listing summary in the seller's store (all categories),
// deduped. Search only returns listings that can be bought, so a listing set
// to 0 on eBay (out of stock) isn't in here.
async function sellerSummaries(username: string): Promise<any[]> {
  const seen = new Map<string, any>(); // id -> summary (dedupes cross-listed)
  for (const cat of STORE_CATEGORIES) {
    let offset = 0;
    for (let page = 0; page < 60; page++) {
      let res;
      try { res = await sellerPage(username, cat, offset); }
      catch (e: any) { if (/recognise seller/.test(e.message)) throw e; break; }
      for (const it of res.items) {
        const id = String(it.legacyItemId || "");
        if (id && !seen.has(id)) seen.set(id, it);
      }
      offset += res.items.length;
      if (!res.items.length || offset >= res.total) break;
    }
  }
  return [...seen.values()];
}

// Enumerate a seller's ENTIRE active store (all categories), deduped. Returns
// lightweight summaries — call getItem(id) per row to fetch full detail.
export async function listSellerItems(
  username: string,
): Promise<{ legacyItemId: string; title: string }[]> {
  return (await sellerSummaries(username)).map((it) => ({ legacyItemId: String(it.legacyItemId), title: it.title || "" }));
}

/** One store listing as the eBay importer's table shows it (no item call). */
export interface StoreListing {
  id: string;
  title: string;
  priceCents: number;
  conditionId: string;
  condition: string;
  /** eBay's category path, leaf first ("Video Games", "Video Games & Consoles"). */
  categories: string[];
  image: string;
  imageCount: number;
  url: string;
}

export async function listSellerStore(username: string): Promise<StoreListing[]> {
  return (await sellerSummaries(username)).map((it) => ({
    id: String(it.legacyItemId),
    title: String(it.title || "").trim(),
    priceCents: Math.round(parseFloat(it.price?.value || "0") * 100) || 0,
    conditionId: String(it.conditionId || ""),
    condition: String(it.condition || ""),
    categories: (it.categories || []).map((c: any) => String(c?.categoryName || "")).filter(Boolean),
    image: it.image?.imageUrl || it.thumbnailImages?.[0]?.imageUrl || "",
    imageCount: (it.image?.imageUrl ? 1 : 0) + (it.additionalImages || []).length,
    url: ebayItemUrl(String(it.legacyItemId)),
  }));
}

/** What the importer needs from one listing's full record (item specifics). */
export interface StoreListingDetails {
  id: string;
  /** eBay's Platform aspect ("Sony PlayStation 3"), "" when none. */
  platform: string;
  /** eBay's Game Name aspect — a clean title for games. */
  gameName: string;
  /** Video Game Series aspect ("Pokemon") — a Game Name equal to it is too generic. */
  series: string;
  /** Merch specifics, for a short built title ("Splatoon 3 Judd & Li'l Judd Alarm Clock"). */
  merch: { game: string; show: string; character: string; type: string; brand: string };
  /** Region Code aspect ("NTSC-J (Japan)"). */
  regionAspect: string;
  /** Country of Origin / Country/Region of Manufacture aspect. */
  country: string;
  qty: number;
  inStock: boolean;
  upc: string;
  completenessCode: string;
  gradeCode: string;
  brand: string;
}

/** A full item record in the store-list shape (Sell Similar works from one
 *  pasted listing, not a store search). */
export function listingFromItem(item: any): StoreListing {
  const images = [item.image?.imageUrl, ...(item.additionalImages || []).map((i: any) => i?.imageUrl)].filter(Boolean);
  return {
    id: String(item.legacyItemId || ""),
    title: String(item.title || "").trim(),
    priceCents: Math.round(parseFloat(item.price?.value || "0") * 100) || 0,
    conditionId: String(item.conditionId || ""),
    condition: String(item.condition || ""),
    // categoryPath is top-level first ("Collectibles|…|Other Animation Merchandise").
    categories: String(item.categoryPath || "").split("|").map((c) => c.trim()).filter(Boolean).reverse(),
    image: images[0] || "",
    imageCount: images.length,
    url: ebayItemUrl(String(item.legacyItemId || "")),
  };
}

/** Is this listing the store's own (EBAY_SELLER)? */
export const isOwnListing = (item: any) => {
  const ours = (ebaySeller() || "").toLowerCase();
  return !!ours && String(item?.seller?.username || "").toLowerCase() === ours;
};

export function storeListingDetails(item: any): StoreListingDetails {
  const aspects = aspectDict(item);
  const title = String(item.title || "").trim();
  const av = item.estimatedAvailabilities?.[0];
  const qty = av?.estimatedAvailableQuantity ?? av?.estimatedRemainingQuantity ?? null;
  return {
    id: String(item.legacyItemId || ""),
    platform: aspects["Platform"] || "",
    gameName: aspects["Game Name"] || "",
    series: aspects["Video Game Series"] || aspects["Franchise"] || "",
    merch: {
      game: aspects["Video Game Name"] || "",
      show: aspects["TV Show"] || aspects["Movie"] || "",
      character: aspects["Character"] || "",
      type: aspects["Type"] || "",
      brand: aspects["Brand"] || "",
    },
    regionAspect: aspects["Region Code"] || "",
    country: aspects["Country of Origin"] || aspects["Country/Region of Manufacture"] || "",
    qty: qty == null ? 1 : Math.max(0, Number(qty) || 0),
    inStock: !(av?.estimatedAvailabilityStatus === "OUT_OF_STOCK" || qty === 0),
    upc: cleanId(aspects["UPC"] || aspects["EAN"] || item.gtin || undefined) || "",
    completenessCode: deriveCompleteness(title, aspects, String(item.conditionId || "")),
    gradeCode: deriveGrade(String(item.conditionId || "")),
    brand: item.brand || aspects["Brand"] || "",
  };
}

// ===========================================================================
// Map a raw eBay item into our product shape.
// ===========================================================================
const strip = (s: string) =>
  String(s || "").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&")
    .replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, " ").trim();

// Turn eBay's HTML description into readable plain text, preserving paragraph
// and list breaks (block tags → newlines) so it renders cleanly on the PDP.
function htmlToText(html: string): string {
  return String(html || "")
    .replace(/<\s*li[^>]*>/gi, "\n• ")
    .replace(/<\s*\/?(br|p|div|h[1-6]|tr|ul|ol)[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&#0?39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"').replace(/&lt;/gi, "<").replace(/&gt;/gi, ">")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function aspectDict(item: any): Record<string, string> {
  const d: Record<string, string> = {};
  for (const a of item.localizedAspects || []) if (a?.name && a?.value) d[a.name] = a.value;
  return d;
}

// eBay categoryPath → one of our category NAMES (resolved to an id server-side).
export function mapCategoryName(item: any): string {
  const path = String(item.categoryPath || "").toLowerCase();
  const top = path.split("|")[0].trim();
  if (top.startsWith("collectible") || /trading card|memorabilia/.test(path)) return "Collectibles";
  if (top.startsWith("toys")) return "Toys";
  if (/(blu-ray|\bdvd\b|movie|film|tv series)/.test(path)) return "Movies";
  if (/(book|strategy guide|magazine)/.test(path)) return "Books";
  if (/console/.test(path) && !/accessor/.test(path)) return "Consoles";
  if (/(accessor|controller|cable|memory card|headset|adapter)/.test(path)) return "Accessories";
  if (/(video game|game)/.test(path)) return "Video Games";
  return "Video Games";
}

// The public eBay listing URL for an item id (used for "View on eBay").
export const ebayItemUrl = (legacyItemId: string) => `https://www.ebay.com/itm/${legacyItemId}`;

// ---- eBay product catalog (for listing UPCs; see upcFinder.ts) --------------
// Video Games (the leaf category under Video Games & Consoles).
const VIDEO_GAMES = "139973";

/** Active eBay listings for a game, each tagged with its eBay CATALOG product
 *  (epid) when the seller listed it against one. */
export async function searchGameListings(q: string, limit = 50): Promise<{ total: number; items: { epid: string; legacyItemId: string; title: string }[] }> {
  const p = new URLSearchParams({ q: q.slice(0, 100), category_ids: VIDEO_GAMES, limit: String(limit) });
  const j = await ebayGet(`/item_summary/search?${p.toString()}`);
  const items = ((j.itemSummaries || []) as any[]).map((it) => ({
    epid: String(it.epid || ""), legacyItemId: String(it.legacyItemId || ""), title: String(it.title || ""),
  }));
  return { total: Number(j.total) || 0, items };
}

/** Active listings for one exact GTIN (UPC/EAN) — any category. */
export async function searchByGtin(gtin: string, limit = 50): Promise<{ total: number; items: { epid: string; legacyItemId: string; title: string }[] }> {
  const p = new URLSearchParams({ gtin, limit: String(limit) });
  const j = await ebayGet(`/item_summary/search?${p.toString()}`);
  const items = ((j.itemSummaries || []) as any[]).map((it) => ({
    epid: String(it.epid || ""), legacyItemId: String(it.legacyItemId || ""), title: String(it.title || ""),
  }));
  return { total: Number(j.total) || 0, items };
}

/** One listing with eBay's catalog product attached: product.title, product.gtins
 *  (eBay's own UPC/EAN list, not what the seller typed), product.aspectGroups. */
export const getItemWithProduct = (legacyItemId: string) =>
  ebayGet(`/item/get_item_by_legacy_id?legacy_item_id=${encodeURIComponent(legacyItemId)}&fieldgroups=PRODUCT`);

// Our completeness code (L / IB / CIB / NEW) inferred from title + specifics.
function deriveCompleteness(title: string, aspects: Record<string, string>, conditionId: string): string {
  const hay = (title + " " + Object.values(aspects).join(" ")).toLowerCase();
  if (conditionId === "1000" || /\b(sealed|factory sealed|brand new)\b/.test(hay)) return "NEW";
  if (/\b(cib|complete in box|complete with box)\b/.test(hay) || /\bcomplete\b/.test(hay)) return "CIB";
  if (/\b(loose|cart only|cartridge only|disc only|game only|no box)\b/.test(hay)) return "L";
  if (/\bno manual\b/.test(hay)) return "IB";
  if (/\b(in box|boxed|with box|\bcib\b)\b/.test(hay)) return "CIB";
  return ""; // unknown — let the user pick
}

// Our grade code (1 Poor / 2 Fair / 3 Great / MINT) from eBay's conditionId.
function deriveGrade(conditionId: string): string {
  switch (conditionId) {
    case "1000": case "2000": case "2010": case "2500": case "2750": return "MINT";
    case "1500": case "1750": case "2020": case "2030": case "3000": case "4000": return "3";
    case "5000": case "6000": return "2";
    case "7000": return "1";
    default: return "3";
  }
}

const cleanId = (v?: string) =>
  v && !/does not apply|^\s*n\/?a\s*$|^\s*none\s*$|^\s*(unbranded|unknown|generic)\s*$/i.test(v) ? v.trim() : null;

export interface MappedItem {
  ebayItemId: string;
  ebayUrl: string;
  title: string;
  priceCents: number;
  currency: string;
  platform: string;
  /** Region code ("JP", "PAL", "US"); "" = default / unknown. */
  region: string;
  brand: string | null;
  mpn: string | null;
  upc: string | null;
  releaseYear: number | null;
  /** Series / franchise / show ("The Legend of Zelda", "Splatoon", "Smiling Friends"). */
  franchise: string | null;
  /** The character(s) a piece of merch is of ("Pikachu", "Judd & Li'l Judd"). */
  character: string | null;
  genre: string | null;
  conditionLabel: string;
  completenessCode: string;
  gradeCode: string;
  categoryName: string;
  description: string;
  primaryImage: string | null;
  images: string[];
  aspects: Record<string, string>;
}

export function mapItem(item: any): MappedItem {
  const aspects = aspectDict(item);
  const title = String(item.title || "").trim();
  const conditionId = String(item.conditionId || "");
  const year = (aspects["Release Year"] || aspects["Year Manufactured"] || aspects["Year"] || "").match(/\b(19[5-9]\d|20[0-4]\d)\b/);
  const meta = (...keys: string[]) => { for (const k of keys) { const v = cleanId(aspects[k]); if (v) return v.slice(0, 120); } return null; };
  const images = [
    item.image?.imageUrl,
    ...(item.additionalImages || []).map((i: any) => i?.imageUrl),
  ].filter(Boolean).filter((u, i, a) => a.indexOf(u) === i).slice(0, 24);
  const desc = htmlToText(item.description || "") || strip(item.shortDescription || "");

  return {
    ebayItemId: String(item.legacyItemId || item.itemId || ""),
    ebayUrl: item.itemWebUrl || "",
    title,
    priceCents: Math.round(parseFloat(item.price?.value || "0") * 100) || 0,
    currency: item.price?.currency || "USD",
    platform: aspects["Platform"] || item.brand || "",
    // The seller's "Region Code" aspect ("Region Free" isn't a market), else a
    // Japan-only platform ("Super Famicom"), else a bracket tag ("[PAL]") —
    // never loose title words: eBay titles are keyword soup.
    region: regionFromEbayAspect(aspects["Region Code"]) || regionFromPlatform(aspects["Platform"] || "").code || splitTitleRegion(title).code,
    // Merch has a Brand; a game's maker is its Publisher.
    brand: meta("Brand") || item.brand || meta("Publisher"),
    mpn: cleanId(item.mpn || aspects["MPN"] || aspects["Model"] || undefined),
    upc: cleanId(aspects["UPC"] || item.gtin || undefined),
    releaseYear: year ? Number(year[0]) : null,
    franchise: meta("Video Game Series", "Franchise", "Series", "TV Show", "Movie", "Video Game Name"),
    character: meta("Character", "Character Family"),
    genre: meta("Genre"),
    conditionLabel: item.condition || "",
    completenessCode: deriveCompleteness(title, aspects, conditionId),
    gradeCode: deriveGrade(conditionId),
    categoryName: mapCategoryName(item),
    description: desc.slice(0, 3000),
    primaryImage: item.image?.imageUrl || images[0] || null,
    images,
    aspects,
  };
}
