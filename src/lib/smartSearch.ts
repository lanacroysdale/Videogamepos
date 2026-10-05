// Shared smart find-or-create parsing, used by BOTH the inventory and trade-in
// entry screens (the "one entry flow for both"). Pure functions — no DOM.
//
// It peels structured tokens (region / platform / completeness / grade) off a
// phrase via alias lists, leaving the title remainder, then fuzzy-ranks catalog
// products by title + alternative names. Reliable because the vocabulary is
// structured config.

import { peelRegion, regionFromPlatform, regionsOn, defaultRegionCode, regionNorm, type Region } from "./regions";

export interface TaxoEntry {
  code: string;
  label: string;
  aliases: string[];
  icon?: string | null;
}
export interface ParsedQuery {
  platform: string | null;
  completenessCode: string;
  gradeCode: string;
  title: string;
  /** The platform words as typed ("wii"), when a platform was recognized. */
  platformText: string;
  /** Title to pre-fill when creating a new product: "wii sports" keeps "wii"
   *  (the platform word LEADS the query, so it's likely part of the name),
   *  "mario kart n64" drops it. */
  titleForNew: string;
  /** The region the query names ("mario kart pal" → "PAL"), or one its
   *  platform implies ("super famicom" → "JP"); "" = none. A FILTER — region
   *  words never stay in `title`. Only when regions are on. */
  regionCode: string;
  /** The region words as typed ("pal"), when one was peeled. */
  regionText: string;
  /** The store's home region ("" when regions are off) — a listing with no
   *  region code counts as this one. */
  defaultRegion: string;
  /** The title WITH the peeled region words, for a listing whose name
   *  contains them ("Medal of Honor: European Assault"). */
  fullTitle: string;
}
export interface MatchableProduct {
  title: string;
  platform?: string | null;
  franchise?: string | null;
  altNames?: string[];
  /** The listing's region code ("" / missing = the default region). */
  regionCode?: string | null;
}
export interface PlatformAlias {
  canonical: string;
  aliases: string[];
}

export const PLATFORM_ALIASES: PlatformAlias[] = [
  // Canonical names follow PriceCharting's console naming so CSV imports line
  // up; aliases cover shorthand staff type and the spellings other sources use.
  // Switch 2 is its own platform; its longer aliases win over plain "switch".
  { canonical: "Nintendo Switch 2", aliases: ["nintendo switch 2", "switch 2", "ns2", "nsw2", "switch2"] },
  { canonical: "Nintendo Switch", aliases: ["nintendo switch", "switch", "nsw"] },
  { canonical: "Super Nintendo", aliases: ["super nintendo", "snes", "super nes", "super famicom", "sfc", "super nintendo entertainment system"] },
  { canonical: "Nintendo 64", aliases: ["nintendo 64", "n64"] },
  { canonical: "GameCube", aliases: ["gamecube", "game cube", "gcn", "ngc", "gc", "nintendo gamecube"] },
  { canonical: "Wii U", aliases: ["wii u", "nintendo wii u", "wiiu"] },
  { canonical: "Wii", aliases: ["wii", "nintendo wii"] },
  { canonical: "Game Boy Advance", aliases: ["game boy advance", "gameboy advance", "gba"] },
  { canonical: "Game Boy Color", aliases: ["game boy color", "gameboy color", "gbc"] },
  { canonical: "Game Boy", aliases: ["game boy", "gameboy", "gb", "dmg"] },
  { canonical: "Nintendo 3DS", aliases: ["nintendo 3ds", "3ds", "new 3ds", "new nintendo 3ds", "2ds"] },
  { canonical: "Nintendo DS", aliases: ["nintendo ds", "nds", "ds", "dsi"] },
  { canonical: "Virtual Boy", aliases: ["virtual boy"] },
  { canonical: "NES", aliases: ["nintendo entertainment system", "nes", "famicom", "nintendo nes"] },
  { canonical: "Famicom Disk System", aliases: ["famicom disk system", "fds"] },
  { canonical: "PlayStation 5", aliases: ["playstation 5", "ps5"] },
  { canonical: "PlayStation 4", aliases: ["playstation 4", "ps4"] },
  { canonical: "PlayStation 3", aliases: ["playstation 3", "ps3"] },
  { canonical: "PlayStation 2", aliases: ["playstation 2", "ps2"] },
  { canonical: "PlayStation Vita", aliases: ["playstation vita", "ps vita", "psvita", "vita"] },
  { canonical: "PSP", aliases: ["psp", "playstation portable"] },
  { canonical: "PlayStation", aliases: ["playstation", "playstation 1", "psx", "ps1", "ps one", "psone"] },
  { canonical: "Xbox Series X", aliases: ["xbox series x", "xbox series s", "xbox series", "series x", "xsx"] },
  { canonical: "Xbox One", aliases: ["xbox one", "xb1", "xbone"] },
  { canonical: "Xbox 360", aliases: ["xbox 360", "x360"] },
  { canonical: "Xbox", aliases: ["xbox", "original xbox"] },
  { canonical: "Sega Genesis", aliases: ["sega genesis", "genesis", "mega drive", "megadrive", "sega mega drive"] },
  { canonical: "Sega CD", aliases: ["sega cd", "mega cd"] },
  { canonical: "Sega 32X", aliases: ["sega 32x", "32x"] },
  { canonical: "Sega Saturn", aliases: ["sega saturn", "saturn"] },
  { canonical: "Sega Dreamcast", aliases: ["sega dreamcast", "dreamcast"] },
  { canonical: "Sega Game Gear", aliases: ["sega game gear", "game gear"] },
  { canonical: "Sega Master System", aliases: ["sega master system", "master system"] },
  { canonical: "Atari 2600", aliases: ["atari 2600", "2600"] },
  { canonical: "Atari 5200", aliases: ["atari 5200"] },
  { canonical: "Atari 7800", aliases: ["atari 7800"] },
  { canonical: "Atari Jaguar", aliases: ["atari jaguar"] },
  { canonical: "Atari Lynx", aliases: ["atari lynx", "lynx"] },
  { canonical: "TurboGrafx-16", aliases: ["turbografx 16", "turbografx", "tg16", "pc engine", "turbo grafx"] },
  { canonical: "TurboGrafx CD", aliases: ["turbografx cd", "turbografx 16 cd", "tg cd", "pc engine cd", "pc engine cd rom"] },
  { canonical: "Neo Geo", aliases: ["neo geo", "neogeo", "neo geo aes", "neo geo mvs"] },
  { canonical: "Neo Geo CD", aliases: ["neo geo cd", "neogeo cd"] },
  { canonical: "Neo Geo Pocket Color", aliases: ["neo geo pocket color", "neo geo pocket", "neogeo pocket color", "ngpc"] },
  { canonical: "Intellivision", aliases: ["intellivision"] },
  { canonical: "ColecoVision", aliases: ["colecovision"] },
  { canonical: "3DO", aliases: ["3do"] },
  { canonical: "N-Gage", aliases: ["n gage", "ngage"] },
];

const NOISE = new Set(["condition", "cond", "the", "a", "of"]);
// Real product names that START with a platform word — the only case where
// "wii …" keeps "Wii" in a new product's title ("wii mario kart" doesn't).
const NAME_WITH_PLATFORM_RE = /^(wii (sports|fit|play|party|music|chess|u party|u panorama|u sports|u fit)|game ?boy (camera|printer|gallery|wars)|game (and )?watch (gallery|collection)|virtual boy wario land)\b/;

/** " word word " — lowercase, punctuation and "&"/"and" dropped, space-padded
 *  so `.includes()` only matches whole words. */
const phraseWords = (t: string) => " " + t.toLowerCase().replace(/&/g, " ").replace(/[^a-z0-9]+/g, " ").split(" ").filter((w) => w && w !== "and").join(" ") + " ";
const BUILTIN_CANON = new Set(PLATFORM_ALIASES.map((p) => p.canonical));
const words = (t: string) => " " + String(t ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim() + " ";
const STATIC_ALIASES = PLATFORM_ALIASES
  .flatMap((p) => [p.canonical, ...p.aliases].map((a) => ({ canonical: p.canonical, alias: words(a) })))
  .sort((x, y) => y.alias.length - x.alias.length);

/** The built-in platform a free-text name refers to, by its longest alias as
 *  whole words: "Sony PlayStation 4" → PlayStation 4, "Nintendo Game Boy" →
 *  Game Boy, "PS4" → PlayStation 4. null for brands / unknown text. */
export function resolveStaticPlatform(name: string | null | undefined): string | null {
  return resolveStaticPlatforms(name)[0] ?? null;
}

/** EVERY built-in platform a name mentions, longest alias first, each span
 *  consumed so "Nintendo Wii U" is Wii U only (not Wii too):
 *  "Nintendo GameCube, Nintendo Wii" → [GameCube, Wii]. */
export function resolveStaticPlatforms(name: string | null | undefined): string[] {
  let s = words(name ?? "");
  const out: string[] = [];
  for (const m of STATIC_ALIASES) {
    if (!m.alias.trim() || !s.includes(m.alias)) continue;
    if (!out.includes(m.canonical)) out.push(m.canonical);
    s = s.split(m.alias).join(" | ");
  }
  return out;
}

/** A sheet title without its own platform tacked on the end: "Street Fighter
 *  II Super Nintendo", "Just Dance - Nintendo Wii", "Tetris GB", "… Super
 *  Nintendo SNES" → the game's name. Only the row's OWN platform is removed
 *  (any alias, optionally with its maker — "Sony PlayStation 2" — or just the
 *  maker: "… Sega" on Genesis; "DS" on a 3DS row, "Switch" on a Switch 2 row),
 *  and a name is always left: "Super Nintendo" stays "Super Nintendo". Real
 *  names ending in their platform ("Mario Kart Wii") come back from the game
 *  database with it. */
export function withoutTrailingPlatform(title: string, platform: string | null | undefined): string {
  return stripPlatformEnd(title, platform, "end");
}
/** The same at the START ("Nintendo 3DS Mario Kart 7" → "Mario Kart 7"). For
 *  comparing two names that are stripped alike — "Wii Sports" loses its "Wii"
 *  on both sides — never for building a title. */
export function withoutLeadingPlatform(title: string, platform: string | null | undefined): string {
  return stripPlatformEnd(title, platform, "start");
}
function stripPlatformEnd(title: string, platform: string | null | undefined, side: "start" | "end"): string {
  let t = String(title ?? "").replace(/\s+/g, " ").trim();
  const canon = resolveStaticPlatform(platform);
  if (!canon || platformNameExact(t)) return t;
  const own = new Set(STATIC_ALIASES.filter((m) => m.canonical === canon || m.canonical === PLATFORM_FAMILY[canon]).map((m) => m.alias));
  const maker = makerOf(canon);
  for (let pass = 0; pass < 3; pass++) {
    const toks = t.split(" ");
    const phrase = (k: number) => words((side === "end" ? toks.slice(-k) : toks.slice(0, k)).join(" "));
    // The word just outside the phrase + its first word, e.g. "super" + "nintendo".
    const outer = (k: number) => words(side === "end" ? `${toks[toks.length - k - 1] ?? ""} ${toks[toks.length - k]}` : "");
    const max = Math.min(5, toks.length - 1);
    let cut = 0;
    // An exact alias first ("SNES", "Super Nintendo"), then maker + alias
    // ("Sony PlayStation 2"), then just the maker ("Sega"). A maker that is
    // the tail of a longer alias ("Super NINTENDO") is never peeled off alone.
    for (let k = max; k >= 1 && !cut; k--) if (own.has(phrase(k))) cut = k;
    for (let k = max; k >= 2 && !cut; k--) {
      const ph = phrase(k);
      const core = ph.replace(new RegExp(`^ ((${MAKERS}) )+`), " ");
      if (core !== ph && own.has(core) && !own.has(outer(k))) cut = k;
    }
    if (!cut && maker && max >= 1 && phrase(1) === ` ${maker} ` && !own.has(outer(1))) cut = 1;
    if (!cut) break;
    const rest = (side === "end" ? toks.slice(0, -cut) : toks.slice(cut)).join(" ")
      .replace(side === "end" ? /(?:[\s\-–—:,/|]|\b(?:for|on)\b)+$/i : /^(?:[\s\-–—:,/|])+/, "").trim();
    // Keep a real name: something beyond makers / "super" / platform words.
    if (platformNameExact(rest) || !rest.split(/\s+/).some((w) => /[a-z0-9]{3,}/i.test(w) && !NOT_A_NAME.has(w.toLowerCase().replace(/[^a-z0-9]/g, "")))) break;
    t = rest;
  }
  return t;
}
// A row on one of these platforms may carry its sibling's name: a 3DS game
// listed as "… DS", a Switch 2 game as "… Switch".
const PLATFORM_FAMILY: Record<string, string> = { "Nintendo 3DS": "Nintendo DS", "Nintendo Switch 2": "Nintendo Switch" };
const NOT_A_NAME = new Set(["super", "nintendo", "sony", "sega", "microsoft", "atari", "new", "game", "system", "console"]);
/** Every word that names `canon` in any of its aliases, plus its maker
 *  ("Sony PlayStation 2" → sony, playstation, 2, ps2). */
export function platformWords(canon: string): Set<string> {
  const out = new Set<string>();
  for (const m of STATIC_ALIASES) if (m.canonical === canon) for (const w of m.alias.trim().split(" ")) if (w) out.add(w);
  const maker = makerOf(canon);
  if (maker) out.add(maker);
  return out;
}
const makerOf = (canon: string) =>
  /^Sega/.test(canon) ? "sega" : /^(PlayStation|PSP)/.test(canon) ? "sony" : /^Xbox/.test(canon) ? "microsoft"
  : /Nintendo|NES|Wii|GameCube|Game Boy|Virtual Boy|Famicom/.test(canon) ? "nintendo" : "";

/** The platform whose alias IS the whole text ("Nintendo Switch", "PS4") —
 *  brand words and colours aside — i.e. a console named after its platform. */
export function platformNameExact(text: string): string | null {
  const t = words(text);
  if (!t.trim()) return null;
  // As written ("Nintendo 64", "Super Nintendo", "Sega CD"), then without a
  // leading maker/colour ("Sony PlayStation 2", "Neon Nintendo Switch").
  const lead = t.replace(new RegExp(`^ ((${MAKERS}|${COLOURS}) )+`), " ");
  for (const c of t === lead ? [t] : [t, lead]) {
    for (const m of STATIC_ALIASES) {
      if (!m.alias.trim() || !c.startsWith(m.alias)) continue;
      // Only colour / finish words may follow: "Gameboy Advance Fuchsia Pink"
      // is a console, "Wii Sports" / "Game Boy Camera" are not.
      const rest = c.slice(m.alias.length).trim();
      if (!rest || rest.split(" ").every((w) => COLOUR_SET.has(w) || MAKER_SET.has(w))) return m.canonical;
    }
  }
  return null;
}
const MAKERS = "nintendo|sony|microsoft|sega";
const COLOURS = "black|white|red|blue|neon|gray|grey|pink|purple|green|yellow|orange|clear|gold|silver|atomic|teal|indigo|coral|fuchsia|glacier|arctic|platinum|dandelion|kiwi|grape|berry|jungle|spice|flame|cobalt|midnight|onyx|pearl|lime|smoke|charcoal|titanium|graphite|ice|emerald|crimson|turquoise|violet|lavender|mint|navy|ocean|sky|light|dark|metallic|matte|glossy|transparent|translucent|limited|edition";
const COLOUR_SET = new Set(COLOURS.split("|"));
const MAKER_SET = new Set(MAKERS.split("|"));

// Makers' names that eBay stores as the "platform" when an item has none
// (amiibo, docks, controllers). Not platforms — never parse them as one.
const BRAND_ONLY = /^(nintendo|sony|sega|microsoft|atari|nec|snk|bandai|bandai namco|hori|powera|pdp|mad catz|8bitdo|hyperkin|nyko|razer|turtle beach|logitech)$/i;

/** Built-in platforms + the catalog's own spellings. A catalog spelling that
 *  names a built-in platform ("Sony PlayStation 4", eBay's aspect) becomes an
 *  ALIAS of it — never its own canonical, which would split one platform in two
 *  and stop listings from matching imports and searches. */
export function buildPlatforms(catalogPlatforms: (string | null | undefined)[]): PlatformAlias[] {
  const extra = [...new Set(catalogPlatforms.filter((n) => n && !BRAND_ONLY.test(n.trim())) as string[])].map((name) => ({
    canonical: resolveStaticPlatform(name) ?? name,
    aliases: [name.toLowerCase()],
  }));
  return [...PLATFORM_ALIASES, ...extra];
}

function peel(s: string, entries: { key: string; canonical?: string; aliases: string[] }[]) {
  const all: { key: string; canonical?: string; alias: string }[] = [];
  // Aliases get the same clean-up as the query ("game & watch" → "game watch").
  for (const e of entries) for (const a of e.aliases) {
    const alias = a.toLowerCase().replace(/[^\w\s]/g, " ").replace(/\s+/g, " ").trim();
    if (alias) all.push({ key: e.key, canonical: e.canonical, alias });
  }
  all.sort((x, y) => y.alias.length - x.alias.length); // longest alias first
  for (const m of all) {
    const re = new RegExp("(^|\\s)" + m.alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "($|\\s)");
    const hit = re.exec(s);
    if (hit) return { key: m.key, canonical: m.canonical, alias: m.alias, before: s.slice(0, hit.index), rest: s.replace(re, " ") };
  }
  return null;
}

export function parseQuery(
  raw: string,
  opts: { completeness: TaxoEntry[]; grades: TaxoEntry[]; platforms: PlatformAlias[]; regions?: Region[] },
): ParsedQuery {
  let s = " " + raw.toLowerCase().replace(/[^\w\s]/g, " ").replace(/\s+/g, " ") + " ";
  const rOn = regionsOn(opts.regions);
  const out: ParsedQuery = { platform: null, completenessCode: "", gradeCode: "", title: "", platformText: "", titleForNew: "",
    regionCode: "", regionText: "", defaultRegion: rOn ? defaultRegionCode(opts.regions) : "", fullTitle: "" };
  // A typed region ("pal", "japan import") comes off FIRST — whole words, never
  // the home region or everyday words — so it can't be read as part of a
  // catalog platform name or the title. It becomes a filter, not search text.
  if (rOn) {
    const rg = peelRegion(raw, opts.regions);
    const re = rg.code ? new RegExp("(^|\\s)" + rg.text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "($|\\s)") : null;
    if (re && re.test(s)) { out.regionCode = rg.code; out.regionText = rg.text; s = s.replace(re, " "); }
  }
  // Peel the platform the query names by the BUILT-IN table (longest alias
  // wins, so "nintendo game boy color" is Game Boy Color, not the catalog's
  // "Nintendo Game Boy"), using every spelling of that one platform; only when
  // no built-in platform is named, try catalog-only names ("Game & Watch").
  const named = resolveStaticPlatform(s);
  const pm = peel(s, opts.platforms
    .filter((p) => (named ? p.canonical === named : !BUILTIN_CANON.has(p.canonical)))
    .map((p) => ({ key: p.canonical, canonical: p.canonical, aliases: [p.canonical.toLowerCase(), ...p.aliases] })));
  if (pm) { out.platform = pm.canonical ?? null; out.platformText = pm.alias; s = pm.rest; }
  // A platform only sold in Japan ("super famicom", "fds") implies the region.
  if (rOn && pm && !out.regionCode) out.regionCode = regionFromPlatform(pm.alias, opts.regions).code || regionFromPlatform(pm.canonical, opts.regions).code;
  const cm = peel(s, opts.completeness.map((c) => ({ key: c.code, aliases: [...c.aliases, c.label, c.code] })));
  if (cm) { out.completenessCode = cm.key; s = cm.rest; }
  const gm = peel(s, opts.grades.map((g) => ({ key: g.code, aliases: [...g.aliases, g.label, g.code] })));
  if (gm) { out.gradeCode = gm.key; s = gm.rest; }
  out.title = s.split(/\s+/).filter((w) => w && !NOISE.has(w)).join(" ").trim();
  // Keep the platform word in a NEW product's title only when it's one that
  // names games ("wii sports", "game boy camera") and no title word came
  // before it ("cib wii sports" still counts; "snes chrono trigger" never does).
  const titleWords = new Set(out.title.split(" "));
  const leads = !!pm && !pm.before.split(/\s+/).some((w) => w && titleWords.has(w));
  out.titleForNew = pm && leads && out.title && NAME_WITH_PLATFORM_RE.test(`${pm.alias} ${out.title}`) ? `${pm.alias} ${out.title}` : out.title;
  out.fullTitle = out.regionText ? parseQuery(raw, { ...opts, regions: undefined }).title : out.title;
  return out;
}

export function platformMatches(productPlatform: string | null | undefined, parsedPlatform: string): boolean {
  const a = (productPlatform || "").toLowerCase();
  const b = (parsedPlatform || "").toLowerCase();
  if (!a) return false;
  // Same built-in platform under any spelling ("PS4" vs "PlayStation 4"); a
  // listing naming several ("GameCube, Wii") matches any of them. The strict
  // test only applies when BOTH sides are built-in platforms.
  const ca = resolveStaticPlatforms(a), cb = resolveStaticPlatform(b);
  if (ca.length && cb) return ca.includes(cb);
  return a === b || a.includes(b) || b.includes(a);
}

export function matchScore(p: MatchableProduct, parsed: ParsedQuery): number {
  // Region: a typed one filters (another region never matches); with none
  // typed, an import ranks just under the home copy of the same title.
  const own = parsed.defaultRegion ? String(p.regionCode || parsed.defaultRegion).toUpperCase() : "";
  if (parsed.regionCode && own && own !== parsed.regionCode) {
    // …unless the "region" words are part of this listing's NAME ("Medal of
    // Honor: European Assault", "Japanese Rail Sim") — then they're title.
    return nameHas(p, parsed.regionText) ? scoreTitle(p, { ...parsed, title: parsed.fullTitle, regionCode: "" }) : 0;
  }
  const s = scoreTitle(p, parsed);
  return !parsed.regionCode && own && own !== parsed.defaultRegion ? s * 0.98 : s;
}
/** The listing's title / other names contain these whole words. */
export function nameHas(p: { title: string; altNames?: string[] | null }, words: string): boolean {
  const w = regionNorm(words);
  return !!w && (" " + regionNorm(`${p.title} ${(p.altNames || []).join(" ")}`) + " ").includes(" " + w + " ");
}
function scoreTitle(p: MatchableProduct, parsed: ParsedQuery): number {
  const hay = `${p.title} ${p.platform || ""} ${p.franchise || ""} ${(p.altNames || []).join(" ")}`.toLowerCase();
  if (parsed.platform && !platformMatches(p.platform, parsed.platform)) {
    // The platform word may be part of the NAME ("Wii Sports"), or the listing
    // has no/brand-only platform ("Nintendo"). Keep it as a weaker title match
    // instead of hiding it. Two different known platforms still exclude.
    // A listing on a DIFFERENT known platform never matches. One whose platform
    // is blank, a brand ("Nintendo", "Capcom") or other unknown text falls back
    // to a weaker title match, as do names that contain the platform word.
    if (!parsed.title) return 0;
    // The platform word + title IS the name ("Wii Sports Club" on Wii U,
    // "PlayStation Move" on PS3) — a real match whatever the platform.
    // "&" / "and" and punctuation ignored on both sides, and the phrase must
    // START on a word ("nes controller" ≠ an SNES one, "ds xl" ≠ a 3DS XL) —
    // but its LAST word may be partial or singular, so the listing stays put
    // while staff type ("wii sports clu", "nes controller" → "…Controllers").
    const names = phraseWords(`${p.title} ${(p.altNames || []).join(" ")}`);
    if (parsed.platformText && names.includes(phraseWords(`${parsed.platformText} ${parsed.title}`).trimEnd())) return 0.85;
    if (resolveStaticPlatform(p.platform)) return 0;
    if (hay.includes(parsed.title)) return 0.8;
    // Only REAL title words count — the platform word alone is not a match.
    const qt = parsed.title.split(" ").filter(Boolean);
    const hit = qt.filter((w) => hay.includes(w)).length;
    return hit ? (hit / qt.length) * 0.75 : 0;
  }
  if (!parsed.title) return 0.6;
  if (hay.includes(parsed.title)) return 1;
  const qt = parsed.title.split(" ").filter(Boolean);
  const hit = qt.filter((w) => hay.includes(w)).length;
  return hit ? (hit / qt.length) * 0.9 : 0;
}

export function smartMatches<T extends MatchableProduct>(items: T[], parsed: ParsedQuery): { p: T; s: number }[] {
  return items
    .map((p) => ({ p, s: matchScore(p, parsed) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s);
}
