// REGIONS — a listing's market (US / PAL / Japan…) as a tag, not part of its
// title (migration 20261005000001). Shared by the server, every POS screen and
// the shop, so it must stay free of server-only imports.
//
// Data: store_regions rows (code, name, short tag, flag, aliases, show_badge,
// is_default). products.region_code always holds a code once the migration is
// applied. BEFORE it (no table): loadRegions() returns [] → "regions off":
// no badges / filters / pickers, and the CSV importer keeps the old "[PAL]"
// title tag. Parsing (import sheets, search words, eBay aspects) still works
// from the BUILT-IN list, so codes are known either way.
//
// Text snapshots (receipts, trade-in tickets, label/print text, feeds) use
// displayTitle(): "Okami HD [JP]" — the same form the old title tags had.

export interface Region {
  code: string;      // stable: "US", "PAL", "JP"
  name: string;      // "Japan (NTSC-J)"
  short: string;     // badge / bracket text: "JP"
  flag: string;      // "🇯🇵"
  aliases: string[]; // normalized words: "japan import", "ntsc j"
  showBadge: boolean;
  isDefault: boolean;
  isActive: boolean;
  isSystem: boolean;
  sort: number;
}

/** Lowercase words only — the same as SQL region_norm(). */
export const regionNorm = (s: string | null | undefined) =>
  String(s ?? "").toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, " ").trim();

/** The seed list — vocabulary for parsing before the migration / table load. */
export const BUILTIN_REGIONS: Region[] = [
  { code: "US", name: "North America (NTSC-U/C)", short: "US", flag: "🇺🇸", showBadge: false, isDefault: true, isActive: true, isSystem: true, sort: 0,
    aliases: ["us", "usa", "u s", "ntsc", "ntsc u", "ntsc uc", "ntsc u c", "north america", "north american", "us version", "usa version", "canada", "american"] },
  { code: "PAL", name: "Europe / Australia (PAL)", short: "PAL", flag: "🇪🇺", showBadge: true, isDefault: false, isActive: true, isSystem: true, sort: 1,
    aliases: ["pal", "eu", "europe", "european", "uk", "pal uk", "pal eu", "pal au", "pal version", "eu version", "uk version", "australia", "australian"] },
  { code: "JP", name: "Japan (NTSC-J)", short: "JP", flag: "🇯🇵", showBadge: true, isDefault: false, isActive: true, isSystem: true, sort: 2,
    aliases: ["jp", "jpn", "japan", "japanese", "ntsc j", "japan import", "japanese import", "jp import", "import japan", "japanese version", "jp version", "japan version"] },
  { code: "ASIA", name: "Asia", short: "ASIA", flag: "🌏", showBadge: true, isDefault: false, isActive: true, isSystem: false, sort: 3,
    aliases: ["asia", "asian", "asian english", "asia english", "asian version", "hk", "hong kong", "chinese", "china", "korea", "korean"] },
];

/** store_regions → Region[], ordered. [] when the table doesn't exist yet. */
export async function loadRegions(sb: any): Promise<Region[]> {
  try {
    const { data, error } = await sb.from("store_regions")
      .select("code, name, short_tag, flag, aliases, show_badge, is_default, is_active, is_system, sort_order")
      .order("sort_order").order("name");
    if (error || !data) return [];
    return (data as any[]).map(rowToRegion);
  } catch { return []; }
}
export const rowToRegion = (r: any): Region => ({
  code: String(r.code), name: String(r.name ?? r.code), short: String(r.short_tag || r.code), flag: String(r.flag ?? ""),
  aliases: (Array.isArray(r.aliases) ? r.aliases : []).map(regionNorm).filter(Boolean),
  showBadge: r.show_badge !== false, isDefault: !!r.is_default, isActive: r.is_active !== false,
  isSystem: !!r.is_system, sort: Number(r.sort_order) || 0,
});

/** Regions are in use (the migration ran and the table has rows). */
export const regionsOn = (regions: Region[] | null | undefined) => !!regions && regions.length > 0;
/** Vocabulary for PARSING: the store's list, else the built-in one. */
const vocab = (regions: Region[] | null | undefined) => (regionsOn(regions) ? regions! : BUILTIN_REGIONS);

export function defaultRegionCode(regions: Region[] | null | undefined): string {
  return vocab(regions).find((r) => r.isDefault)?.code ?? "US";
}
export function regionByCode(code: string | null | undefined, regions: Region[] | null | undefined): Region | null {
  const c = String(code ?? "").toUpperCase();
  return (c && vocab(regions).find((r) => r.code === c)) || null;
}
/** A listing's region code: its own, or the default when unknown/empty. */
export function regionOf(code: string | null | undefined, regions: Region[] | null | undefined): string {
  return regionByCode(code, regions)?.code ?? defaultRegionCode(regions);
}
export const isDefaultRegion = (code: string | null | undefined, regions: Region[] | null | undefined) =>
  regionOf(code, regions) === defaultRegionCode(regions);
/** The region shows a badge / tag (an import, for a US store). Never when regions are off. */
function tagged(code: string | null | undefined, regions: Region[] | null | undefined): Region | null {
  if (!regionsOn(regions)) return null;
  const r = regionByCode(code, regions);
  return r && r.showBadge && !r.isDefault ? r : null;
}

/** "JP" — the short tag for a badged region, else "". */
export const regionTag = (code: string | null | undefined, regions: Region[] | null | undefined) => tagged(code, regions)?.short ?? "";
/** "🇯🇵 JP" — badge text, else "". */
export function badgeText(code: string | null | undefined, regions: Region[] | null | undefined): string {
  const r = tagged(code, regions);
  return r ? `${r.flag ? r.flag + " " : ""}${r.short}` : "";
}
const escHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
/** `<span class="rg-badge">🇯🇵 JP</span>` for a badged region, else "". */
export function regionBadgeHtml(code: string | null | undefined, regions: Region[] | null | undefined, cls = "rg-badge"): string {
  const r = tagged(code, regions);
  return r ? `<span class="${cls}" data-region="${escHtml(r.code)}" title="${escHtml(r.name)}">${escHtml(badgeText(code, regions))}</span>` : "";
}
/** "Okami HD [JP]" — for text that has no room for a badge (receipts,
 *  trade-in tickets, prompts, feeds). Idempotent. */
export function displayTitle(title: string, code: string | null | undefined, regions: Region[] | null | undefined): string {
  const tag = regionTag(code, regions);
  const t = String(title ?? "");
  if (!tag) return t;
  return t.toLowerCase().endsWith(`[${tag.toLowerCase()}]`) ? t : `${t} [${tag}]`;
}
/** "Okami HD (Japan (NTSC-J))"-style title for SEO / Shopping: the region's
 *  name for a badged region, else the title. */
export function seoTitle(title: string, code: string | null | undefined, regions: Region[] | null | undefined): string {
  const r = tagged(code, regions);
  return r ? `${title} (${r.name})` : title;
}

/** The region a whole bit of text names ("PAL", "Japan Import", "NTSC-J"), else "". */
export function regionFromText(text: string | null | undefined, regions?: Region[] | null): string {
  const n = regionNorm(text);
  if (!n) return "";
  for (const r of [...vocab(regions)].sort((a, b) => a.sort - b.sort)) {
    if (n === r.code.toLowerCase() || n === regionNorm(r.short) || r.aliases.includes(n)) return r.code;
  }
  return "";
}

/** Bracket/paren tags that ARE a region leave the title: "Okami HD [JP]" →
 *  { title: "Okami HD", code: "JP" }. Edition tags ("[Clear Orange]") stay.
 *  Mirrors the SQL guard (products_region_guard). */
export function splitTitleRegion(title: string, regions?: Region[] | null): { title: string; code: string } {
  let code = "";
  const out = String(title ?? "").replace(/[[(]([^\])[(]*)[\])]/g, (m, inner) => {
    const c = regionFromText(inner, regions);
    if (!c) return m;
    code = code || c;
    return " ";
  }).replace(/\s{2,}/g, " ").trim();
  return out ? { title: out, code } : { title: String(title ?? "").trim(), code: "" };
}

// Platforms only sold in Japan / named for the Japanese market — PriceCharting
// lists them without a "JP" prefix.
const IMPLIED_JP = /(^| )(super famicom|famicom disk system|famicom|sfc|pc engine|pc engine cd|pc engine duo|pc fx|satellaview|wonderswan|wonderswan color|wonderswan crystal)( |$)/;
const PREFIX_WORDS = ["asian english", "japanese", "japan", "europe", "asia", "pal", "jpn", "jp", "eu", "uk"];
/** A platform name's region: "PAL Nintendo Switch" → { platform: "Nintendo
 *  Switch", code: "PAL" }; "Super Famicom" → code "JP" (platform unchanged —
 *  resolve it to the store's canonical name separately). */
export function regionFromPlatform(platform: string | null | undefined, regions?: Region[] | null): { platform: string; code: string } {
  const raw = String(platform ?? "").trim();
  const n = regionNorm(raw);
  for (const w of PREFIX_WORDS) {
    if (n.startsWith(w + " ")) {
      const code = regionFromText(w, regions);
      if (code) {
        const rest = raw.replace(new RegExp(`^\\s*${w.replace(/ /g, "[\\s_-]+")}[\\s:_-]+`, "i"), "").trim();
        return { platform: rest || raw, code };
      }
    }
  }
  if (IMPLIED_JP.test(n)) return { platform: raw, code: regionFromText("japan", regions) };
  return { platform: raw, code: "" };
}

// Alias words that are also ordinary title words ("Among Us", "American
// Truck Simulator", "Chinese Checkers", "European Assault") — never peeled
// out of a search.
const NOT_PEELED = new Set(["us", "usa", "u s", "american", "north american", "canada", "china", "chinese", "korea", "korean", "australia", "australian", "asian", "hk", "european"]);
/** Peel a region the user TYPED out of a search ("mario kart pal" →
 *  { rest: "mario kart", code: "PAL" }). Whole words only, longest alias
 *  first; never empties the query; the home region and everyday words
 *  ("us", "american") are left alone — use the Region filter for those. */
export function peelRegion(query: string, regions?: Region[] | null): { rest: string; code: string; text: string } {
  const s = " " + regionNorm(query) + " ";
  const cands: { alias: string; code: string }[] = [];
  for (const r of vocab(regions)) {
    if ((regionsOn(regions) && !r.isActive) || r.isDefault) continue;
    for (const a of new Set([...r.aliases, r.code.toLowerCase(), regionNorm(r.short)])) if (a && !NOT_PEELED.has(a)) cands.push({ alias: a, code: r.code });
  }
  cands.sort((a, b) => b.alias.length - a.alias.length);
  for (const c of cands) {
    const i = s.indexOf(" " + c.alias + " ");
    if (i < 0) continue;
    const rest = (s.slice(0, i) + " " + s.slice(i + c.alias.length + 2)).replace(/\s+/g, " ").trim();
    if (!rest) continue; // "pal" alone is a search for the word, not a filter of nothing
    return { rest, code: c.code, text: c.alias };
  }
  return { rest: regionNorm(query), code: "", text: "" };
}

/** eBay's "Region Code" aspect ("NTSC-J (Japan)", "PAL", "NTSC-U/C (US/Canada)",
 *  "Region Free") → a code, else "". Region Free is not a market. */
export function regionFromEbayAspect(values: string[] | string | null | undefined, regions?: Region[] | null): string {
  const list = (Array.isArray(values) ? values : values ? [values] : []).flatMap((v) => String(v).split(/[,;|]+/));
  // Several markets at once ("NTSC-U/C (US/Canada), PAL") = a region-free
  // release, not an import: unknown.
  const found = new Set(list.map((v) => one(v)).filter(Boolean));
  return found.size === 1 ? [...found][0] : "";
  function one(v: string): string {
    const n = regionNorm(v);
    if (!n || /region free/.test(n)) return "";
    if (/ntsc j|japan/.test(n)) return regionFromText("japan", regions);
    if (/\bpal\b|europe|\buk\b|australia/.test(n)) return regionFromText("pal", regions);
    if (/ntsc c|china|hong kong|korea|asia/.test(n)) return regionFromText("asia", regions);
    if (/ntsc u|\bus\b|usa|canada|north america/.test(n)) return regionFromText("us", regions);
    return regionFromText(v, regions);
  }
}

/** Sort key: the region's place in the list (default first). */
export function regionSortKey(code: string | null | undefined, regions: Region[] | null | undefined): number {
  const r = regionByCode(regionOf(code, regions), regions);
  return r ? (r.isDefault ? -1 : r.sort) : 999;
}

/** Shared badge style, for pages that don't load app.css. */
export const REGION_BADGE_CSS = `.rg-badge{display:inline-flex;align-items:center;gap:.2em;padding:.05rem .4rem;font-size:.68rem;font-weight:800;letter-spacing:.03em;line-height:1.35;border:1px solid var(--border-strong,#555);background:rgba(127,127,127,.12);color:var(--text,inherit);white-space:nowrap;vertical-align:middle;border-radius:0}`;
