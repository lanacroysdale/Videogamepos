// Collection CSV import — pure logic shared by the inventory entry screen and
// the trade-in screen. No DOM here (see importDialog.ts for the UI).
//
// Reads a PriceCharting collection export (or any spreadsheet with a title /
// platform / condition column), normalizes each row into our two condition
// axes + a canonical platform, then FIND-OR-CREATE matches against the catalog:
//   • same title+platform, same completeness  → the existing variant
//   • same title+platform, other completeness → a NEW VARIANT on that listing
//   • no listing                               → a NEW PRODUCT
// so a loose and a CIB copy of the same game land on one listing.

import type { PlatformAlias, TaxoEntry } from "./smartSearch";
import { barcodeEq } from "./gtin";

/* ---------------- Column detection ---------------- */

export type ColumnKey =
  | "title" | "platform" | "condition" | "qty" | "price" | "cost" | "upc" | "pcId" | "notes"
  | "loosePrice" | "cibPrice" | "newPrice" | "gradedPrice";
export type ColumnMap = Partial<Record<ColumnKey, number>>;

export const COLUMN_DEFS: { key: ColumnKey; label: string; required?: boolean; aliases: string[] }[] = [
  { key: "title", label: "Title", required: true, aliases: ["product name", "product", "title", "game title", "game", "name", "item", "item name", "game name"] },
  { key: "platform", label: "Platform", aliases: ["console name", "console", "platform", "system", "console platform"] },
  { key: "condition", label: "Condition", aliases: ["condition", "completeness", "status", "cond", "item condition", "type"] },
  { key: "qty", label: "Qty", aliases: ["quantity", "qty", "count", "copies", "amount"] },
  { key: "price", label: "Value / Price", aliases: ["value", "price", "current value", "current price", "market value", "resale", "retail", "estimated value", "item value", "total value", "sell price"] },
  { key: "cost", label: "Paid (cost)", aliases: ["price paid", "paid", "cost", "purchase price", "paid price", "cost basis", "bought for", "purchase cost"] },
  { key: "upc", label: "UPC / barcode", aliases: ["upc", "barcode", "ean", "gtin", "upc code"] },
  { key: "pcId", label: "PriceCharting id", aliases: ["id", "pricecharting id", "price charting id", "product id", "pc id", "pricecharting product id"] },
  { key: "notes", label: "Notes", aliases: ["notes", "note", "comments", "comment", "description", "memo"] },
  { key: "loosePrice", label: "Loose price", aliases: ["loose price", "loose", "used price", "loose value"] },
  { key: "cibPrice", label: "CIB price", aliases: ["cib price", "cib", "complete price", "complete", "cib value", "complete in box price"] },
  { key: "newPrice", label: "New price", aliases: ["new price", "new", "sealed price", "new value", "brand new price"] },
  { key: "gradedPrice", label: "Graded price", aliases: ["graded price", "graded", "graded value"] },
];

/** Lowercase, strip accents/punctuation, "&"→"and", collapse whitespace. */
export const norm = (s: string) =>
  String(s ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/['’`]/g, "")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

export function detectColumns(header: string[]): ColumnMap {
  const hs = header.map(norm);
  const map: ColumnMap = {};
  const taken = new Set<number>();
  // Exact alias hits first (longest alias wins ties), then "contains" hits.
  for (const pass of ["exact", "contains"] as const) {
    for (const def of COLUMN_DEFS) {
      if (map[def.key] != null) continue;
      let best = -1, bestLen = 0;
      hs.forEach((h, i) => {
        if (taken.has(i) || !h) return;
        for (const a of def.aliases) {
          const hit = pass === "exact" ? h === a : h.includes(a) && a.length >= 6;
          if (hit && a.length > bestLen) { best = i; bestLen = a.length; }
        }
      });
      if (best >= 0) { map[def.key] = best; taken.add(best); }
    }
  }
  // A bare "id" column is only PriceCharting's product id when the sheet is a
  // PriceCharting export (its console-name / product-name headers are present);
  // a generic sheet's row-number column must never be stored as one.
  if (map.pcId != null && hs[map.pcId] === "id" && !hs.some((h) => /^(console name|product name)$/.test(h))) delete map.pcId;
  return map;
}

export const headerSignature = (header: string[]) => header.map(norm).join("|");

/** Does the first row look like a header (mostly non-numeric, matches ≥1 known column)? */
export function looksLikeHeader(row: string[]): boolean {
  const m = detectColumns(row);
  return m.title != null || Object.keys(m).length >= 2;
}

/* ---------------- Cell parsing ---------------- */

export function parseMoney(raw: string): number | null {
  const s = String(raw ?? "").trim();
  if (!s || /^(n\/?a|-|—|none|null)$/i.test(s)) return null;
  const m = s.replace(/[^0-9.,-]/g, "").replace(/,(?=\d{3}\b)/g, "").replace(/,/, ".");
  const n = parseFloat(m);
  return Number.isFinite(n) ? Math.max(0, Math.round(n * 100)) : null;
}

export function parseQty(raw: string): number {
  const n = parseInt(String(raw ?? "").replace(/[^0-9]/g, ""), 10);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

const REGION_RE = /(^| )(pal|jp|jpn|japan|japanese|asian english|asia|eu|europe|uk|ntsc j)( |$)/;

/** Canonical platform for free text like "Switch - Nintendo" / "PAL Nintendo 64". */
export function resolvePlatform(raw: string, platforms: PlatformAlias[]): { canonical: string | null; region: string | null } {
  let s = " " + norm(raw) + " ";
  if (!s.trim()) return { canonical: null, region: null };
  let region: string | null = null;
  const rm = s.match(REGION_RE);
  if (rm) { region = rm[2].toUpperCase().replace("JAPANESE", "JP").replace("JAPAN", "JP").replace("JPN", "JP").replace("NTSC J", "JP"); s = s.replace(REGION_RE, " "); }
  const all: { canonical: string; alias: string }[] = [];
  for (const p of platforms) for (const a of [p.canonical.toLowerCase(), ...p.aliases]) all.push({ canonical: p.canonical, alias: norm(a) });
  all.sort((x, y) => y.alias.length - x.alias.length);
  for (const m of all) {
    if (!m.alias) continue;
    if (s.includes(" " + m.alias + " ")) return { canonical: m.canonical, region };
  }
  return { canonical: null, region };
}

/** "Loose" / "CIB" / "Brand New" / "Graded" / "Box Only" → our two axes. */
export function resolveCondition(raw: string, completeness: TaxoEntry[], grades: TaxoEntry[]): { completenessCode: string; gradeCode: string; warning: string | null } {
  const s0 = norm(raw);
  if (!s0) return { completenessCode: "", gradeCode: "", warning: null };
  let s = " " + s0 + " ";
  let warning: string | null = null;
  // PriceCharting-specific conditions with no clean equivalent.
  if (/ (box only|manual only|box and manual|manual and box) /.test(s)) {
    return { completenessCode: "", gradeCode: "", warning: `“${raw}” — no game included; set the condition by hand` };
  }
  // One longest-alias-first list across BOTH axes so "like new" (a grade)
  // wins over "new" (a completeness) and "complete in box" over "box".
  const newCode = completeness.find((c) => /new|sealed/i.test(c.code + " " + c.label))?.code || "";
  const all: { axis: "c" | "g"; key: string; alias: string }[] = [];
  for (const c of completeness) for (const a of [c.code, c.label, ...(c.aliases || [])]) { const n = norm(a); if (n) all.push({ axis: "c", key: c.code, alias: n }); }
  for (const g of grades) for (const a of [g.code, g.label, ...(g.aliases || [])]) { const n = norm(a); if (n) all.push({ axis: "g", key: g.code, alias: n }); }
  all.sort((x, y) => y.alias.length - x.alias.length);
  let completenessCode = "", gradeCode = "";
  for (const m of all) {
    if (m.axis === "c" ? completenessCode : gradeCode) continue;
    if (!s.includes(" " + m.alias + " ")) continue;
    s = s.replace(" " + m.alias + " ", " ");
    if (m.axis === "c") completenessCode = m.key; else gradeCode = m.key;
  }
  if (!completenessCode && / graded /.test(s) && newCode) { completenessCode = newCode; warning = `“${raw}” imported as ${newCode} — graded slabs aren't a separate condition`; s = s.replace(" graded ", " "); }
  if (!completenessCode && !gradeCode) warning = `Unrecognized condition “${raw}”`;
  return { completenessCode, gradeCode, warning };
}

/* ---------------- Rows ---------------- */

export interface ImportRow {
  n: number;                 // source line number (1-based, header excluded)
  title: string;
  platform: string;          // canonical (or raw when unresolvable)
  platformRaw: string;
  platformResolved: boolean;
  region: string | null;
  completenessCode: string;
  gradeCode: string;
  gradeFromSheet: boolean;   // the sheet named a grade (else gradeCode is the default)
  conditionRaw: string;
  qty: number;
  priceCents: number | null; // market value from the sheet (condition-specific when available)
  costCents: number | null;
  upc: string;
  pcId: string;
  notes: string;
  warnings: string[];
}

export interface BuildOpts {
  completeness: TaxoEntry[];
  grades: TaxoEntry[];
  platforms: PlatformAlias[];
  defaultCompleteness: string;
  defaultGrade: string;
}

export function buildRows(records: string[][], map: ColumnMap, opts: BuildOpts): ImportRow[] {
  const cell = (r: string[], k: ColumnKey) => (map[k] == null ? "" : String(r[map[k]!] ?? "").trim());
  const out: ImportRow[] = [];
  const byKey = new Map<string, ImportRow>();
  records.forEach((rec, i) => {
    const title0 = cell(rec, "title");
    if (!title0) return;
    const warnings: string[] = [];
    const platformRaw = cell(rec, "platform");
    const pr = resolvePlatform(platformRaw, opts.platforms);
    if (platformRaw && !pr.canonical) warnings.push(`Platform “${platformRaw}” not recognized — kept as typed`);
    if (!platformRaw) warnings.push("No platform");
    const conditionRaw = cell(rec, "condition");
    const cond = resolveCondition(conditionRaw, opts.completeness, opts.grades);
    if (cond.warning) warnings.push(cond.warning);
    const completenessCode = cond.completenessCode || opts.defaultCompleteness;
    if (!cond.completenessCode && !conditionRaw) warnings.push(`No condition — defaulted to ${completenessCode || "none"}`);
    const gradeCode = cond.gradeCode || opts.defaultGrade;
    // Price: an explicit value column wins; else the condition-specific guide
    // column (loose / cib / new) from a PriceCharting export.
    let priceCents = parseMoney(cell(rec, "price"));
    if (priceCents == null) {
      const c = completenessCode.toUpperCase();
      const k: ColumnKey | null = /NEW|SEALED/.test(c) ? "newPrice" : /^L$|LOOSE/.test(c) ? "loosePrice" : c ? "cibPrice" : null;
      if (k) priceCents = parseMoney(cell(rec, k));
      if (priceCents == null && map.gradedPrice != null && /graded/i.test(conditionRaw)) priceCents = parseMoney(cell(rec, "gradedPrice"));
    }
    let title = title0.replace(/\s+/g, " ");
    if (pr.region && pr.region !== "NTSC") title = `${title} [${pr.region}]`;
    const row: ImportRow = {
      n: i + 1, title,
      platform: pr.canonical || platformRaw, platformRaw, platformResolved: !!pr.canonical, region: pr.region,
      completenessCode, gradeCode, gradeFromSheet: !!cond.gradeCode, conditionRaw,
      qty: parseQty(cell(rec, "qty")),
      priceCents, costCents: parseMoney(cell(rec, "cost")),
      upc: cell(rec, "upc").replace(/[^0-9]/g, ""), pcId: /^\d+$/.test(cell(rec, "pcId")) ? cell(rec, "pcId") : "",
      notes: cell(rec, "notes"), warnings,
    };
    // Same title + platform + condition twice in the sheet → one line, summed qty.
    const key = [norm(row.title), norm(row.platform), row.completenessCode, row.gradeCode].join("|");
    const dup = byKey.get(key);
    if (dup) {
      dup.qty += row.qty;
      if (dup.priceCents == null) dup.priceCents = row.priceCents;
      if (!dup.warnings.some((w) => w.startsWith("Merged"))) dup.warnings.push("Merged duplicate rows");
      return;
    }
    byKey.set(key, row);
    out.push(row);
  });
  return out;
}

/* ---------------- Catalog matching ---------------- */

export interface CatalogVariant {
  id?: string;
  completenessCode: string;
  gradeCode: string;
  priceCents: number;
  barcodes: string[];
  quantity?: number;
}
export interface CatalogProduct {
  id: string;
  title: string;
  platform: string;
  franchise?: string;
  altNames?: string[];
  categoryId: string | null;
  pcId?: string;
  variants: CatalogVariant[];
}
export interface Candidate { product: CatalogProduct; score: number }
export type MatchStatus = "variant" | "new-variant" | "new-product" | "review";
export interface RowMatch {
  status: MatchStatus;
  product: CatalogProduct | null;
  variant: CatalogVariant | null;
  candidates: Candidate[];
}

export const AUTO_MATCH = 0.92;
export const REVIEW_MATCH = 0.6;

const stripBrackets = (s: string) => s.replace(/\[[^\]]*\]|\([^)]*\)/g, " ");
const dropArticle = (s: string) => s.replace(/^(the|a|an) /, "").replace(/ (the|a|an)$/, "");
const bigrams = (s: string) => {
  const t = " " + s + " ";
  const set = new Map<string, number>();
  for (let i = 0; i < t.length - 1; i++) { const b = t.slice(i, i + 2); set.set(b, (set.get(b) || 0) + 1); }
  return set;
};
function dice(a: Map<string, number>, b: Map<string, number>): number {
  let inter = 0, na = 0, nb = 0;
  for (const v of a.values()) na += v;
  for (const v of b.values()) nb += v;
  if (!na || !nb) return 0;
  for (const [k, v] of a) { const w = b.get(k); if (w) inter += Math.min(v, w); }
  return (2 * inter) / (na + nb);
}
// Arabic AND roman numerals: "Final Fantasy VII" vs "VIII" must never auto-match.
const numbers = (s: string) => (s.match(/\b(?:\d+|(?=[ivx])x{0,3}(?:ix|iv|v?i{0,3}))\b/g) || []).filter(Boolean).join(",");

interface Prepared {
  product: CatalogProduct;
  platform: string | null;
  names: { full: string; bare: string; grams: Map<string, number>; nums: string }[];
}

export function prepareCatalog(catalog: CatalogProduct[], platforms: PlatformAlias[]): Prepared[] {
  return catalog.map((product) => {
    const names = [product.title, ...(product.altNames || [])].filter(Boolean).map((t) => {
      const full = dropArticle(norm(t));
      const bare = dropArticle(norm(stripBrackets(t))) || full;
      return { full, bare, grams: bigrams(bare), nums: numbers(bare) };
    });
    return { product, platform: resolvePlatform(product.platform || "", platforms).canonical, names };
  });
}

function titleScore(rowFull: string, rowBare: string, rowGrams: Map<string, number>, rowNums: string, region: string | null, p: Prepared): number {
  let best = 0;
  const reg = region ? norm(region) : "";
  for (const n of p.names) {
    let s: number;
    if (n.full === rowFull) s = 1;
    else if (n.bare === rowBare) s = 0.95;
    else {
      s = dice(rowGrams, n.grams);
      // "Mario Party 8" vs "Mario Party 9": different numbers can never auto-match.
      if (s >= AUTO_MATCH && n.nums !== rowNums) s = 0.85;
    }
    // A PAL / JP copy is a different product from the NTSC listing → review.
    if (reg && s >= AUTO_MATCH && !n.full.includes(reg)) s = 0.85;
    if (s > best) best = s;
  }
  return best;
}

export function pickVariant(product: CatalogProduct, completenessCode: string, gradeCode: string, gradeFromSheet: boolean): CatalogVariant | null {
  const vs = product.variants || [];
  if (!vs.length) return null;
  const same = vs.filter((v) => (v.completenessCode || "") === (completenessCode || ""));
  if (!same.length) return null;
  if (gradeFromSheet) return same.find((v) => (v.gradeCode || "") === (gradeCode || "")) || null;
  return same.find((v) => (v.gradeCode || "") === (gradeCode || "")) || same[0];
}

export function matchRow(row: ImportRow, prepared: Prepared[], platforms: PlatformAlias[]): RowMatch {
  const gradeFromSheet = row.gradeFromSheet;
  const rowPlatform = resolvePlatform(row.platform, platforms).canonical;
  const rowPlatNorm = norm(row.platform);
  const rowFull = dropArticle(norm(row.title));
  const rowBare = dropArticle(norm(stripBrackets(row.title))) || rowFull;
  const rowGrams = bigrams(rowBare);
  const rowNums = numbers(rowBare);
  const cands: Candidate[] = [];
  for (const p of prepared) {
    let score = 0;
    if (row.pcId && p.product.pcId && p.product.pcId === row.pcId) score = 1;
    else if (row.upc && p.product.variants.some((v) => (v.barcodes || []).some((b) => barcodeEq(b, row.upc)))) score = 1;
    else {
      // Platform gate: both resolved → must be equal; otherwise loose substring.
      const pp = norm(p.product.platform || "");
      if (rowPlatform && p.platform) { if (rowPlatform !== p.platform) continue; }
      else if (rowPlatNorm && pp) { if (!(pp.includes(rowPlatNorm) || rowPlatNorm.includes(pp))) continue; }
      score = titleScore(rowFull, rowBare, rowGrams, rowNums, row.region, p);
      if (!pp && score < 1) score *= 0.9; // platform-less listing: a little less sure
    }
    if (score >= REVIEW_MATCH) cands.push({ product: p.product, score });
  }
  cands.sort((a, b) => b.score - a.score);
  const top = cands[0];
  if (top && top.score >= AUTO_MATCH) {
    const variant = pickVariant(top.product, row.completenessCode, row.gradeCode, gradeFromSheet);
    return { status: variant ? "variant" : "new-variant", product: top.product, variant, candidates: cands.slice(0, 5) };
  }
  return { status: top ? "review" : "new-product", product: null, variant: null, candidates: cands.slice(0, 5) };
}

export interface ResolvedRow {
  row: ImportRow;
  match: RowMatch;
  product: CatalogProduct | null;   // chosen listing (null = create a new product)
  variant: CatalogVariant | null;   // chosen existing variant (null = create one)
  skip: boolean;
}

/** Apply a user's pick (product id or "" for new) to a row. */
export function chooseProduct(r: ResolvedRow, product: CatalogProduct | null) {
  r.product = product;
  r.variant = product ? pickVariant(product, r.row.completenessCode, r.row.gradeCode, r.row.gradeFromSheet) : null;
}
