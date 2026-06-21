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
  { canonical: "Nintendo Switch", aliases: ["nintendo switch", "switch", "nsw"] },
  { canonical: "Super Nintendo", aliases: ["super nintendo", "snes", "super nes", "super famicom", "sfc"] },
  { canonical: "Nintendo 64", aliases: ["nintendo 64", "n64"] },
  { canonical: "Game Boy Advance", aliases: ["game boy advance", "gba"] },
  { canonical: "Game Boy", aliases: ["game boy color", "gbc", "game boy", "gameboy", "gb"] },
  { canonical: "GameCube", aliases: ["gamecube", "game cube", "gcn", "ngc"] },
  { canonical: "Nintendo DS", aliases: ["nintendo ds", "nds", "3ds", "ds"] },
  { canonical: "NES", aliases: ["nintendo entertainment system", "nes", "famicom"] },
  { canonical: "PlayStation 2", aliases: ["playstation 2", "ps2"] },
  { canonical: "PlayStation 3", aliases: ["playstation 3", "ps3"] },
  { canonical: "PlayStation", aliases: ["playstation", "psx", "ps1", "ps one", "psone"] },
  { canonical: "Xbox 360", aliases: ["xbox 360", "x360"] },
  { canonical: "Xbox", aliases: ["xbox"] },
  { canonical: "Sega Genesis", aliases: ["sega genesis", "genesis", "mega drive", "megadrive"] },
  { canonical: "Sega Dreamcast", aliases: ["sega dreamcast", "dreamcast"] },
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
