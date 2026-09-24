// Shared smart find-or-create parsing, used by BOTH the inventory and trade-in
// entry screens (the "one entry flow for both"). Pure functions — no DOM.
//
// It peels structured tokens (platform / completeness / grade) off a phrase via
// alias lists, leaving the title remainder, then fuzzy-ranks catalog products by
// title + alternative names. Reliable because the vocabulary is structured config.

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
}
export interface MatchableProduct {
  title: string;
  platform?: string | null;
  franchise?: string | null;
  altNames?: string[];
}
export interface PlatformAlias {
  canonical: string;
  aliases: string[];
}

export const PLATFORM_ALIASES: PlatformAlias[] = [
  // Canonical names follow PriceCharting's console naming so CSV imports line
  // up; aliases cover shorthand staff type and the spellings other sources use.
  { canonical: "Nintendo Switch", aliases: ["nintendo switch", "switch", "nsw", "switch 2", "nintendo switch 2"] },
  { canonical: "Super Nintendo", aliases: ["super nintendo", "snes", "super nes", "super famicom", "sfc", "super nintendo entertainment system"] },
  { canonical: "Nintendo 64", aliases: ["nintendo 64", "n64"] },
  { canonical: "GameCube", aliases: ["gamecube", "game cube", "gcn", "ngc", "nintendo gamecube"] },
  { canonical: "Wii U", aliases: ["wii u", "nintendo wii u", "wiiu"] },
  { canonical: "Wii", aliases: ["wii", "nintendo wii"] },
  { canonical: "Game Boy Advance", aliases: ["game boy advance", "gameboy advance", "gba"] },
  { canonical: "Game Boy Color", aliases: ["game boy color", "gameboy color", "gbc"] },
  { canonical: "Game Boy", aliases: ["game boy", "gameboy", "gb", "dmg"] },
  { canonical: "Nintendo 3DS", aliases: ["nintendo 3ds", "3ds", "new 3ds", "new nintendo 3ds", "2ds"] },
  { canonical: "Nintendo DS", aliases: ["nintendo ds", "nds", "ds", "dsi"] },
  { canonical: "Virtual Boy", aliases: ["virtual boy"] },
  { canonical: "NES", aliases: ["nintendo entertainment system", "nes", "famicom", "nintendo nes"] },
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
  { canonical: "Neo Geo", aliases: ["neo geo", "neogeo", "neo geo aes", "neo geo pocket color", "neo geo pocket"] },
  { canonical: "Intellivision", aliases: ["intellivision"] },
  { canonical: "ColecoVision", aliases: ["colecovision"] },
  { canonical: "3DO", aliases: ["3do"] },
  { canonical: "N-Gage", aliases: ["n gage", "ngage"] },
];

const NOISE = new Set(["condition", "cond", "the", "a", "of"]);

export function buildPlatforms(catalogPlatforms: (string | null | undefined)[]): PlatformAlias[] {
  const extra = [...new Set(catalogPlatforms.filter(Boolean) as string[])].map((name) => ({
    canonical: name,
    aliases: [name.toLowerCase()],
  }));
  return [...PLATFORM_ALIASES, ...extra];
}

function peel(s: string, entries: { key: string; canonical?: string; aliases: string[] }[]) {
  const all: { key: string; canonical?: string; alias: string }[] = [];
  for (const e of entries) for (const a of e.aliases) if (a) all.push({ key: e.key, canonical: e.canonical, alias: a.toLowerCase() });
  all.sort((x, y) => y.alias.length - x.alias.length); // longest alias first
  for (const m of all) {
    const re = new RegExp("(^|\\s)" + m.alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "($|\\s)");
    if (re.test(s)) return { key: m.key, canonical: m.canonical, rest: s.replace(re, " ") };
  }
  return null;
}

export function parseQuery(
  raw: string,
  opts: { completeness: TaxoEntry[]; grades: TaxoEntry[]; platforms: PlatformAlias[] },
): ParsedQuery {
  let s = " " + raw.toLowerCase().replace(/[^\w\s]/g, " ").replace(/\s+/g, " ") + " ";
  const out: ParsedQuery = { platform: null, completenessCode: "", gradeCode: "", title: "" };
  const pm = peel(s, opts.platforms.map((p) => ({ key: p.canonical, canonical: p.canonical, aliases: p.aliases })));
  if (pm) { out.platform = pm.canonical ?? null; s = pm.rest; }
  const cm = peel(s, opts.completeness.map((c) => ({ key: c.code, aliases: [...c.aliases, c.label, c.code] })));
  if (cm) { out.completenessCode = cm.key; s = cm.rest; }
  const gm = peel(s, opts.grades.map((g) => ({ key: g.code, aliases: [...g.aliases, g.label, g.code] })));
  if (gm) { out.gradeCode = gm.key; s = gm.rest; }
  out.title = s.split(/\s+/).filter((w) => w && !NOISE.has(w)).join(" ").trim();
  return out;
}

export function platformMatches(productPlatform: string | null | undefined, parsedPlatform: string): boolean {
  const a = (productPlatform || "").toLowerCase();
  const b = (parsedPlatform || "").toLowerCase();
  return !!a && (a === b || a.includes(b) || b.includes(a));
}

export function matchScore(p: MatchableProduct, parsed: ParsedQuery): number {
  if (parsed.platform && !platformMatches(p.platform, parsed.platform)) return 0;
  if (!parsed.title) return 0.6;
  const hay = `${p.title} ${p.platform || ""} ${p.franchise || ""} ${(p.altNames || []).join(" ")}`.toLowerCase();
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
