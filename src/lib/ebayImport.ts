// eBay store import — pure logic for the eBay importer dialog (no DOM). Turns
// the store's listings (search summaries + item specifics) into the same
// ImportRow shape the collection CSV import uses, so both share matching,
// staging onto an entry draft, and Finish → labels.

import { resolvePlatform, itemKind, type ImportRow } from "./collectionImport";
import { PLATFORM_ALIASES, resolveStaticPlatforms, type PlatformAlias, type TaxoEntry } from "./smartSearch";
import { type Region, regionOf, regionFromEbayAspect, regionFromPlatform, splitTitleRegion, regionFromText } from "./regions";

/** A store listing as the server's "store-list" returns it. */
export interface EbayListing {
  id: string;
  title: string;
  priceCents: number;
  conditionId: string;
  condition: string;
  categories: string[]; // leaf first
  image: string;
  imageCount: number;
  url: string;
  imported: { productId: string; title: string } | null;
}
/** Item specifics from the server's "store-details". */
export interface EbayDetails {
  id: string;
  platform: string;
  gameName: string;
  series?: string;
  regionAspect: string;
  country: string;
  qty: number;
  inStock: boolean;
  upc: string;
  completenessCode: string;
  gradeCode: string;
  brand: string;
}

/** An import row that came from an eBay listing. */
export interface EbayImportRow extends ImportRow {
  ebay: {
    id: string;
    title: string;          // the eBay listing title, as listed
    url: string;
    image: string;
    imageCount: number;
    priceCents: number;     // the eBay price
    group: EbayGroup;
    leaf: string;           // eBay's leaf category name
    japan: boolean;         // a Japanese item (region, title, or made in Japan)
    japanWhy: string;
  };
}

/* ---------------- Groups (what kind of thing it is, from eBay's category) ---------------- */

export type EbayGroup = "games" | "consoles" | "accessories" | "merch" | "toys" | "books" | "media" | "other";
export const EBAY_GROUPS: { key: EbayGroup; label: string }[] = [
  { key: "games", label: "Games" },
  { key: "consoles", label: "Consoles" },
  { key: "accessories", label: "Accessories" },
  { key: "merch", label: "Merch" },
  { key: "toys", label: "Toys & plush" },
  { key: "books", label: "Books & guides" },
  { key: "media", label: "Movies & music" },
  { key: "other", label: "Other" },
];

export function ebayGroup(categories: string[]): EbayGroup {
  const leaf = (categories[0] || "").toLowerCase();
  const path = categories.join(" | ").toLowerCase();
  if (/strategy guide|\bbooks?\b|magazine/.test(path)) return "books";
  if (/video game consoles/.test(path)) return "consoles";
  if (/video game accessories|replacement parts|original game cases/.test(path)) return "accessories";
  if (leaf === "video games") return "games";
  if (/merchandise|memorabilia|advertising|animation|calendar/.test(path)) return "merch";
  if (/toys & hobbies|stuffed|plush|action figure/.test(path)) return "toys";
  if (/movies|music|\bdvd|blu-ray|\bcds\b/.test(path)) return "media";
  if (/video games/.test(path)) return "games";
  return "other";
}

/** The store category a group lands in by default (a name pattern, so a store
 *  with a "Merch" category uses it; else Collectibles). "" = the dialog default. */
export function defaultCategoryFor(group: EbayGroup, categories: { id: string; name: string }[]): string {
  const find = (...res: RegExp[]) => { for (const re of res) { const c = categories.find((x) => re.test(x.name)); if (c) return c.id; } return ""; };
  switch (group) {
    case "games": return find(/^video games?$/i, /video game/i, /^games?$/i);
    case "consoles": return find(/console/i, /hardware|system/i);
    case "accessories": return find(/accessor/i);
    case "merch": return find(/merch/i, /collect/i);
    case "toys": return find(/toy|plush/i, /collect/i);
    case "books": return find(/book|guide/i);
    case "media": return find(/movie|film|music|media/i);
    default: return find(/collect/i);
  }
}

/* ---------------- Titles ---------------- */

// Words sellers add for search that aren't part of the name. Case-sensitive
// where a real title could use the word ("New Super Mario Bros.", "Castlevania
// … Complete"): only the shouted / phrase forms go.
const NOISE_ANY = /\b(us seller|ships? from (the )?usa?|region free|box (and |& |\+ )?manuals?|manuals?|tested|refurbished|warranty|black label|pocket monsters?|japan version|brand new|factory sealed|new sealed|sealed|authentic|genuine|official(ly licensed)?|licensed|oem|rare|htf|hard to find|tested|works great|working|clean disc|clean|physical( game| copy)?|video game|game only|disc only|cart(ridge)? only|complete in box|cib|in box|w\/ ?manual|with manual|manual included|free shipping|fast shipping|ships fast|excellent|near mint|very good|great condition|good condition|l@@k|look|wow)\b/gi;
const NOISE_CAPS = /\b(NEW|COMPLETE|USED|LOOSE|MINT|NICE|GREAT|GOOD|VINTAGE|RETRO|AUTHENTIC|OFFICIAL)\b/g;
const JP_WORDS = /\b(japan(ese)?( import| version)?|jpn|ntsc[- ]?j|jp( import)?|import(ed)?)\b/gi;
const MAKERS = /\b(sony|microsoft)\b/gi;

/** Platform names (any alias of the row's platform, maker included) in a title. */
function platformRe(canonical: string): RegExp | null {
  const p = PLATFORM_ALIASES.find((x) => x.canonical === canonical);
  if (!p) return null;
  const alts = [p.canonical, ...p.aliases].map((a) => a.toLowerCase().replace(/[^a-z0-9]+/g, "[\\s-]*")).sort((a, b) => b.length - a.length);
  return new RegExp(`\\b(nintendo\\s+|sony\\s+|sega\\s+|microsoft\\s+)?(${alts.join("|")})\\b`, "gi");
}

const tidy = (s: string) => s
  .replace(/\(\s*(\d{4})?\s*\)/g, " ")                    // "()" / "(2005)"
  .replace(/\*+/g, " ")                                       // "*ACRYLIC STAND*"
  .replace(/(\s[\-–—/|,+&])(?:\s+[\-–—/|,+&])+(?=\s)/g, "$1") // "Fan + + Sheet" left by a removed word
  .replace(/^[\s:\-–—/|,+&]+|[\s:\-–—/|,+&]+$/g, "")
  .replace(/\s{2,}/g, " ")
  .trim();
// A name typed in capitals ("TOMATO ADVENTURE") → "Tomato Adventure";
// short all-caps words (DS, GBA, II, HD) stay as they are.
const unshout = (s: string) => /[a-z]/.test(s) || !/[A-Z]{3}/.test(s) ? s
  : s.replace(/[A-Z][A-Z'’]+/g, (w) => (w.length <= 3 && !/^(THE|AND|FOR|OF|IN|ON|TO|AT|BY|OR|NO|AN|MY|UP|OUT|ALL|ONE|TWO|BIG|NEW|OLD|RED|SUN|DAY|WAR|MAN|BOY|CAT|DOG)$/.test(w) ? w : w[0] + w.slice(1).toLowerCase()));

/** A game's name from its eBay title: the noise, the platform and the region
 *  words come off ("Legend of Zelda Ocarina of Time CIB NINTENDO 64 Japan
 *  Authentic COMPLETE N64" → "Legend of Zelda Ocarina of Time"). */
export function cleanGameTitle(title: string, platform: string): string {
  let t = ` ${title} `.replace(/\s+/g, " ");
  const pr = platform ? platformRe(platform) : null;
  if (pr) t = t.replace(pr, " ");
  t = t.replace(NOISE_ANY, " ").replace(NOISE_CAPS, " ").replace(JP_WORDS, " ").replace(MAKERS, " ");
  t = t.replace(/\(\s*(19|20)\d{2}\s*\)/g, " ").replace(/\s(nintendo|sega)\s*$/i, " ");
  const out = tidy(t);
  return out.length >= 2 ? out : title.trim();
}

/** Merch / accessories keep their words (platform, "Japan" — they describe the
 *  item); only the seller's search noise comes off. */
export function cleanItemTitle(title: string): string {
  const t = ` ${title} `.replace(/\s+/g, " ").replace(NOISE_ANY, " ").replace(NOISE_CAPS, " ")
    .replace(/\s(new( with tags?)?|nwt|used|open box)\s*$/i, " "); // a closing condition word ("… Nintendo Tokyo New")
  const out = tidy(t);
  return out.length >= 2 ? out : title.trim();
}

// Edition / print words that make a different product than the base game —
// kept as a bracket qualifier when eBay's Game Name leaves them out.
const EDITION_RES: RegExp[] = [
  /\bcollector'?s edition\b/i, /\blimited edition\b/i, /\bspecial edition\b/i, /\bdeluxe edition\b/i,
  /\blaunch edition\b/i, /\bday one edition\b/i, /\bsteelbook\b/i, /\banniversary edition\b/i,
  /\bsignature edition\b/i, /\bpremium edition\b/i, /\bgame of the year( edition)?\b/i, /\bgoty\b/i,
  /\bdefinitive edition\b/i, /\bgreatest hits\b/i, /\bplayer'?s choice\b/i, /\bnintendo selects\b/i, /\bplatinum hits\b/i,
  /\bbig box\b/i, /\bvariant cover\b/i,
];
const titleCase = (s: string) => s.replace(/(^|\s)([a-z])/g, (_, a, b) => a + b.toUpperCase());
export function editionTags(ebayTitle: string, name: string): string[] {
  const has = (s: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, " ").includes(s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim());
  const tags: string[] = [];
  // The catalog's convention is a plain "[Limited Run]" (no print number).
  if (/\b(lrg|limited run( games)?)\b/i.test(ebayTitle) && !has("limited run")) tags.push("Limited Run");
  for (const re of EDITION_RES) {
    const m = ebayTitle.match(re);
    if (m && !has(m[0]) && !tags.some((t) => t.toLowerCase() === m[0].toLowerCase())) tags.push(titleCase(m[0].toLowerCase()));
  }
  return tags;
}

/* ---------------- Price ---------------- */

export interface PriceRule {
  /** Percent of the eBay price (90 = 10% off). */
  pct: number;
  /** Round to the nearest $step (0 = no rounding). */
  step: number;
  /** Under this many dollars, round to the nearest $1 instead (0 = never). */
  smallBelow: number;
  /** Never above the eBay price (rounding that would go over goes down). */
  cap: boolean;
}

/** The expo price for an eBay price: 90% of $139 → $125.10 → $125 (nearest $5);
 *  under $20 → nearest $1; never above the eBay price; never $0. */
export function expoPrice(ebayCents: number, r: PriceRule): number {
  if (!(ebayCents > 0)) return 0;
  const raw = (ebayCents * Math.max(1, Math.min(500, r.pct))) / 100;
  if (!(r.step > 0)) return Math.round(raw);
  const stepC = Math.round((r.smallBelow > 0 && raw < r.smallBelow * 100 ? 1 : r.step) * 100);
  // "Never above eBay" allows the whole-dollar round-up ($49.99 → $50).
  const ceiling = Math.ceil(ebayCents / 100) * 100;
  let c = Math.round(raw / stepC) * stepC;
  if (r.cap && c > ceiling) c = Math.floor(raw / stepC) * stepC;
  if (c <= 0) c = Math.max(100, Math.round(raw / 100) * 100); // never $0
  if (r.cap && c > ceiling) c = Math.round(raw);
  return c;
}

/* ---------------- Game Name sanity ---------------- */

const fold = (x: string) => x.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
const STOP = new Set(["the", "of", "and", "no", "a", "an", "to", "in", "on", "for", "de", "series"]);
// Words that, right after a series name, make it a different game: Pokémon
// PLATINUM, Mario Kart ADVANCE, Animal Crossing HORIZONS, Fire Emblem MYSTERY…
const VERSION_WORDS = new Set([
  "red", "blue", "yellow", "green", "gold", "silver", "crystal", "ruby", "sapphire", "emerald", "firered", "leafgreen",
  "diamond", "pearl", "platinum", "heartgold", "soulsilver", "black", "white", "x", "y", "sun", "moon", "ultra",
  "sword", "shield", "scarlet", "violet", "legends", "ranger", "mystery", "dungeon", "colosseum", "xd", "stadium", "snap",
  "advance", "horizons", "heroes", "new", "wild", "city", "island", "world", "origins", "plus", "deluxe", "party",
  "tour", "circuit", "double", "dash", "64", "ds", "3d", "e", "returns", "tropical", "jungle", "universe",
]);
const ROMAN = /^(ii|iii|iv|v|vi|vii|viii|ix|x)$/;
/** Why eBay's Game Name can't be trusted as the title, or "" when it can:
 *  only the series ("Pokémon" on Pokémon Platinum — two games would merge),
 *  or not this listing at all (a "Horror" Game Name on Clock Tower). */
export function gameNameProblem(name: string, series: string, ebayTitle: string, platform: string): string {
  if (!name) return "";
  const n = fold(name).replace(/^the /, "");
  const t = fold(ebayTitle), tc = t.replace(/ /g, ""); // "Heart Gold" ~ "HeartGold"
  const sig = n.split(" ").filter((w) => w.length >= 3 && !STOP.has(w));
  if (sig.length && sig.filter((w) => tc.includes(w)).length / sig.length < 0.5)
    return `eBay's Game Name “${name}” doesn't match the listing title — used the title; check it`;
  if (/\s/.test(n) && fold(series).replace(/\bseries\b/g, "").replace(/^the /, "").trim() !== n) return "";
  const rest = fold(cleanGameTitle(ebayTitle, platform)).replace(/^the /, "");
  if (!rest.startsWith(n + " ")) return "";
  const next = rest.slice(n.length + 1).split(" ").find((w) => !["complete", "game", "nintendo", "sony", "sega", "version", "the"].includes(w)) || "";
  const differs = VERSION_WORDS.has(next) || ROMAN.test(next) || (/^\d{1,2}$/.test(next) && +next >= 2);
  return differs ? `eBay's Game Name is just “${name}” (the title says “${name} ${next}…”) — used the title; check it` : "";
}

/* ---------------- Rows ---------------- */

export interface EbayBuildOpts {
  completeness: TaxoEntry[];
  grades: TaxoEntry[];
  platforms: PlatformAlias[];
  regions?: Region[];
  /** Completeness when eBay doesn't say — games, then everything else. */
  defaultGameCompleteness: string;
  defaultItemCompleteness: string;
  defaultGrade: string;
  /** Use eBay's Game Name / a cleaned title instead of the listing title. */
  cleanTitles: boolean;
}

/** One import row per eBay listing (never merged: each carries its own eBay id). */
export function buildEbayRows(listings: EbayListing[], details: Map<string, EbayDetails>, o: EbayBuildOpts): EbayImportRow[] {
  const jpCode = regionFromText("japan", o.regions) || "JP";
  return listings.map((l, i) => {
    const d = details.get(l.id);
    const group = ebayGroup(l.categories);
    const warnings: string[] = [];
    // Platform: eBay's Platform aspect, else (games only) the platform the
    // title names. Merch has none.
    const aspect = d?.platform || "";
    let pr = resolvePlatform(aspect, o.platforms, o.regions);
    let platform = pr.canonical || "";
    if (!platform && aspect && group !== "games") platform = aspect.slice(0, 80); // "Tamagotchi (Ochi)"
    if (!platform && (group === "games" || group === "consoles" || group === "accessories")) {
      const fromTitle = resolveStaticPlatforms(l.title)[0];
      if (fromTitle) { platform = fromTitle; pr = resolvePlatform(fromTitle, o.platforms, o.regions); }
    }
    // The title naming a different platform beats the Platform field (a
    // Saturn pad listed under "PlayStation 4").
    const titlePlats = resolveStaticPlatforms(l.title);
    if (platform && pr.canonical && titlePlats.length && !titlePlats.includes(platform)) {
      warnings.push(`eBay's Platform says “${aspect}” but the title says ${titlePlats[0]} — used ${titlePlats[0]}`);
      platform = titlePlats[0];
      pr = resolvePlatform(platform, o.platforms, o.regions);
    }
    if (!platform && group === "games") warnings.push("eBay doesn't name a platform — pick it on the draft if this is a game");
    // Region: eBay's Region Code, else a Japan-only platform, else a bracket
    // tag, else (games) "Japan" / "NTSC-J" in the title.
    const split = splitTitleRegion(l.title, o.regions);
    const titleJp = new RegExp(JP_WORDS.source, "i").test(l.title) && !/\bpal\b/i.test(l.title);
    const aspectRegion = regionFromEbayAspect(d?.regionAspect, o.regions);
    const regionCode = aspectRegion || pr.region || regionFromPlatform(aspect, o.regions).code || split.code
      || (titleJp && group !== "merch" && group !== "toys" ? jpCode : "");
    const region = regionOf(regionCode, o.regions);
    const madeInJapan = /japan/i.test(d?.country || "");
    // "Made in Japan" means an import only for merch: Nintendo's US
    // accessories and consoles were made in Japan too.
    // eBay's Region Code is the seller's deliberate answer: a title that says
    // "Japan" on a listing marked US / PAL is flagged, not believed.
    const titleOverruled = titleJp && !!aspectRegion && aspectRegion !== jpCode;
    if (titleOverruled) warnings.push(`The eBay title says Japan but its Region Code is ${aspectRegion} — check the region`);
    const japan = region === jpCode || (titleJp && !titleOverruled) || (madeInJapan && (group === "merch" || group === "toys"));
    const japanWhy = region === jpCode ? "region" : titleJp && !titleOverruled ? "title" : japan ? "made in Japan" : "";
    // Title: a game takes eBay's Game Name (+ an edition the name leaves out);
    // anything else, the listing title less the seller's search words.
    let title = l.title.replace(/\s+/g, " ").trim();
    if (o.cleanTitles) {
      if (group === "games") {
        const name = unshout((d?.gameName || "").replace(/\s+/g, " ").trim());
        const why = gameNameProblem(name, d?.series || "", l.title, platform);
        if (why) warnings.push(why);
        const generic = !!why;
        const base = name.length >= 2 && !generic ? name : cleanGameTitle(split.title, platform);
        const eds = editionTags(l.title, base);
        title = base + eds.map((t) => ` [${t}]`).join("");
      } else title = cleanItemTitle(split.title);
    } else title = split.title || title;
    const kind: ImportRow["kind"] = group === "consoles" ? "console" : group === "accessories" ? "accessory"
      : group === "merch" || group === "toys" ? "collectible" : group === "games" ? "" : itemKind(title, platform);
    const isGame = group === "games";
    const completenessCode = d?.completenessCode || (isGame ? o.defaultGameCompleteness : o.defaultItemCompleteness);
    const gradeCode = d?.gradeCode || o.defaultGrade;
    if (!d) warnings.push("Couldn't read this listing's details from eBay — check platform, condition and qty");
    return {
      n: i + 1, title, platform, platformRaw: aspect, platformResolved: !!pr.canonical || !aspect,
      region, completenessCode, gradeCode, gradeFromSheet: true, conditionRaw: l.condition,
      qty: Math.max(1, d?.qty || 1), priceCents: l.priceCents, costCents: null,
      upc: (d?.upc || "").replace(/[^0-9]/g, ""), pcId: "", notes: "", folder: "", pcValueCents: null,
      kind, lot: /\blot of\b|\bbundle of\b|\bbulk lot\b/i.test(l.title), warnings,
      ...(title !== l.title.trim() ? { titleFrom: l.title.trim() } : {}),
      ebay: {
        id: l.id, title: l.title, url: l.url, image: l.image, imageCount: l.imageCount, priceCents: l.priceCents,
        group, leaf: l.categories[0] || "", japan, japanWhy,
      },
    };
  });
}
