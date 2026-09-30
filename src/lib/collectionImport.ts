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

import { PLATFORM_ALIASES, resolveStaticPlatforms, platformNameExact, withoutTrailingPlatform, type PlatformAlias, type TaxoEntry } from "./smartSearch";

// Built-in platform names — catalog-only spellings are treated more strictly.
const BUILTIN = new Set(PLATFORM_ALIASES.map((p) => p.canonical));
import { barcodeEq } from "./gtin";

/* ---------------- Column detection ---------------- */

export type ColumnKey =
  | "title" | "platform" | "condition" | "grade" | "qty" | "price" | "pcValue" | "cost" | "upc" | "pcId" | "notes" | "folder"
  | "loosePrice" | "cibPrice" | "newPrice" | "gradedPrice";
export type ColumnMap = Partial<Record<ColumnKey, number>>;

export const COLUMN_DEFS: { key: ColumnKey; label: string; required?: boolean; aliases: string[] }[] = [
  { key: "title", label: "Title", required: true, aliases: ["product name", "product", "title", "game title", "game", "name", "item", "item name", "game name"] },
  { key: "platform", label: "Platform", aliases: ["console name", "console", "platform", "system", "console platform"] },
  // PriceCharting's raw export: include-string = completeness ("Item, Box, and
  // Manual"), condition-string = cosmetic grade ("Normal wear").
  { key: "condition", label: "Condition", aliases: ["condition", "completeness", "status", "cond", "item condition", "type", "include string"] },
  { key: "grade", label: "Grade", aliases: ["grade", "condition string", "cosmetic condition"] },
  { key: "qty", label: "Qty", aliases: ["quantity", "qty", "count", "copies", "number of copies"] },
  { key: "price", label: "Value / Price", aliases: ["value", "price", "sell price", "selling price", "our price", "asking price", "current value", "current price", "market value", "resale", "retail", "estimated value", "item value", "total value"] },
  // The market guide price, kept apart from the store's own sell price. Raw
  // PriceCharting exports call it price-in-pennies. With no sell-price column
  // it becomes the price.
  { key: "pcValue", label: "PriceCharting value", aliases: ["pricecharting value", "price charting value", "pricecharting price", "price charting price", "pricecharting", "price charting", "pc value", "pc price", "price in pennies"] },
  { key: "cost", label: "Paid (cost)", aliases: ["price paid", "paid", "cost", "purchase price", "paid price", "cost basis", "bought for", "purchase cost", "cost basis in pennies", "cash value", "cash offer", "cash price", "buy price", "offer price", "trade offer"] },
  { key: "upc", label: "UPC / barcode", aliases: ["upc", "barcode", "ean", "gtin", "upc code"] },
  { key: "pcId", label: "PriceCharting id", aliases: ["id", "pricecharting id", "price charting id", "product id", "pc id", "pricecharting product id"] },
  { key: "notes", label: "Notes", aliases: ["notes", "note", "comments", "comment", "description", "memo"] },
  { key: "loosePrice", label: "Loose price", aliases: ["loose price", "loose", "used price", "loose value"] },
  { key: "cibPrice", label: "CIB price", aliases: ["cib price", "cib", "complete price", "complete", "cib value", "complete in box price"] },
  { key: "newPrice", label: "New price", aliases: ["new price", "new", "sealed price", "new value", "brand new price"] },
  { key: "gradedPrice", label: "Graded price", aliases: ["graded price", "graded", "graded value"] },
  { key: "folder", label: "Folder", aliases: ["folder", "collection folder"] },
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
  // A bare "id" / "product id" column is only PriceCharting's product id when
  // the sheet IS a PriceCharting export; another system's ids (or a row-number
  // column) must never be stored as one — they'd match at 100% forever.
  const pcExport = (hs.includes("product name") && hs.includes("console name")) || hs.includes("price in pennies") || hs.includes("include string");
  // Only an explicitly-PriceCharting header survives on a non-PriceCharting
  // sheet — "eBay Product ID" / "Shopify Product ID" (contains-pass hits) don't.
  if (map.pcId != null && !/^(pricecharting id|price charting id|pc id|pricecharting product id)$/.test(hs[map.pcId]) && !pcExport) delete map.pcId;
  return map;
}

export const headerSignature = (header: string[]) => header.map(norm).join("|");

/** Money columns whose header says they're whole cents ("price-in-pennies"). */
export function centsColumns(header: string[], map: ColumnMap): Partial<Record<ColumnKey, boolean>> {
  const out: Partial<Record<ColumnKey, boolean>> = {};
  for (const k of ["price", "pcValue", "cost", "loosePrice", "cibPrice", "newPrice", "gradedPrice"] as ColumnKey[]) {
    const i = map[k];
    if (i != null && / (pennies|cents)( |$)/.test(" " + norm(header[i] ?? ""))) out[k] = true;
  }
  return out;
}

/** Does the first row look like a header (mostly non-numeric, matches ≥1 known column)? */
export function looksLikeHeader(row: string[]): boolean {
  const m = detectColumns(row);
  return m.title != null || Object.keys(m).length >= 2;
}

/* ---------------- Cell parsing ---------------- */

export function parseMoney(raw: string): number | null {
  const s = String(raw ?? "").trim();
  if (!s || /^(n\/?a|-|—|none|null)$/i.test(s)) return null;
  let m = s.replace(/[^0-9.,-]/g, "");
  const lastDot = m.lastIndexOf("."), lastComma = m.lastIndexOf(",");
  if (lastDot >= 0 && lastComma >= 0) {
    // Both separators: the later one is the decimal ("1,093.50" / "1.093,50").
    m = lastComma > lastDot ? m.replace(/\./g, "").replace(",", ".") : m.replace(/,/g, "");
  } else if (lastComma >= 0) {
    // "1,093" / "12,345,678" = thousands; "12,50" = decimal comma.
    m = /^-?\d{1,3}(,\d{3})+$/.test(m) ? m.replace(/,/g, "") : m.replace(/,(?=[^,]*$)/, ".").replace(/,/g, "");
  } else if (/^-?\d{1,3}(\.\d{3}){2,}$/.test(m)) {
    m = m.replace(/\./g, ""); // "1.234.567"
  }
  const n = parseFloat(m);
  return Number.isFinite(n) ? Math.max(0, Math.round(n * 100)) : null;
}

/** A whole-cents cell ("2511" → 2511). */
export function parseCents(raw: string): number | null {
  const s = String(raw ?? "").replace(/[^0-9.-]/g, "");
  if (!s) return null;
  const n = Math.round(parseFloat(s));
  return Number.isFinite(n) ? Math.max(0, n) : null;
}

/** "2", "2.0", "1.00" (Excel number format), "3 copies" → a whole count. */
export function parseQty(raw: string): number {
  const tok = String(raw ?? "").match(/\d+(?:[.,]\d+)*/)?.[0] ?? "";
  // "1,200" = thousands; "1,00" / "2,0" = a decimal comma (European sheets).
  const t = /^\d{1,3}(,\d{3})+$/.test(tok) ? tok.replace(/,/g, "") : tok.replace(/,(?=\d+$)/, ".").replace(/,/g, "");
  const n = t ? Math.round(parseFloat(t)) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 1;
}

const REGION_RE = /(^| )(pal|jp|jpn|japan|japanese|asian english|asia|eu|europe|uk|ntsc j)( |$)/;
const IMPLIED_JP_RE = /(^| )(super famicom|famicom|famicom disk system|sfc|pc engine|pc engine cd|pc engine duo)( |$)/;

/** Canonical platform for free text like "Switch - Nintendo" / "PAL Nintendo 64". */
export function resolvePlatform(raw: string, platforms: PlatformAlias[]): { canonical: string | null; region: string | null } {
  let s = " " + norm(raw) + " ";
  if (!s.trim()) return { canonical: null, region: null };
  let region: string | null = null;
  const rm = s.match(REGION_RE);
  if (rm) { region = rm[2].toUpperCase().replace("JAPANESE", "JP").replace("JAPAN", "JP").replace("JPN", "JP").replace("NTSC J", "JP"); s = s.replace(REGION_RE, " "); }
  // PriceCharting names Japanese consoles without a "JP" prefix.
  else if (IMPLIED_JP_RE.test(s)) region = "JP";
  // Built-in platforms first, by their OWN aliases only — a catalog spelling
  // ("Nintendo Game Boy", "Microsoft Xbox") must never outrank a longer
  // platform ("… Game Boy Color", "… Xbox 360"). A catalog-ONLY spelling
  // ("Game & Watch", "Amiibo") must equal the WHOLE text: as a substring, a
  // stray "nintendo" would swallow "Switch - Nintendo" and every row after it.
  const builtin = resolveStaticPlatforms(s)[0];
  if (builtin) return { canonical: builtin, region };
  const whole = s.trim();
  for (const p of platforms) {
    if (BUILTIN.has(p.canonical)) continue;
    if ([p.canonical, ...p.aliases].some((a) => norm(a) === whole)) return { canonical: p.canonical, region };
  }
  return { canonical: null, region };
}

// Common spreadsheet + PriceCharting-export phrasings → words the store's
// condition aliases know.
const CONDITION_SYNONYMS: Record<string, string> = {
  "item box and manual": "cib",
  "game box and manual": "cib",
  "cart box and manual": "cib",
  "cartridge box and manual": "cib",
  "disc box and manual": "cib",
  "new item box and manual": "new",
  "item only": "loose",
  "game only": "loose",
  "console only": "loose",
  "system only": "loose",
  "unit only": "loose",
  "cart only": "loose",
  "cartridge only": "loose",
  "disc only": "loose",
  "item and box only": "in box",
  "game and box only": "in box",
  "item and manual only": "loose",
  "game and manual only": "loose",
};
const MANUAL_NO_BOX = new Set(["item and manual only", "game and manual only"]);
const PC_GRADE: Record<string, string> = {
  "normal wear": "",   // PriceCharting's default → the store's default grade
  "no blemishes": "mint",
  "scratches": "fair",
};

/** "Loose" / "CIB" / "Brand New" / "Graded" / "Box Only" → our two axes. */
export function resolveCondition(raw: string, completeness: TaxoEntry[], grades: TaxoEntry[]): { completenessCode: string; gradeCode: string; warning: string | null } {
  const s0 = CONDITION_SYNONYMS[norm(raw)] ?? norm(raw);
  if (!s0) return { completenessCode: "", gradeCode: "", warning: null };
  let s = " " + s0 + " ";
  let warning: string | null = null;
  // PriceCharting-specific conditions with no clean equivalent.
  if (/^ (box only|manual only|box and manual|manual and box|box and manual only|manual and box only) $/.test(s)) {
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
  folder: string;
  pcValueCents: number | null; // PriceCharting / market guide value from the sheet
  kind: "" | "console" | "accessory" | "collectible"; // "" = a game (or unknown)
  lot: boolean;                // "Bulk …" / "Lot of …" — a lot, not one sellable item
  titleFrom?: string;          // the sheet's own title when replaced by the official one
  warnings: string[];
}

export interface BuildOpts {
  completeness: TaxoEntry[];
  grades: TaxoEntry[];
  platforms: PlatformAlias[];
  defaultCompleteness: string;
  defaultGrade: string;
  /** Money columns holding whole cents (see centsColumns). */
  cents?: Partial<Record<ColumnKey, boolean>>;
  /** Only rows in this folder; "" = rows with no folder; null/undefined = all. */
  folder?: string | null;
}

const fmtCents = (c: number) => "$" + (c / 100).toFixed(2);
// "… x 8", "… x2" (lowercase x — "Mega Man X2" is a title), "DS Bulk Loose …",
// "Lot of …". Not "Bundle": PriceCharting names real single products that way.
const LOT_X_RE = /(^|\s)[x×]\s?\d+\s*$/;
const LOT_WORDS_RE = /\bbulk\s+(lot|loose|games?|carts?|cartridges?|discs?|grade)\b|\blot\s+of\b|\b(games?|carts?|discs?)\s+lot\b|^lot\b/i;
// Not bare "broken" — "Broken Sword", "Broken Age" are games.
const PARTS_RE = /\b(defective|for parts|parts only|not working)\b|\(broken\)|\bbroken (screen|hinge|shell|console|unit|joystick)\b/i;
// Consoles/handhelds by name, incl. PriceCharting's naming ("Original Gameboy
// System", "Nintendo Switch Lite: …", "Pearl Blue Gameboy Advance SP"). A bare
// "3DS" is a platform word in game titles, so it needs XL/LL; "System Shock"
// is a game, so "system" must end the name or precede a bracket.
const CONSOLE_RE = /\b(console|handheld system)\b|\bsystem\s*$|\b(new\s)?(2ds|3ds|dsi)\s?(xl|ll)\b|\b(new\s)?2ds\b|\bds\s?lite\b|\b(advance|gba)\s?sp\b|\b(gba|game ?boy)\s?micro\b|\bgame ?boy (pocket|light)\b|\bswitch (lite|oled)\b|\bclassic mini\b|\b(nes|snes|super nintendo|nintendo|famicom|genesis|playstation) classic( edition)?\b|\banalogue pocket\s*$/i;
const ACCESSORY_RE = /\b(controllers?|joy-?cons?|nunchuks?|wii (u )?remote|remote plus|ac adapter|power adapter|charger|charging grip|charging station|battery pack|carrying case|microphone|memory card|dock|stylus|rumble pak|expansion pak|transfer pak|link cable)\b/i;
const COLLECTIBLE_RE = /\bamiibo\b|\bskylanders?\b|\blego dimensions\b|\bdisney infinity\b|\bfigures?\b/i;
/** What kind of item the name reads as, so it can default to the right category. */
function itemKind(title: string, platform: string): ImportRow["kind"] {
  // Judge by the name OUTSIDE brackets: "Wii Console [Wii Sports Bundle]" is a
  // console, "Zelda Skyward Sword [Controller Bundle]" is the game.
  const outside = title.replace(/\[[^\]]*\]|\([^)]*\)/g, " ").trim();
  // The head noun decides — "Xbox 360 Console with Controller" is a console,
  // "Nintendo Switch with Neon Joy-Con" too (its name IS the platform).
  const head = outside.split(/\s+(?:with|w\/|incl\.?|including|\+)\s+/i)[0];
  if (/\b(console|system)\s*$|\bconsole\b/i.test(head) || platformNameExact(head)) return "console";
  // Then accessories: "Game Boy Advance SP AC Adapter", "NES Classic Controller".
  if (ACCESSORY_RE.test(head)) return "accessory";
  if (CONSOLE_RE.test(head)) return "console";
  if (/\bbundle\b/i.test(title)) return ""; // "[amiibo Bundle]" = the game
  if (COLLECTIBLE_RE.test(title + " " + platform)) return "collectible";
  return "";
}

/** Rows that would create the SAME new listing (one game, several conditions). */
export const newListingKey = (row: { title: string; platform: string }) =>
  `${row.title.toLowerCase().replace(/\s+/g, " ").trim()}|${(row.platform || "").toLowerCase()}`;

/** A spreadsheet's totals row ("Total", "Grand total", …) with no platform. */
export function isSummaryRow(title: string, platform: string): boolean {
  return !platform.trim() && /^(grand |sub ?)?totals?$|^sum$/.test(norm(title));
}

export function buildRows(records: string[][], map: ColumnMap, opts: BuildOpts): ImportRow[] {
  const cell = (r: string[], k: ColumnKey) => (map[k] == null ? "" : String(r[map[k]!] ?? "").trim());
  const out: ImportRow[] = [];
  const byKey = new Map<string, ImportRow>();
  // How many copies each merged row's cost / guide value is averaged over
  // (copies with a blank cost don't count toward the cost average).
  const weights = new Map<ImportRow, { cost: number; pc: number }>();
  records.forEach((rec, i) => {
    const title0 = cell(rec, "title");
    if (!title0 || isSummaryRow(title0, cell(rec, "platform"))) return;
    const folder = cell(rec, "folder");
    if (opts.folder != null && folder !== opts.folder) return;
    const warnings: string[] = [];
    const platformRaw = cell(rec, "platform");
    const pr = resolvePlatform(platformRaw, opts.platforms);
    if (platformRaw && !pr.canonical) warnings.push(`Platform “${platformRaw}” not recognized — kept as typed`);
    if (!platformRaw) warnings.push("No platform");
    const conditionRaw = cell(rec, "condition");
    const cond = resolveCondition(conditionRaw, opts.completeness, opts.grades);
    if (cond.warning) warnings.push(cond.warning);
    if (MANUAL_NO_BOX.has(norm(conditionRaw))) warnings.push(`“${conditionRaw}” — imported as loose; the manual is included`);
    // A separate grade column (PriceCharting's condition-string) wins over a
    // grade named inside the condition cell.
    const gradeRaw = cell(rec, "grade");
    if (gradeRaw) {
      const g0 = norm(gradeRaw);
      const g = PC_GRADE[g0] ?? g0;
      if (g) {
        const gr = resolveCondition(g, [], opts.grades);
        if (gr.gradeCode) cond.gradeCode = gr.gradeCode;
        else warnings.push(`Unrecognized grade “${gradeRaw}” — used ${opts.defaultGrade || "the default"}`);
      }
    }
    const completenessCode = cond.completenessCode || opts.defaultCompleteness;
    if (!cond.completenessCode && !conditionRaw) warnings.push(`No condition — defaulted to ${completenessCode || "none"}`);
    const gradeCode = cond.gradeCode || opts.defaultGrade;
    // Price: an explicit value column wins; else the condition-specific guide
    // column (loose / cib / new) from a PriceCharting export.
    const money = (k: ColumnKey) => (opts.cents?.[k] ? parseCents : parseMoney)(cell(rec, k));
    let priceCents = money("price");
    if (priceCents == null) {
      const c = completenessCode.toUpperCase();
      const k: ColumnKey | null = /NEW|SEALED/.test(c) ? "newPrice" : /^L$|LOOSE/.test(c) ? "loosePrice" : c ? "cibPrice" : null;
      if (k) priceCents = money(k);
      if (priceCents == null && map.gradedPrice != null && /graded/i.test(conditionRaw)) priceCents = money("gradedPrice");
    }
    const pcValueCents = money("pcValue");
    if (priceCents == null) priceCents = pcValueCents;
    if (LOT_X_RE.test(title0) || LOT_WORDS_RE.test(title0)) warnings.push(`“${title0}” looks like several copies or a lot. It imports as ONE item at the sheet price, so set the qty and per-copy price on the entry if that's wrong`);
    if (PARTS_RE.test(title0)) warnings.push("Title says it's defective / for parts — check the grade");
    const kind = itemKind(title0, platformRaw);
    let title = title0.replace(/\s+/g, " ");
    // One spelling per market ("Europe" / "UK" / "EU" → [PAL]) so later
    // imports of the same region land on this listing.
    if (pr.region && pr.region !== "NTSC") title = `${title} [${regionCode(pr.region)}]`;
    const row: ImportRow = {
      n: i + 1, title,
      platform: pr.canonical || platformRaw, platformRaw, platformResolved: !!pr.canonical, region: pr.region,
      completenessCode, gradeCode, gradeFromSheet: !!cond.gradeCode, conditionRaw,
      qty: parseQty(cell(rec, "qty")),
      // PriceCharting writes 0 when no cost basis was entered → unknown, not free.
      priceCents, costCents: opts.cents?.cost ? (money("cost") || null) : money("cost"),
      upc: cell(rec, "upc").replace(/[^0-9]/g, ""), pcId: /^\d+$/.test(cell(rec, "pcId")) ? cell(rec, "pcId") : "",
      notes: cell(rec, "notes"), folder, pcValueCents, kind, lot: LOT_WORDS_RE.test(title0), warnings,
    };
    if (row.qty > 50) row.warnings.push(`Qty ${row.qty} looks high — check the Qty column`);
    // Same title + platform + condition twice in the sheet → one line, summed qty.
    const key = [norm(row.title), norm(row.platform), row.completenessCode, row.gradeCode].join("|");
    const dup = byKey.get(key);
    if (dup) {
      // One stock row has one price: keep the first, but say so when the
      // sheet disagreed. Cost + guide value average across the copies.
      const w = weights.get(dup)!;
      const avg = (a: number | null, wa: number, b: number | null) => (a == null || !wa ? b : b == null ? a : Math.round((a * wa + b * row.qty) / (wa + row.qty)));
      if (dup.priceCents != null && row.priceCents != null && dup.priceCents !== row.priceCents) {
        dup.warnings.push(`Duplicate row ${row.n} had a different price (${fmtCents(row.priceCents)} vs ${fmtCents(dup.priceCents)}) — using ${fmtCents(dup.priceCents)}`);
      }
      dup.costCents = avg(dup.costCents, w.cost, row.costCents);
      dup.pcValueCents = avg(dup.pcValueCents, w.pc, row.pcValueCents);
      if (row.costCents != null) w.cost += row.qty;
      if (row.pcValueCents != null) w.pc += row.qty;
      dup.qty += row.qty;
      if (dup.priceCents == null) dup.priceCents = row.priceCents;
      if (!dup.warnings.some((w) => w.startsWith("Merged"))) dup.warnings.push("Merged duplicate rows");
      return;
    }
    byKey.set(key, row);
    weights.set(row, { cost: row.costCents != null ? row.qty : 0, pc: row.pcValueCents != null ? row.qty : 0 });
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
  inventoryTypeId?: string;   // retail / personal collection / … (per variant)
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
// Bracket qualifiers that DON'T make a different product (reprint labels,
// condition words, the region tag we append ourselves).
const BENIGN_QUALS = new Set(["greatest hits", "players choice", "player s choice", "nintendo selects", "platinum hits", "platinum", "reprint", "cib", "complete", "loose", "sealed", "new", "used", "ntsc", "ntsc u", "us", "usa", "pal", "jp", "japan", "eu"]);
/** "Wii Nunchuk [White]" → "white"; edition / colour / variant qualifiers only. */
// Region tags are compared separately (regionCode), so they're not qualifiers.
const qualifiers = (s: string) => (s.match(/\[[^\]]*\]|\([^)]*\)/g) || []).map(norm).filter((q) => q && !BENIGN_QUALS.has(q) && !REGION_CODE[q]).sort().join("|");
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

// Region tags → one code per market, so "[EU]" and "PAL" compare equal.
const REGION_CODE: Record<string, string> = { pal: "PAL", eu: "PAL", europe: "PAL", uk: "PAL", jp: "JP", jpn: "JP", japan: "JP", japanese: "JP", "ntsc j": "JP", asia: "ASIA", "asian english": "ASIA" };
const regionCode = (r: string | null | undefined) => (r ? REGION_CODE[norm(r)] ?? norm(r).toUpperCase() : "");
/** The market a title's bracket tag names: "Okami HD [JP]" → "JP", else "". */
const titleRegion = (t: string) => {
  for (const q of (t.match(/\[[^\]]*\]|\([^)]*\)/g) || []).map(norm)) if (REGION_CODE[q]) return REGION_CODE[q];
  return "";
};

/* ---------------- Official titles (typo correction) ---------------- */

/** Minimum trigram similarity for a database title to replace a sheet title. */
export const OFFICIAL_TITLE_SIM = 0.6;

/**
 * The official name to use instead of a sheet title, or null to keep it.
 * `candidate` is the closest game on the SAME platform in our LaunchBox copy
 * ("The Legend of Zelda Links Aweakening" → "The Legend of Zelda: Link's
 * Awakening"). Safety: similar enough, and the NUMBERS must agree — "Mario
 * Party 8" never becomes "Mario Party 9". Bracket qualifiers ([Collector's
 * Edition], [JP]) aren't part of the game name, so they're carried over.
 */
export function officialTitleFor(original: string, candidate: { name: string; sim: number } | null | undefined, platform?: string | null): string | null {
  if (!candidate?.name || !(candidate.sim >= OFFICIAL_TITLE_SIM)) return null;
  const official = candidate.name.trim();
  const quals = (original.match(/\[[^\]]*\]|\([^)]*\)/g) || []).join(" ");
  // The row's own platform on the end isn't part of the name ("Street Fighter
  // II Super Nintendo"); the lookup was made without it too.
  const bareOrig = withoutTrailingPlatform(original.replace(/\[[^\]]*\]|\([^)]*\)/g, " ").replace(/\s+/g, " ").trim(), platform);
  const o = norm(bareOrig), n = norm(official);
  // Numbers must agree: "Mario Party 8" never becomes "Mario Party 9".
  if (numbers(dropArticle(o)) !== numbers(dropArticle(n))) return null;
  const ow = o.split(" ").filter(Boolean), nw = n.split(" ").filter(Boolean);
  // Editions / versions must match BOTH ways: a sheet's "Legendary edition"
  // isn't the base game, and an added "DX" / "HD" is a different release
  // (often a ROM hack: "Pokémon Blue DX").
  if (ow.some((w) => EDITION_WORDS.has(w) && !nw.includes(w))) return null;
  if (nw.some((w) => EDITION_WORDS.has(w) && !ow.includes(w))) return null;
  // Every distinctive word must be on BOTH sides (typo-tolerant). Otherwise
  // it's a different product: a bundle ("Enter-EXIT the Gungeon"), a
  // hardware set ("Wii ZAPPER with …"), a ROM hack ("Pokémon Red RUMOR",
  // "Pokémon MOON Emerald", "FAKEMON FireRed"), a series entry ("…: Mini-Land
  // Mayhem!") or one game of a trilogy.
  // Two-letter words count too: "Ms. Pac-Man" isn't "Pac-Man", "Donkey Kong
  // Jr." isn't "Donkey Kong", "Mega Man ZX" isn't "Mega Man".
  const sig = (w: string) => !STOP_WORDS.has(w) && (w.length >= 3 || (w.length === 2 && !/^\d+$/.test(w)));
  if (!ow.every((w, i) => !sig(w) || near(ow, i, nw))) return null;
  // Words the official name adds are allowed only in their usual place, never
  // in a subtitle: "Tomb Raider" isn't "Tomb Raider: Legend".
  const head = official.match(/^(.*)(?::|\s[-–—]\s)/);
  const subStart = head ? norm(head[1]).split(" ").filter(Boolean).length : nw.length;
  const specific = ow.filter((w) => w.length >= 3 && !STOP_WORDS.has(w) && !PLATFORM_WORDS.has(w) && !numbers(w)).length >= 3;
  if (!nw.every((w, i) => !sig(w) || near(nw, i, ow) || (i < subStart && addableAt(nw, i, subStart, specific)))) return null;
  // A word the sheet repeats must repeat in the official name too:
  // "Mario Party 10 MARIO [amiibo Bundle]" names which amiibo it comes with.
  const count = (ws: string[], w: string) => ws.filter((x) => x === w).length;
  if (ow.filter(sig).some((w) => count(ow, w) > 1 && count(nw, w) < count(ow, w))) return null;
  // Same words, only styling differs: fix punctuation ("Luigis" → "Luigi's"),
  // but don't turn "Carrion" into all-caps "CARRION".
  if (o === n && /\b[A-Z]{3,}\b/.test(official.replace(/\b(HD|DX|3D|DS|GBA|NES|SNES|USA|VR|II|III|IV|VI|VII|VIII|XL)\b/g, "")) && !/\b[A-Z]{3,}\b/.test(bareOrig)) return null;
  // …nor "Super Mario Bros. 2" into the database's odd "Super Mario Bros. -2".
  if (o === n && /\s-\d/.test(official) && !/\s-\d/.test(bareOrig)) return null;
  const fixed = `${official}${quals ? " " + quals : ""}`;
  return fixed === original.trim() ? null : fixed;
}
/** Is word `i` of `ws` in the other title? Two-letter words must match
 *  exactly — or be part of a word written apart, whole words on both sides:
 *  "Yu-Gi-Oh" ~ "Yugioh", "R.C." ~ "RC", "Yo-kai" ~ "Yokai". */
function near(ws: string[], i: number, other: string[]): boolean {
  const w = ws[i];
  if (w.length > 2) return nearWord(w, other, other.join(""));
  if (other.includes(w)) return true;
  let a = i, b = i;
  while (a > 0 && ws[a - 1].length <= 2) a--;
  while (b < ws.length - 1 && ws[b + 1].length <= 2) b++;
  const run = ws.slice(a, b + 1).join("");
  const spans = new Set<string>();
  for (let j = 0; j < other.length; j++) for (let k = j, acc = ""; k < other.length && acc.length < 40; k++) spans.add(acc += other[k]);
  return [run, run + (ws[b + 1] ?? ""), (ws[a - 1] ?? "") + run].some((c) => spans.has(c));
}
/** Is `w` (from one title) present in the other title's words — allowing a
 *  typo ("aweakening" ~ "awakening", "robot" ~ "robobot") or a joined word
 *  ("starfox" ~ "Star Fox", "ware" ~ "WarioWare")? */
function nearWord(w: string, words: string[], joined: string): boolean {
  if (words.includes(w)) return true;
  if (w.length >= 3 && joined.includes(w)) return true; // "fox" in "starfox"
  // A typo keeps the word's first two letters ("aweakening" ~ "awakening",
  // "robot" ~ "robobot"); a different word usually doesn't ("pokemon" vs the
  // ROM hack "fakemon"). Longer words may be off by more.
  return words.some((v) => {
    if (v.slice(0, 2) !== w.slice(0, 2) || Math.abs(v.length - w.length) > 2) return false;
    const len = Math.max(v.length, w.length);
    const maxEdits = len >= 7 ? 2 : len >= 5 ? 1 : 0;
    return maxEdits > 0 && editDistance(v, w, maxEdits) <= maxEdits;
  });
}
function editDistance(a: string, b: string, cap: number): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      rowMin = Math.min(rowMin, cur[j]);
    }
    if (rowMin > cap) return cap + 1;
    prev = cur;
  }
  return prev[b.length];
}
// Words an official title may ADD without making it a different product —
// each only in its usual place (before any subtitle):
// - "The Legend of …" up front ("Zelda Links Awakening" → "The Legend of Zelda: …");
// - a closing "Version" / "Game(s)" ("Pokémon Red Version", "… Olympic Games");
// - platform names up front or at the end ("Wii Sports Resort", "Mario Kart
//   DS", "Super Smash Bros. for Wii U");
// - a leading "Super" and Donkey Kong's "Country" — only when the sheet title
//   is specific (3+ distinctive words: "Mario Party Jamboree", "Donkey Kong
//   Returns"). A short one may be another real game: "Street Fighter II" isn't
//   "Super Street Fighter II", "Donkey Kong" isn't "Donkey Kong Country".
function addableAt(nw: string[], i: number, end: number, specific: boolean): boolean {
  const w = nw[i];
  if (w === "legend") return nw[i + 1] === "of" && (i === 0 || (i === 1 && nw[0] === "the"));
  if (w === "super") return i === 0 && specific;
  if (w === "country") return specific && nw[i - 2] === "donkey" && nw[i - 1] === "kong";
  if (CLOSING_WORDS.has(w)) return closingAt(nw, i, end);
  // Up front, closing, or a brand in "Sonic & SEGA All-Stars Racing".
  if (PLATFORM_WORDS.has(w)) return i === 0 || closingAt(nw, i, end) || (i === 2 && nw[1] === "and");
  return false;
}
/** Only closing words (Version / Game / platform names) follow word `i`. */
const closingAt = (ws: string[], i: number, end: number) =>
  ws.slice(i + 1, end).every((x) => x.length < 2 || CLOSING_WORDS.has(x) || PLATFORM_WORDS.has(x));
const CLOSING_WORDS = new Set(["version", "game", "games"]);
const PLATFORM_WORDS = new Set(["nintendo", "wii", "switch", "ds", "3ds", "gba", "gbc", "gamecube", "playstation", "xbox", "sega", "sony", "microsoft"]);
const EDITION_WORDS = new Set(["edition", "deluxe", "complete", "legendary", "definitive", "ultimate", "remastered", "remaster", "anniversary", "collectors", "collector", "limited", "special", "goty", "hd", "dx", "3d", "gold", "platinum", "reloaded"]);
const STOP_WORDS = new Set(["the", "and", "for", "of", "a", "an", "in", "on", "to", "at", "by", "or"]);

interface Prepared {
  product: CatalogProduct;
  platforms: string[]; // every platform the listing names ("GameCube, Wii" → both)
  region: string; // "" = NTSC/US; "JP" / "PAL" from a title tag or the platform ("Super Famicom")
  names: { full: string; bare: string; grams: Map<string, number>; nums: string; quals: string }[];
}

export function prepareCatalog(catalog: CatalogProduct[], platforms: PlatformAlias[]): Prepared[] {
  return catalog.map((product) => {
    const names = [product.title, ...(product.altNames || [])].filter(Boolean).map((t) => {
      const full = dropArticle(norm(t));
      const bare = dropArticle(norm(stripBrackets(t))) || full;
      return { full, bare, grams: bigrams(bare), nums: numbers(bare), quals: qualifiers(t) };
    });
    const rp = resolvePlatform(product.platform || "", platforms);
    const all = resolveStaticPlatforms(product.platform);
    return { product, platforms: all.length ? all : rp.canonical ? [rp.canonical] : [], region: titleRegion(product.title) || regionCode(rp.region), names };
  });
}

function titleScore(rowFull: string, rowBare: string, rowGrams: Map<string, number>, rowNums: string, rowQuals: string, rowRegion: string, p: Prepared): number {
  let best = 0;
  for (const n of p.names) {
    let s: number;
    if (n.full === rowFull) s = 1;
    // Same name once brackets are stripped. Different edition / colour
    // qualifiers ("[White]" vs "[Black]", "[Collector's Edition]" vs none)
    // are different products → review, not auto.
    else if (n.bare === rowBare) s = n.quals === rowQuals ? 0.95 : 0.9;
    else {
      s = dice(rowGrams, n.grams);
      // "Mario Party 8" vs "Mario Party 9": different numbers can never auto-match.
      // …nor can different editions / colours on the fuzzy path.
      if (s >= AUTO_MATCH && (n.nums !== rowNums || n.quals !== rowQuals)) s = 0.85;
    }
    // A PAL / JP copy is a different product from the NTSC listing → review.
    // A JP / PAL copy and a US listing (either way round) are different
    // products → review, never auto.
    if (s >= AUTO_MATCH && rowRegion !== p.region) s = 0.85;
    if (s > best) best = s;
  }
  return best;
}

/** `inventoryTypeId` set → only stock rows of that type qualify: a personal-
 *  collection copy gets its own row (own label code) on the same listing
 *  instead of merging into the Retail row. */
export function pickVariant(product: CatalogProduct, completenessCode: string, gradeCode: string, gradeFromSheet: boolean, inventoryTypeId = ""): CatalogVariant | null {
  const vs = (product.variants || []).filter((v) => !inventoryTypeId || (v.inventoryTypeId || "") === inventoryTypeId);
  if (!vs.length) return null;
  const same = vs.filter((v) => (v.completenessCode || "") === (completenessCode || ""));
  if (!same.length) return null;
  if (gradeFromSheet) return same.find((v) => (v.gradeCode || "") === (gradeCode || "")) || null;
  return same.find((v) => (v.gradeCode || "") === (gradeCode || "")) || same[0];
}

export function matchRow(row: ImportRow, prepared: Prepared[], platforms: PlatformAlias[], inventoryTypeId = ""): RowMatch {
  const gradeFromSheet = row.gradeFromSheet;
  const rowPlatform = resolvePlatform(row.platform, platforms).canonical;
  const rowPlatNorm = norm(row.platform);
  const rowFull = dropArticle(norm(row.title));
  const rowBare = dropArticle(norm(stripBrackets(row.title))) || rowFull;
  const rowGrams = bigrams(rowBare);
  const rowNums = numbers(rowBare);
  const rowQuals = qualifiers(row.title);
  const cands: Candidate[] = [];
  for (const p of prepared) {
    let score = 0;
    if (row.pcId && p.product.pcId && p.product.pcId === row.pcId) score = 1;
    else if (row.upc && p.product.variants.some((v) => (v.barcodes || []).some((b) => barcodeEq(b, row.upc)))) score = 1;
    else {
      // Platform gate: both resolved → must be equal; otherwise loose substring.
      const pp = norm(p.product.platform || "");
      if (rowPlatform && p.platforms.length) { if (!p.platforms.includes(rowPlatform)) continue; }
      else if (rowPlatNorm && pp) { if (!(pp.includes(rowPlatNorm) || rowPlatNorm.includes(pp))) continue; }
      score = titleScore(rowFull, rowBare, rowGrams, rowNums, rowQuals, regionCode(row.region) || titleRegion(row.title), p);
      // Platform-less listing: a little less sure, even on an exact title, so a
      // same-title listing ON the row's platform wins the tie.
      if (!pp) score *= score >= 1 ? 0.97 : 0.9;
    }
    if (score >= REVIEW_MATCH) cands.push({ product: p.product, score });
  }
  cands.sort((a, b) => b.score - a.score);
  const top = cands[0];
  // Two different listings equally sure (e.g. "Tetris" with no platform vs the
  // Game Boy AND NES listings) → the employee decides.
  const tie = top && cands[1] && cands[1].product.id !== top.product.id && cands[1].score >= AUTO_MATCH && top.score - cands[1].score < 0.02;
  if (top && top.score >= AUTO_MATCH && !tie) {
    const variant = pickVariant(top.product, row.completenessCode, row.gradeCode, gradeFromSheet, inventoryTypeId);
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
  categoryId: string;               // category for a NEW listing ("" = the dialog's default)
  nonInventory?: boolean;           // entry import: record what was paid, create no stock (bulk lots)
}

/** Apply a user's pick (product id or "" for new) to a row. */
export function chooseProduct(r: ResolvedRow, product: CatalogProduct | null, inventoryTypeId = "") {
  r.product = product;
  r.variant = product ? pickVariant(product, r.row.completenessCode, r.row.gradeCode, r.row.gradeFromSheet, inventoryTypeId) : null;
}
