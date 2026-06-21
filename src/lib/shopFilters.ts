// Keyword-driven storefront classification.
//
// The imported eBay `category` field is unreliable — games, mugs, towels, skins
// and plushes were all dumped into "Consoles" (≈half the catalogue), so trusting
// it makes the category tabs meaningless. Instead we derive a shopper-facing
// DEPARTMENT plus a set of FACETS (platform / condition / region / franchise)
// from the listing's title + platform text. Rules live here as data so a future
// licensee can retune them without touching the storefront code.

export interface ShopItem {
  title?: string | null;
  platform?: string | null;
  franchise?: string | null;
  category?: string | null;
  description?: string | null;
}

export interface Rule {
  key: string;
  label: string;
  icon?: string;
  test: RegExp;
}

const text = (i: ShopItem) =>
  `${i.title || ""} ${i.platform || ""} ${i.franchise || ""}`.toLowerCase();

// First match wins, so order = priority (most specific department first). The
// last entry, "games", is the broad residual: anything that names a platform or
// reads like software but isn't a plush / collectible / accessory / merch / unit.
export const DEPARTMENTS: Rule[] = [
  { key: "plushies", label: "Plushies", icon: "🧸",
    test: /\b(plush|plushie|plushy|plushies|stuffed|amigurumi|beanie baby|soft toy)\b/ },
  { key: "collectibles", label: "Collectibles", icon: "🏆",
    test: /\b(figure|figurine|figures|statue|amiibo|funko|gashapon|re-?ment|nendoroid|nanoblock|diorama|trading ?cards?|tcg|model kit|mini ?figure|minifigure|plaque|medallion)\b/ },
  { key: "accessories", label: "Accessories", icon: "🎮",
    test: /\b(controller|gamepad|joy-?con|joystick|nunchuk|wii ?remote|motion plus|remote plus|memory card|dock|docking|stylus|touch pen|cable|hdmi|ac ?adapter|ac ?adaptor|charger|charging|adapter|adaptor|power supply|stand|storage rack|rack|mount|carrying case|game case|console case|cover|screen protector|skin|battery|pokewalker|grip)\b/ },
  { key: "merch", label: "Merch", icon: "👕",
    test: /\b(mug|towel|t-?shirt|tee|hoodie|sweater|jacket|hat|cap|backpack|bag|lanyard|keychain|key ?chain|keyring|sticker|poster|pin|mousepad|mouse pad|wall scroll|tapestry|blanket|pillow|cushion|soundtrack|vinyl|ost|art ?book|artbook|strategy guide|guide book|book|notebook|stationery|badge|cup|bottle)\b/ },
  { key: "consoles", label: "Consoles", icon: "🕹️",
    test: /\b(console|system bundle|handheld system)\b/ },
  { key: "games", label: "Games", icon: "💿",
    test: /\b(game|games|cib|complete in box|cartridge|\bcart\b|disc|software|sealed)\b|\b(snes|nes|n64|gba|gbc|3ds|ds|wii ?u|wii|switch|game ?cube|famicom|super famicom|sfc|genesis|saturn|dreamcast|ps1|ps2|ps3|ps4|psp|vita|xbox|game ?boy)\b/ },
];

// Platform facet — order matters (wiiu before wii, 3ds before ds, snes before nes).
export const PLATFORMS: Rule[] = [
  { key: "switch", label: "Switch", test: /\bswitch\b/ },
  { key: "wiiu", label: "Wii U", test: /wii ?u\b/ },
  { key: "wii", label: "Wii", test: /\bwii\b/ },
  { key: "3ds", label: "3DS", test: /\b(new )?3ds\b/ },
  { key: "ds", label: "DS", test: /\b(nintendo )?ds\b|\bdsi\b/ },
  { key: "gamecube", label: "GameCube", test: /game ?cube|\bgcn\b/ },
  { key: "n64", label: "N64", test: /\bn64\b|nintendo 64/ },
  { key: "snes", label: "SNES / Super Famicom", test: /\bsnes\b|super ?nintendo|super ?famicom|\bsfc\b/ },
  { key: "nes", label: "NES / Famicom", test: /\bnes\b|famicom/ },
  { key: "gba", label: "Game Boy Advance", test: /\bgba\b|game boy advance/ },
  { key: "gameboy", label: "Game Boy", test: /game ?boy|\bgbc\b|\bgb\b/ },
  { key: "vita", label: "PS Vita", test: /\bvita\b|ps ?vita/ },
  { key: "ps2", label: "PS2", test: /\bps2\b|playstation 2/ },
  { key: "ps1", label: "PS1", test: /\bps1\b|\bpsx\b|playstation(?! ?[234])/ },
  { key: "psp", label: "PSP", test: /\bpsp\b/ },
];

// Condition facet — derived from title keywords (the structured field is sparse
// on imports). Order: sealed, then open-box, then complete, then loose.
export const CONDITIONS: Rule[] = [
  { key: "sealed", label: "Sealed / New", test: /\bsealed\b|brand new|factory sealed|\bnib\b|\bbnib\b|new in box|new w\/? ?tags?/ },
  { key: "openbox", label: "Open Box", test: /open box|certified open box|\bcob\b/ },
  { key: "cib", label: "Complete (CIB)", test: /\bcib\b|complete in box|\bcomplete\b/ },
  { key: "loose", label: "Loose", test: /\bloose\b|cart only|disc only|cartridge only/ },
];

export const REGIONS: Rule[] = [
  { key: "japan", label: "🇯🇵 Japan Import", test: /\bjapan\b|japanese|\bimport\b|region ?free|ntsc-?j|famicom/ },
];

export const FRANCHISES: Rule[] = [
  { key: "pokemon", label: "Pokémon", test: /pok[eé]mon|pikachu|jigglypuff|mewtwo|\beevee\b/ },
  { key: "zelda", label: "Zelda", test: /zelda|hyrule|ganon/ },
  { key: "mario", label: "Mario", test: /\bmario\b|luigi|yoshi|\bpeach\b|bowser/ },
  { key: "kirby", label: "Kirby", test: /kirby/ },
  { key: "metroid", label: "Metroid", test: /metroid|samus/ },
  { key: "fireemblem", label: "Fire Emblem", test: /fire emblem/ },
  { key: "animalcrossing", label: "Animal Crossing", test: /animal crossing/ },
  { key: "splatoon", label: "Splatoon", test: /splatoon|inkling/ },
  { key: "earthbound", label: "EarthBound", test: /earthbound|\bmother\b|\bness\b/ },
  { key: "sonic", label: "Sonic", test: /\bsonic\b/ },
];

function firstMatch(rules: Rule[], i: ShopItem): string {
  const t = text(i);
  for (const r of rules) if (r.test.test(t)) return r.key;
  return "";
}

export interface ItemFacets {
  dept: string;
  platform: string;
  cond: string;
  region: string;
  franchise: string;
}

export function classify(i: ShopItem): ItemFacets {
  return {
    dept: firstMatch(DEPARTMENTS, i) || "other",
    platform: firstMatch(PLATFORMS, i),
    cond: firstMatch(CONDITIONS, i),
    region: firstMatch(REGIONS, i),
    franchise: firstMatch(FRANCHISES, i),
  };
}
