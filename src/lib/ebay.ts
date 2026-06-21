// ============================================================================
// eBay Browse API client — paste-a-listing + bulk-store import.
//
// Uses the application access token (client-credentials OAuth) which can read
// any PUBLIC listing, so no per-seller consent is needed. We target the store
// by seller USERNAME (EBAY_SELLER, e.g. "timelag" — note the store NAME is
// "timelaggaming"). Keys are server-only (EBAY_CLIENT_ID / EBAY_CLIENT_SECRET).
// ============================================================================
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

async function ebayGet(path: string): Promise<any> {
  const token = await appToken();
  const res = await fetch(`${API}${path}`, {
    headers: { authorization: `Bearer ${token}`, "X-EBAY-C-MARKETPLACE-ID": MARKETPLACE },
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
export const getItem = (legacyItemId: string) =>
  ebayGet(`/item/get_item_by_legacy_id?legacy_item_id=${encodeURIComponent(legacyItemId)}`);

// ---- availability (for stock sync) -----------------------------------------
// 404 = listing ended/sold; OUT_OF_STOCK / qty 0 = out of stock. A transient
// error returns "error" so callers can SKIP rather than wrongly zero stock.
export async function checkAvailability(
  legacyItemId: string,
): Promise<{ status: "in_stock" | "out_of_stock" | "ended" | "error"; quantity: number; priceCents?: number }> {
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
    if (av?.estimatedAvailabilityStatus === "OUT_OF_STOCK" || qty === 0)
      return { status: "out_of_stock", quantity: 0, priceCents };
    return { status: "in_stock", quantity: qty ?? 1, priceCents };
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

// Enumerate a seller's ENTIRE active store (all categories), deduped. Returns
// lightweight summaries — call getItem(id) per row to fetch full detail.
export async function listSellerItems(
  username: string,
): Promise<{ legacyItemId: string; title: string }[]> {
  const seen = new Map<string, string>(); // id -> title (dedupes cross-listed)
  for (const cat of STORE_CATEGORIES) {
    let offset = 0;
    for (let page = 0; page < 60; page++) {
      let res;
      try { res = await sellerPage(username, cat, offset); }
      catch (e: any) { if (/recognise seller/.test(e.message)) throw e; break; }
      for (const it of res.items) {
        const id = String(it.legacyItemId || "");
        if (id && !seen.has(id)) seen.set(id, it.title || "");
      }
      offset += res.items.length;
      if (!res.items.length || offset >= res.total) break;
    }
  }
  return [...seen.entries()].map(([legacyItemId, title]) => ({ legacyItemId, title }));
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
  v && !/does not apply|n\/?a|none/i.test(v) ? v.trim() : null;

export interface MappedItem {
  ebayItemId: string;
  ebayUrl: string;
  title: string;
  priceCents: number;
  currency: string;
  platform: string;
  brand: string | null;
  mpn: string | null;
  upc: string | null;
  releaseYear: number | null;
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
  const year = (aspects["Release Year"] || aspects["Year Manufactured"] || "").match(/\d{4}/);
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
    brand: item.brand || aspects["Brand"] || null,
    mpn: cleanId(item.mpn || aspects["MPN"] || aspects["Model"] || undefined),
    upc: cleanId(aspects["UPC"] || item.gtin || undefined),
    releaseYear: year ? Number(year[0]) : null,
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
