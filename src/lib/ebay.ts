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
// Top-level "Video Games & Consoles" meta-category — captures a game store's
// whole catalogue (games, consoles, accessories) for bulk import.
const VIDEO_GAMES_CAT = "1249";

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

// ---- seller's store (bulk) — paginated summaries ---------------------------
export async function searchSeller(
  username: string,
  { limit = 50, offset = 0 }: { limit?: number; offset?: number } = {},
): Promise<{ items: any[]; total: number }> {
  const p = new URLSearchParams({
    category_ids: VIDEO_GAMES_CAT,
    filter: `sellers:{${username}}`,
    limit: String(Math.min(200, limit)),
    offset: String(offset),
  });
  const j = await ebayGet(`/item_summary/search?${p.toString()}`);
  if ((j.warnings || []).some((w: any) => /username/i.test(w?.message || "")))
    throw new Error(`eBay doesn't recognise seller "${username}"`);
  return { items: j.itemSummaries || [], total: j.total || 0 };
}

// ===========================================================================
// Map a raw eBay item into our product shape.
// ===========================================================================
const strip = (s: string) =>
  String(s || "").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&")
    .replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, " ").trim();

function aspectDict(item: any): Record<string, string> {
  const d: Record<string, string> = {};
  for (const a of item.localizedAspects || []) if (a?.name && a?.value) d[a.name] = a.value;
  return d;
}

// eBay categoryPath → one of our category NAMES (resolved to an id server-side).
export function mapCategoryName(item: any): string {
  const path = String(item.categoryPath || "").toLowerCase();
  if (/(blu-ray|\bdvd\b|movie|film|tv series)/.test(path)) return "Movies";
  if (/(book|strategy guide|magazine)/.test(path)) return "Books";
  if (/(console)/.test(path) && !/accessor/.test(path)) return "Consoles";
  if (/(accessor|controller|cable|memory card|headset|adapter)/.test(path)) return "Accessories";
  if (/(video game|game)/.test(path)) return "Video Games";
  return "Video Games";
}

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
  const desc = strip(item.shortDescription || "") || strip(item.description || "");

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
    description: desc.slice(0, 800),
    primaryImage: item.image?.imageUrl || images[0] || null,
    images,
    aspects,
  };
}
