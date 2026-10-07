// 🔖 "Send to TimeLag" — import a product from another shop's page (Suruga-ya,
// Buyee / Yahoo! Auctions, Mercari, Amazon JP… or any shop) into the Add form.
//
// Those sites can't be read from our server (Suruga-ya sits behind a
// Cloudflare "are you human" check), so a BOOKMARKLET reads the page in the
// owner's own browser — the page they already have open — and hands it to the
// POS tab it opens: in full by postMessage, plus a compact copy in the URL
// #fragment (never sent to any server) in case the browser cuts the link
// between the two tabs. The POS server then pulls out what it can (JSON-LD,
// meta tags) and has the AI write a clean English listing for review.
//
// Pure helpers, shared by the browser (inventory page) and the server.

import { canonicalUpc } from "./upcMatch";

export interface CapturedPage {
  v: 1;
  url: string;
  title: string;                 // document.title
  meta: Record<string, string>;  // og:* / product:* / description …
  ld: unknown[];                 // parsed JSON-LD blocks
  heads: string[];               // h1/h2 + title-ish elements
  crumbs: string[];              // breadcrumb texts
  images: string[];              // absolute image URLs, biggest first
  text: string;                  // the page's visible text (trimmed)
  lang: string;
  offers: SiteOffer[];           // the shop's own condition / price pickers (Suruga-ya)
  vars: Record<string, unknown>; // the shop's item data globals (Buyee: gaItemDetailData / itemData)
  pc: Record<string, string> | null; // a PriceCharting game page, read field by field
}
export interface SiteOffer { label: string; price: number | null; stock: number | null; checked: boolean }

const str = (v: unknown, max: number) => (typeof v === "string" ? v : v == null ? "" : String(v)).replace(/\u0000/g, "").slice(0, max);
const strList = (v: unknown, maxItems: number, maxLen: number) =>
  (Array.isArray(v) ? v : []).map((x) => str(x, maxLen).trim()).filter(Boolean).slice(0, maxItems);

/** An http(s) URL we'd consider fetching / linking: a public host name, no credentials. */
export function publicUrl(raw: unknown): string {
  const s = String(raw ?? "");
  if (s.length > 2048) return "";
  let u: URL;
  try { u = new URL(s); } catch { return ""; }
  if (u.protocol !== "https:" && u.protocol !== "http:") return "";
  if (u.username || u.password) return "";
  if (u.port && u.port !== "80" && u.port !== "443") return "";
  const h = u.hostname.toLowerCase().replace(/\.+$/, ""); // "localhost." = localhost
  // No IP literals (or names that embed one, like 10.0.0.1.nip.io), no local /
  // internal names — the server fetches images. (It also checks DNS.)
  if (!h.includes(".") || /^[\d.]+$/.test(h) || h.includes(":") || h.startsWith("[")) return "";
  if (/(^|[.-])\d{1,3}([.-]\d{1,3}){3}([.-]|$)/.test(h) || /(^|\.)(nip|sslip|xip)\.io$/.test(h)) return "";
  if (/(^|\.)(localhost|local|internal|localdomain|lan|home|corp|intranet|arpa)$/.test(h)) return "";
  return u.href;
}

/** The address without what doesn't name the item (#fragment, tracking parameters). */
export function canonicalUrl(url: string): string {
  try {
    const u = new URL(url);
    u.hash = "";
    for (const k of [...u.searchParams.keys()]) if (/^(utm_|conversiontype$|ref$|ref_|fbclid$|gclid$|spm$|sc_|from$)/i.test(k)) u.searchParams.delete(k);
    return u.href;
  } catch { return url; }
}

/** Validate + trim what a bookmarklet sent (it's untrusted page data). */
export function sanitizeCaptured(raw: any): CapturedPage | null {
  if (!raw || typeof raw !== "object") return null;
  const url = publicUrl(raw.url);
  if (!url) return null;
  const meta: Record<string, string> = {};
  if (raw.meta && typeof raw.meta === "object") {
    for (const [k, v] of Object.entries(raw.meta).slice(0, 40)) {
      const key = str(k, 60).toLowerCase();
      if (key) meta[key] = str(v, 500);
    }
  }
  // JSON-LD: keep it, but bounded (it can carry a whole catalog).
  let ld: unknown[] = Array.isArray(raw.ld) ? raw.ld.slice(0, 12) : [];
  try { if (JSON.stringify(ld).length > 120_000) ld = ld.filter((x) => JSON.stringify(x).length < 30_000).slice(0, 4); } catch { ld = []; }
  return {
    v: 1,
    url,
    title: str(raw.title, 300),
    meta,
    ld,
    heads: strList(raw.heads, 10, 300),
    crumbs: strList(raw.crumbs, 15, 80),
    images: strList(raw.images, 12, 1000).map(publicUrl).filter(Boolean),
    text: str(raw.text, 6000),
    lang: str(raw.lang, 20),
    offers: (Array.isArray(raw.offers) ? raw.offers : []).slice(0, 12).map((o: any) => ({
      label: str(o?.label, 60), price: num(o?.price), stock: o?.stock == null || o?.stock === "" ? null : Number(o.stock) || 0, checked: !!o?.checked,
    })),
    vars: boundedVars(raw.vars),
    pc: raw.pc && typeof raw.pc === "object" && !Array.isArray(raw.pc)
      ? Object.fromEntries(Object.entries(raw.pc).slice(0, 20).map(([k, v]) => [str(k, 30).toLowerCase(), str(v, 300).trim()]))
      : null,
  };
}

// ---- PriceCharting ------------------------------------------------------
/** Market prices (cents) by condition, as saved on a listing (products.market_prices). */
export interface MarketPrices {
  source: "pricecharting"; id: string; url: string; at: string;
  loose: number | null; cib: number | null; new: number | null;
  box: number | null; manual: number | null; graded: number | null;
}
export const MARKET_KEYS = ["loose", "cib", "new", "box", "manual", "graded"] as const;
export type MarketKey = (typeof MARKET_KEYS)[number];
export const MARKET_LABELS: Record<MarketKey, string> = { loose: "Loose", cib: "Complete", new: "New", box: "Box only", manual: "Manual only", graded: "Graded" };
const dollarsToCents = (v: unknown): number | null => {
  const m = String(v ?? "").replace(/,/g, "").match(/\$?\s*(\d+(?:\.\d{1,2})?)/);
  const n = m ? Math.round(Number(m[1]) * 100) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
};
export const isPriceCharting = (url: string) => /(^|\.)pricecharting\.com$/i.test(sourceOf(url).host);
/** A PriceCharting page's market prices + facts (null when it isn't one). */
export function priceChartingFacts(p: CapturedPage, today: string) {
  if (!p.pc || !isPriceCharting(p.url)) return null;
  const pc = p.pc;
  // Only US-dollar game prices: a visitor's other currency (¥ / € / C$) would
  // be read as dollars, and card / comic pages use the same cells for grades.
  const cur = (pc.currency || "USD").replace(/[^A-Za-z$]/g, "").toUpperCase();
  const usd = cur === "USD" || cur === "$" || cur === "";
  const kind = (pc.kind || "").toLowerCase();
  const pricesOk = usd && kind !== "card" && kind !== "comic";
  const c = (v: unknown) => (pricesOk ? dollarsToCents(v) : null);
  const market: MarketPrices = {
    source: "pricecharting", id: (pc.id || "").replace(/\D/g, "").slice(0, 20), url: p.url.split("#")[0].slice(0, 500), at: today,
    loose: c(pc.used), cib: c(pc.complete), new: c(pc.new),
    box: c(pc.box_only), manual: c(pc.manual_only), graded: c(pc.graded),
  };
  const priceNote = !usd ? `PriceCharting is set to ${cur} — switch it to US dollars and click the bookmark again to get the averages.`
    : kind === "card" || kind === "comic" ? "A card / comic page — its prices are by grade, so none were taken." : "";
  // Every barcode it lists — "UPC", "EAN / GTIN" (Japanese / PAL releases),
  // JAN, ISBN — real check-digit codes only, each once ("0045…" = "045…").
  const codes: string[] = [];
  for (const [k, v] of Object.entries(pc)) {
    if (!/^(upc|ean|gtin|jan|isbn)/.test(k)) continue;
    for (const d of String(v).split(/[^\d]+/)) {
      const c = canonicalUpc(d);
      if (c && !codes.includes(c)) codes.push(c);
    }
  }
  const upc = codes[0] ?? "";
  const year = Number((pc["release date"] || "").match(/\b(19[7-9]\d|20\d\d)\b/)?.[1]) || null;
  return { name: (pc.name || "").trim(), console: (pc.console || "").trim(), upc, codes, year, genre: pc.genre || "", publisher: pc.publisher || "", image: publicUrl(pc.image || ""), market, kind, priceNote };
}
/** The market price key a completeness means ("Complete In Box" → cib), by its label. */
export function marketKeyFor(label: string): MarketKey | null {
  const l = String(label || "").toLowerCase();
  if (/box only/.test(l)) return "box";
  if (/manual only/.test(l)) return "manual";
  if (/graded/.test(l)) return "graded";
  if (/new|sealed/.test(l)) return "new";
  if (/complete|cib/.test(l)) return "cib";
  if (/loose|cart(ridge)? only|disc only|game only/.test(l)) return "loose";
  return null;
}
function boundedVars(v: unknown): Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v)) return {};
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v).slice(0, 4)) {
    try { if (/^[A-Za-z_$][\w$]{0,40}$/.test(k) && JSON.stringify(x).length <= 20_000) out[k] = x; } catch { /* circular */ }
  }
  return out;
}

// ---- where it came from --------------------------------------------------
const SOURCES: { test: RegExp; label: string; japan: boolean }[] = [
  { test: /(^|\.)suruga-ya\.(jp|com)$/, label: "Suruga-ya", japan: true },
  { test: /(^|\.)buyee\.jp$/, label: "Buyee", japan: true },
  { test: /(^|\.)auctions\.yahoo\.co\.jp$|(^|\.)page\.auctions\.yahoo\.co\.jp$/, label: "Yahoo! Auctions", japan: true },
  { test: /(^|\.)jp\.mercari\.com$|(^|\.)mercari\.jp$/, label: "Mercari", japan: true },
  { test: /(^|\.)amazon\.co\.jp$/, label: "Amazon JP", japan: true },
  { test: /(^|\.)rakuten\.co\.jp$/, label: "Rakuten", japan: true },
  { test: /(^|\.)amiami\.(jp|com)$/, label: "AmiAmi", japan: true },
  { test: /(^|\.)mandarake\.co\.jp$/, label: "Mandarake", japan: true },
  { test: /(^|\.)zenmarket\.jp$/, label: "ZenMarket", japan: true },
  { test: /(^|\.)fromjapan\.co\.jp$/, label: "FROM JAPAN", japan: true },
  { test: /(^|\.)ebay\.[a-z.]+$/, label: "eBay", japan: false },
  { test: /(^|\.)pricecharting\.com$/, label: "PriceCharting", japan: false },
];

export function sourceOf(url: string): { host: string; label: string; japan: boolean } {
  let host = "";
  try { host = new URL(url).hostname.toLowerCase().replace(/^www\./, ""); } catch { /* not a URL */ }
  const s = SOURCES.find((x) => x.test.test(host));
  return { host, label: s?.label ?? host, japan: s?.japan ?? /\.jp$/.test(host) };
}

/** A shop's own item number from its URL, when it has one (for "already imported?"). */
export function sourceItemId(url: string): string {
  try {
    // Linear: the first item-number-looking segment after a keyword segment.
    const segs = decodeURIComponent(new URL(url).pathname).split("/").filter(Boolean).slice(0, 12);
    const at = segs.findIndex((x) => /^(product|detail|item|items|auction|dp)$/i.test(x));
    if (at < 0) return "";
    return segs.slice(at + 1).find((x) => /^[A-Za-z0-9_:.-]{5,60}$/.test(x) && /\d/.test(x)) ?? "";
  } catch { return ""; }
}

// ---- facts straight from the page (no AI) -------------------------------
export interface PageFacts {
  priceGuess: boolean;      // the price came from loose page text
  name: string;
  nameAlt: string;          // e.g. the Japanese title on suruga-ya.com
  price: number | null;     // in `currency` units
  currency: string;
  condition: string;        // "new" | "used" | ""
  gtin: string;             // JAN / EAN / UPC digits
  images: string[];
  brand: string;
  releaseDate: string;
  description: string;
}

/** A page / og title without the shop's name around it ("駿河屋 -…", "…｜Buyee", "【楽天市場】…"). */
export function stripShopBrand(t: string): string {
  return t
    .replace(/^\s*駿河屋\s*[-－|｜]\s*/, "")
    .replace(/^\s*【楽天市場】\s*/, "")
    .replace(/\s*[/／]?\s*【Buyee】.*$/i, "")
    .replace(/\s*[|｜]\s*(Shop at|Buyee|Mercari|駿河屋|Amazon|楽天).*$/i, "")
    .replace(/\s+-\s+(Buyee|駿河屋|Suruga-ya).*$/i, "")
    .trim();
}

function* walkLd(x: unknown, depth = 0): Generator<any> {
  if (!x || depth > 6) return;
  if (Array.isArray(x)) { for (const y of x) yield* walkLd(y, depth + 1); return; }
  if (typeof x !== "object") return;
  yield x;
  const o = x as any;
  if (o["@graph"]) yield* walkLd(o["@graph"], depth + 1);
}
const isType = (o: any, t: string) => {
  const ty = o?.["@type"];
  return Array.isArray(ty) ? ty.some((x) => String(x).toLowerCase() === t) : String(ty ?? "").toLowerCase() === t;
};
const firstStr = (...vals: unknown[]) => {
  for (const v of vals) {
    if (typeof v === "string" && v.trim()) return v.trim();
    if (typeof v === "number") return String(v);
  }
  return "";
};
const imgOf = (v: unknown): string[] =>
  Array.isArray(v) ? v.flatMap(imgOf) : typeof v === "string" ? [v] : v && typeof v === "object" ? imgOf((v as any).url ?? (v as any).contentUrl) : [];
const num = (v: unknown): number | null => {
  // One number only: "1,980 - 2,980" is a range, not 19802980.
  if (typeof v === "string" && (v.match(/\d[\d,]*(\.\d+)?/g) ?? []).length > 1) return null;
  const n = Number(String(v ?? "").replace(/[^\d.]/g, ""));
  return Number.isFinite(n) && n > 0 ? n : null;
};
const digits = (v: unknown) => String(v ?? "").replace(/\D/g, "");

export function pageFacts(p: CapturedPage): PageFacts {
  const products = [...walkLd(p.ld)].filter((o) => isType(o, "product") || isType(o, "productgroup") || isType(o, "videogame"));
  const prod: any = products[0] ?? {};
  const offersRaw = prod.offers;
  const offers: any[] = Array.isArray(offersRaw) ? offersRaw : offersRaw ? [offersRaw] : [];
  // An AggregateOffer carries lowPrice; a list of offers → the cheapest in stock.
  const priced = offers.flatMap((o: any) => (o?.offers ? (Array.isArray(o.offers) ? o.offers : [o.offers]) : [o]))
    .map((o: any) => ({ o, n: num(o?.price ?? o?.lowPrice) })).filter((x) => x.n != null)
    .sort((a, b) => (/instock/i.test(String(b.o.availability ?? "")) ? 1 : 0) - (/instock/i.test(String(a.o.availability ?? "")) ? 1 : 0) || a.n! - b.n!);
  const best = priced[0];
  const m = p.meta;
  // The shop's own pickers beat JSON-LD (Suruga-ya's JSON-LD carries the list
  // price, not the sale price): the one chosen on the page, else the cheapest in stock.
  const site = p.offers.filter((o) => o.price != null);
  const pick = site.find((o) => o.checked) ?? site.filter((o) => (o.stock ?? 1) > 0).sort((a, b) => a.price! - b.price!)[0] ?? site[0];
  // Buyee: no JSON-LD — its item data globals have the name + yen price.
  const v: any = (p.vars as any).gaItemDetailData ?? (p.vars as any).itemData ?? {};
  const vPrice = num(v.price ?? v.current_price ?? v.priceYen);
  let price = pick?.price ?? best?.n ?? vPrice ?? num(m["product:price:amount"] ?? m["og:price:amount"] ?? m["price"]);
  let currency = firstStr(best?.o?.priceCurrency, offers[0]?.priceCurrency, m["product:price:currency"], m["og:price:currency"], m["pricecurrency"]).toUpperCase()
    || (pick || vPrice != null ? "JPY" : "");
  // Last resort: a yen price in the page text next to a price word —
  // never shipping, buyback or "free over ¥…" amounts. A guess (flagged).
  let priceGuess = false;
  if (price == null) {
    for (const y of p.text.matchAll(/(.{0,12})(?:[¥￥]\s?([\d,]{2,9})|([\d,]{2,9})\s?円)(.{0,6})/g)) {
      const ctx = `${y[1]} ${y[4]}`;
      if (/送料|買取|以上|ポイント|pt|shipping|buyback|over/i.test(ctx)) continue;
      if (!/価格|税込|現在|即決|販売|price|本体/i.test(ctx)) continue;
      price = num(y[2] ?? y[3]); currency = currency || "JPY"; priceGuess = true;
      break;
    }
  }
  const condRaw = (pick ? pick.label : firstStr(best?.o?.itemCondition, offers[0]?.itemCondition, prod.itemCondition, m["product:condition"], m["og:condition"])).toLowerCase();
  const condition = /新品|未開封|new|unopened|sealed/.test(condRaw) ? "new" : /中古|used|refurb|damaged|junk|ジャンク/.test(condRaw) ? "used" : "";
  // JAN / EAN / UPC: the structured one, else a JAN-looking number near "JAN".
  let gtin = [prod.gtin13, prod.gtin, prod.gtin12, prod.gtin14, prod.gtin8, m["product:ean"], m["product:upc"], m["gtin13"]].map(digits).find((d) => /^\d{8}$|^\d{12,14}$/.test(d)) ?? "";
  if (!gtin) { const j = p.text.match(/(?:JAN|EAN|ＪＡＮ)[^\d]{0,12}(\d{13})/i); if (j) gtin = j[1]; }
  const ldImages = imgOf(prod.image).map(publicUrl).filter(Boolean);
  const images = [...new Set([...ldImages, ...(m["og:image"] ? [publicUrl(m["og:image"])] : []).filter(Boolean), ...p.images])].slice(0, 12);
  const name = stripShopBrand(firstStr(prod.name, v.name, v.item_name, p.heads[0], m["og:title"], p.title)).replace(/^\s*[<＜](中古|新品)[>＞]\s*/, "");
  // suruga-ya.com shows "Japanese title: …" under the English one.
  // The original (Japanese) title: an explicit "Japanese title:", else the
  // name itself when it's Japanese (Buyee, suruga-ya.jp), else the first
  // Japanese heading right under it (suruga-ya.com) — never a "you may also
  // like" item further down the page.
  const JP = /[\u3040-\u30ff\u4e00-\u9faf]/;
  const alt = (p.heads.find((h) => /^japanese title\s*[:：]/i.test(h)) || "").replace(/^japanese title\s*[:：]\s*/i, "")
    || (JP.test(name) ? name : p.heads.slice(0, 3).find((h) => h !== name && JP.test(h))) || "";
  // Shop prefixes off the original title: "PS3ソフト …", "<中古>…".
  const cleanAlt = alt.replace(/^\s*[<＜【\[](中古|新品|未使用|ジャンク)[>＞】\]]\s*/, "").replace(/^[A-Za-z0-9０-９Ａ-Ｚａ-ｚ .・ー-]{0,20}ソフト\s+/, "").trim();
  return {
    priceGuess,
    name: name.slice(0, 300),
    nameAlt: cleanAlt.slice(0, 300),
    price,
    currency: currency || (/[¥￥円]/.test(p.text.slice(0, 3000)) ? "JPY" : ""),
    condition,
    gtin,
    images,
    brand: firstStr(prod.brand?.name, prod.brand, prod.manufacturer?.name, prod.manufacturer).slice(0, 120),
    releaseDate: firstStr(prod.releaseDate, prod.datePublished).slice(0, 30),
    description: firstStr(prod.description, m["og:description"], m["description"]).slice(0, 1500),
  };
}

// ---- money --------------------------------------------------------------
export interface SourceImportSettings { jpyPerUsd: number; feePct: number }
export const DEFAULT_JPY_PER_USD = 150;
export function sourceImportSettings(raw: any): SourceImportSettings {
  const s = raw?.sourceImport ?? {};
  const rate = Number(s.jpyPerUsd);
  const fee = Number(s.feePct);
  return {
    jpyPerUsd: Number.isFinite(rate) && rate >= 1 && rate <= 10_000 ? rate : DEFAULT_JPY_PER_USD,
    feePct: Number.isFinite(fee) && fee >= 0 && fee <= 500 ? fee : 0,
  };
}
/** What one copy cost us, in US cents: the shop's price (+ fees %) at the rate. Null = unknown currency. */
export function costCentsFor(price: number | null, currency: string, s: SourceImportSettings): number | null {
  if (price == null || !(price > 0)) return null;
  const c = (currency || "").toUpperCase();
  const withFees = price * (1 + s.feePct / 100);
  if (c === "JPY") return Math.round((withFees / s.jpyPerUsd) * 100);
  if (c === "USD") return Math.round(withFees * 100);
  return null;
}
export const priceText = (price: number | null, currency: string) =>
  price == null ? "" : currency === "JPY" ? `¥${Math.round(price).toLocaleString("en-US")}` : currency === "USD" ? `$${price.toFixed(2)}` : `${price} ${currency}`.trim();

/** The JSON object in an AI answer (tolerates code fences / chatter around it). */
export function parseJsonObject(raw: string): any | null {
  const t = String(raw ?? "").replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
  const a = t.indexOf("{"), z = t.lastIndexOf("}");
  if (a < 0 || z <= a) return null;
  try { const j = JSON.parse(t.slice(a, z + 1)); return j && typeof j === "object" && !Array.isArray(j) ? j : null; } catch { return null; }
}

// ---- the bookmarklet ----------------------------------------------------
// Plain ES5-ish so it runs on any shop page. __POS__ = this POS's origin.
const BOOKMARKLET = `(function(){
var P="__POS__",M="__MODE__";
if(location.origin===P){alert("Open a product page on Suruga-ya, Buyee or another shop, then click this bookmark there.");return;}
if(M==="pc-update"&&!/(^|\.)pricecharting\.com$/i.test(location.hostname)){alert("Open a PriceCharting game page, then click this bookmark there.");return;}
var d=document,T=function(e){return((e&&(e.innerText||e.textContent))||"").replace(/\\s+/g," ").trim()},A=function(u){try{return new URL(u,location.href).href}catch(x){return""}},E=function(s){return[].slice.call(d.querySelectorAll(s))};
var meta={};E("meta[content]").forEach(function(m){var k=(m.getAttribute("property")||m.getAttribute("name")||m.getAttribute("itemprop")||"").toLowerCase();if(k&&/^(og:|product:|twitter:(title|image)|description$|price|pricecurrency|gtin|sku|brand|availability|itemcondition)/.test(k)&&!(k in meta))meta[k]=String(m.content).slice(0,400)});
var ld=[];E('script[type="application/ld+json"]').forEach(function(s){try{ld.push(JSON.parse(s.textContent))}catch(x){}});
var heads=[];E("h1").concat(E("h7,[class*=title_product],[id*=item_title],[class*=itemTitle],[class*=ItemTitle],[class*=item-title],[class*=product-title],[class*=productTitle],[data-testid*=name],[data-testid*=title],h2")).forEach(function(e){var x=T(e);if(x&&x.length<300&&heads.indexOf(x)<0&&heads.length<10)heads.push(x)});
var crumbs=[];E("[class*=readcrumb] a,[class*=readcrumb] li,nav[aria-label*=read] a,[class*=topicpath] a,[class*=pankuzu] a,.cat_navi a,.shopping_item_category_path a").forEach(function(e){var x=T(e);if(x&&x.length<80&&crumbs.indexOf(x)<0&&crumbs.length<15)crumbs.push(x)});
var imgs=[],add=function(u){u=A(u);if(/^https?:/.test(u)&&imgs.indexOf(u)<0&&imgs.length<12)imgs.push(u)};if(meta["og:image"])add(meta["og:image"]);
E("img").filter(function(i){return i.naturalWidth>=160&&i.naturalHeight>=160}).sort(function(a,b){return b.naturalWidth*b.naturalHeight-a.naturalWidth*a.naturalHeight}).slice(0,10).forEach(function(i){add(i.currentSrc||i.src)});
E("a.js-smartPhoto[href],li[data-thumb],img[data-src],img[data-original],img[data-lazy-src]").forEach(function(e){var x=e.getAttribute("href")||e.getAttribute("data-thumb")||e.getAttribute("data-src")||e.getAttribute("data-original")||e.getAttribute("data-lazy-src")||"";if(/\\.(jpe?g|png|webp|gif)([?@#]|$)/i.test(x)&&!/@webp/i.test(x))add(x)});
var offers=[];E("input[name=grade][data-zaiko]").forEach(function(i){try{var z=JSON.parse(i.getAttribute("data-zaiko"));offers.push({label:T(i.closest("label")||i.parentNode).slice(0,60),price:z.price_sale||z.baika,stock:z.zaiko,checked:!!i.checked})}catch(x){}});
E("input[name=variation][data-price]").forEach(function(i){offers.push({label:String(i.getAttribute("data-name")||"").slice(0,60),price:i.getAttribute("data-price"),stock:i.getAttribute("data-stock"),checked:!!i.checked})});
var pc=null;if(/(^|\\.)pricecharting\\.com$/i.test(location.hostname)){pc={};var h=d.querySelector("h1#product_name");if(h){pc.id=h.getAttribute("title")||"";var hc=h.cloneNode(true);[].forEach.call(hc.querySelectorAll("a"),function(x){pc.console=T(x);x.remove()});pc.name=T(hc)}["used","complete","new","graded","box_only","manual_only"].forEach(function(k){var e=d.querySelector("#"+k+"_price .price");if(e)pc[k]=T(e)});E("td.title").forEach(function(td){var k=T(td).replace(/:$/,"").toLowerCase();if(/^(upc|ean.{0,12}|gtin|jan|isbn.{0,8}|asin.{0,12}|epid.{0,8}|pricecharting id|release date|genre|publisher|model number)$/.test(k)&&td.nextElementSibling)pc[k]=T(td.nextElementSibling).slice(0,200)});var vp=window.VGPC&&window.VGPC.product;if(vp)pc.kind=vp.is_card?"card":vp.is_comic?"comic":vp.is_system?"system":"";pc.currency=T(d.getElementById("dropdown_selected_currency"))||(function(){try{return localStorage.getItem("currency")||""}catch(x){return""}})()||"USD";var im=d.querySelector("img[itemprop=image]");if(im)pc.image=A(String(im.getAttribute("src")||"").replace(/\\/240\\.jpg$/,"/1600.jpg"))}
var vars={};["gaItemDetailData","itemData"].forEach(function(k){try{var v=window[k];if(v&&typeof v==="object"){var j=JSON.stringify(v);if(j.length<20000)vars[k]=JSON.parse(j)}}catch(x){}});
var main=d.querySelector("main,#main,[role=main],#content,#item,#itemDetail")||d.body,text=String(main.innerText||"").replace(/[ \\t]+/g," ").replace(/\\n\\s*\\n+/g,"\\n").slice(0,6000);
var p={v:2,url:location.href,title:String(d.title||"").slice(0,300),meta:meta,ld:ld,heads:heads,crumbs:crumbs,images:imgs,text:text,lang:d.documentElement.lang||"",offers:offers.slice(0,12),vars:vars,pc:pc};
try{if(JSON.stringify(p).length>400000){p.ld=[];p.text=text.slice(0,3000)}}catch(x){p.ld=[]}
var L=function(o){var r=[];(function w(x,n){if(!x||n>5||r.length>2)return;if(Array.isArray(x)){x.forEach(function(y){w(y,n+1)});return}if(typeof x!=="object")return;if(/product|videogame/i.test(String(x["@type"]||""))){var f=x.offers;r.push({"@type":"Product",name:x.name,gtin13:x.gtin13,gtin:x.gtin,gtin12:x.gtin12,image:Array.isArray(x.image)?x.image.slice(0,3):x.image,brand:x.brand,releaseDate:x.releaseDate,itemCondition:x.itemCondition,offers:Array.isArray(f)?f.slice(0,5):f})}if(x["@graph"])w(x["@graph"],n+1)})(o,0);return r};
var c={v:2,url:p.url,title:p.title,meta:p.meta,ld:L(ld),heads:p.heads,crumbs:p.crumbs,images:imgs.slice(0,6),text:text.slice(0,1500),lang:p.lang,offers:p.offers,vars:vars,pc:pc};try{if(JSON.stringify(c).length>14000)c.ld=[]}catch(x){c.ld=[]}
var u=P+"/inventory?import="+M+"#tl="+encodeURIComponent(JSON.stringify(c));
var w=window.open(u,"_blank");if(!w){location.href=u;return}
var done=false,on=function(e){if(e.origin!==P||e.source!==w||!e.data||e.data.type!=="tl-ready"||done)return;done=true;try{e.source.postMessage({type:"tl-page",page:p},P)}catch(x){}window.removeEventListener("message",on)};window.addEventListener("message",on);
})();`;

/** What a bookmark does in the POS: "page" = fill the Add form (🔖 Send to
 *  TimeLag); "pc-update" = straight into the matching listing (📈 Update from
 *  PriceCharting — PriceCharting pages only). */
export type BookmarkMode = "page" | "pc-update";
/** The bookmark's address (javascript:…) for this POS. */
export function bookmarkletHref(posOrigin: string, mode: BookmarkMode = "page"): string {
  return "javascript:" + encodeURIComponent(bookmarkletSource(posOrigin, mode).replace(/\n/g, ""));
}
/** The raw script (for tests / "copy the code"). */
export const bookmarkletSource = (posOrigin: string, mode: BookmarkMode = "page") =>
  BOOKMARKLET.replace("__POS__", posOrigin.replace(/[^a-zA-Z0-9:/._-]/g, "")).replace("__MODE__", mode === "pc-update" ? "pc-update" : "page");
