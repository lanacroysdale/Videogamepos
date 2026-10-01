// Listing-level UPCs: the pure rules (no network) for deciding whether an
// eBay CATALOG product is the same release as one of our listings, and which
// of its codes are US UPCs. The eBay calls live in upcFinder.ts.
//
// Wrong beats missing only in one direction: a wrong UPC makes a scan ring up
// the wrong game, a missing one just means "Needs UPC". So every rule here
// rejects when unsure.
import { officialTitleFor, norm, itemKind, titleRegion } from "./collectionImport";
import { resolveStaticPlatform, resolveStaticPlatforms, withoutTrailingPlatform, withoutLeadingPlatform } from "./smartSearch";

/** GS1 check digit (UPC-A / EAN-13 / GTIN-14 all use the same mod-10 rule). */
export function gtinValid(code: string): boolean {
  if (!/^\d{8,14}$/.test(code)) return false;
  const d = code.split("").map(Number);
  const check = d.pop()!;
  let sum = 0;
  for (let i = d.length - 1, w = 3; i >= 0; i--, w = w === 3 ? 1 : 3) sum += d[i] * w;
  return (10 - (sum % 10)) % 10 === check;
}

/** A typed/scanned code as we store it: digits only; a 13/14-digit US code
 *  shortened to its 12-digit UPC-A ("0045496742843" → "045496742843"). Null
 *  if it isn't a valid GTIN. */
export function canonicalUpc(raw: string | null | undefined): string | null {
  const s = String(raw ?? "").replace(/[\s-]/g, "");
  if (!/^\d{8,14}$/.test(s) || !gtinValid(s)) return null;
  if (s.length >= 13 && /^0+\d{12}$/.test(s)) return s.slice(-12);
  return s;
}

/** Every spelling of a code a scanner or supplier might produce — for
 *  exact-match lookups ("045496742843", "0045496742843", "00045496742843"). */
export function upcForms(code: string): string[] {
  const s = code.replace(/\D/g, "");
  if (!/^\d{12,14}$/.test(s)) return [s];
  const key = s.padStart(14, "0");
  const forms = new Set([s]);
  // Only drop leading ZEROS: "0045…" (13) and "045…" (12) are one code.
  for (const len of [12, 13, 14]) if (/^0*$/.test(key.slice(0, 14 - len))) forms.add(key.slice(14 - len));
  return [...forms];
}

/** The US UPCs among an eBay catalog product's GTINs (EANs of other markets
 *  and malformed values dropped), canonical and de-duplicated. */
export function usUpcs(gtins: unknown): string[] {
  const out: string[] = [];
  for (const g of Array.isArray(gtins) ? gtins : []) {
    const c = canonicalUpc(String(g));
    if (c && c.length === 12 && !out.includes(c)) out.push(c);
  }
  return out;
}

/** Which listings the automatic lookup covers: games on a known platform,
 *  sold in the US market. Consoles/accessories/collectibles and import (JP /
 *  PAL) releases are left to manual entry — eBay's US catalog would give them
 *  the wrong code. */
export function upcEligible(p: { title: string; platform?: string | null; categoryName?: string | null }): boolean {
  const platform = String(p.platform ?? "");
  if (!resolveStaticPlatform(platform)) return false;
  if (/\b(famicom|sfc|pc engine|japan|jpn|jp|pal|ntsc[- ]?j)\b/i.test(platform)) return false;
  if (titleRegion(p.title)) return false;
  if (p.categoryName && !/game/i.test(p.categoryName)) return false;
  return itemKind(p.title, platform) === "";
}

/** Our title as a RELEASE name: bracket qualifiers count ("[Nintendo
 *  Selects]" and "[Greatest Hits]" have their own UPCs). */
const releaseName = (title: string) => title.replace(/[[\]()]/g, " ").replace(/\bvideo ?game\b/gi, " ").replace(/\s+/g, " ").trim();

/** An eBay catalog title reduced to the game's name: "(Nintendo 3DS, 2011)",
 *  "- Nintendo Switch", "Standard Edition" and the platform up front go;
 *  other parentheses ("(Nintendo Selects)") stay as words. */
export function catalogName(title: string, platform: string): string {
  const canon = resolveStaticPlatform(platform);
  const s = String(title ?? "").replace(/\(([^)]*)\)|\[([^\]]*)\]/g, (_m, a, b) => {
    const inner = String(a ?? b ?? "");
    const US_TAG = /^(ntsc(-u(\/c)?)?|us|usa|north america|us version|region free|video ?game)$/i;
    if (US_TAG.test(inner.trim())) return " ";
    const platformOrYear = inner.split(/,/).every((part) => {
      const t = part.trim();
      return !t || /^(19|20)\d\d$/.test(t) || (canon !== null && resolveStaticPlatforms(t).includes(canon) && t.split(/\s+/).length <= 5)
        || US_TAG.test(t);
    });
    return platformOrYear ? " " : ` ${inner} `;
  }).replace(/\bstandard edition\b|\bvideo ?game\b/gi, " ").replace(/\s+/g, " ").trim();
  return bothEnds(s, platform);
}
const bothEnds = (s: string, platform: string) => withoutLeadingPlatform(withoutTrailingPlatform(s, platform), platform);

/** Is the eBay catalog product `theirs` the same release as our `ours`?
 *  The official-title guard decides: numbers equal, editions equal both ways,
 *  every distinctive word on both sides (typo-tolerant), extra words only in
 *  their usual place ("The Legend of", a closing "Version"). */
export function sameRelease(ours: string, theirs: string, platform: string): boolean {
  const a = bothEnds(releaseName(ours), platform);
  const b = catalogName(theirs, platform);
  if (!norm(a) || !norm(b)) return false;
  if (norm(a) === norm(b)) return true;
  return officialTitleFor(a, { name: b, sim: 1 }, platform) !== null;
}

/** Does the catalog product's Platform aspect name our platform? */
export function platformAgrees(values: string[], platform: string): boolean {
  const want = resolveStaticPlatform(platform);
  if (!want || !values.length) return false;
  return values.some((v) => resolveStaticPlatforms(v).includes(want));
}

/** Region Code aspect: a US listing takes only a US / region-free release. */
export function regionAgrees(values: string[]): boolean {
  if (!values.length) return true;
  return values.some((v) => /ntsc-?u|\bus\b|usa|north america|canada|region free/i.test(v));
}

/** eBay's aspect groups → name → values (lower-cased names). */
export function aspectMap(groups: unknown, extra?: unknown): Map<string, string[]> {
  const m = new Map<string, string[]>();
  const add = (name: string, vals: string[]) => {
    const k = name.trim().toLowerCase();
    if (k && vals.length) m.set(k, [...new Set([...(m.get(k) ?? []), ...vals])]);
  };
  for (const g of Array.isArray(groups) ? groups : []) for (const a of g?.aspects ?? []) add(String(a?.localizedName ?? ""), (a?.localizedValues ?? []).map(String));
  for (const a of Array.isArray(extra) ? extra : []) if (a?.name && a?.value) add(String(a.name), [String(a.value)]);
  return m;
}

/** Is a game-database name (LaunchBox / IGDB) the same GAME as our listing —
 *  for its cover art and details? The UPC rules on the game's name: our
 *  bracket tags ([Collector's Edition], [amiibo Bundle], [JP]…), "… Edition"
 *  phrases and the "New Play Control!" re-release prefix don't count — the
 *  box art is the game's. Everything else must still agree: a sequel number,
 *  "Sonic R", another game that shares a word ("My Friend Peppa Pig"). */
/** The same RELEASE for its box art: our bracket tags count as words
 *  ("Excitebike [Classic NES Series]" → "Classic NES Series: Excitebike"),
 *  except region / condition tags. Try this before sameGameName. */
export function sameBoxRelease(ours: string, theirs: string, platform: string): boolean {
  const cleaned = String(ours ?? "").replace(/\[([^\]]*)\]|\(([^)]*)\)/g, (m, a, b) => (NOT_A_RELEASE.test(String(a ?? b ?? "").trim()) ? " " : m));
  return sameRelease(cleaned, theirs, platform);
}
const NOT_A_RELEASE = /^(jp|jpn|japan|japanese|import|pal|eu|europe|uk|asia|asian english|ntsc(-[uj](\/c)?)?|cib|complete|complete in box|loose|sealed|new|used|boxed|box only|manual only|game only|disc only|cart only|cartridge only)$/i;

export function sameGameName(ours: string, theirs: string, platform: string): boolean {
  const a = gameName(String(ours ?? "").replace(/\[[^\]]*\]|\([^)]*\)/g, " "));
  const b = gameName(String(theirs ?? ""));
  return !!a && !!b && sameRelease(a, b, platform);
}
const gameName = (t: string) => t
  .replace(/\b(?:(?:nintendo\s+)?switch\s+2|(?:nintendo\s+)?wii\s+u|nintendo\s+switch|\d+(?:st|nd|rd|th)\s+anniversary|game of the year|day one|[\w'’-]+)\s+edition\b/gi, " ")
  .replace(/^\s*new play control!?:?\s*/i, " ")
  // A publisher/brand prefix and ", Inc." aren't the game ("Tom Clancy's
  // Splinter Cell 3D", "Sid Meier's Civilization VI", "WarioWare, Inc.").
  .replace(/^\s*(?:tom clancy|sid meier|james cameron|disney|marvel|tim burton|clive barker)(?:['’]s)?\s+/i, " ")
  .replace(/,?\s*\binc\b\.?/gi, " ")
  // "III" and "3" are the same number (multi-letter numerals only: "Mega Man X" stays).
  .replace(/\b(ii|iii|iv|vi|vii|viii|ix)\b/gi, (m) => String({ ii: 2, iii: 3, iv: 4, vi: 6, vii: 7, viii: 8, ix: 9 }[m.toLowerCase() as "ii"]))
  .replace(/\s+/g, " ").replace(/[\s:–—-]+$/, "").trim();

