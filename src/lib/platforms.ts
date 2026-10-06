// Game platforms for the Add form / edit window dropdowns.
//
// A platform is a listing's text field (products.platform) — there is no
// platforms table. The dropdown offers:
//   "Your platforms" — ones the store ADDED (store_settings.settings.platforms,
//                       kept even before any listing uses them) + every
//                       spelling the catalog already uses;
//   "More platforms" — the built-in list (smartSearch) not used yet.
// "＋ New platform…" adds one to the store's list (any staff — it's a name).

import { PLATFORM_ALIASES, BRAND_ONLY, resolveStaticPlatform } from "./smartSearch";

export const MAX_PLATFORM_LEN = 60;

/** A typed platform name, tidied ("" if unusable). */
export function cleanPlatformName(raw: unknown): string {
  return String(raw ?? "").replace(/[\u0000-\u001f<>]/g, "").replace(/\s+/g, " ").trim().slice(0, MAX_PLATFORM_LEN);
}

/** The platforms the store added (Settings / ＋ New platform…). */
export function customPlatforms(settings: any): string[] {
  const raw = Array.isArray(settings?.platforms) ? settings.platforms : [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of raw) {
    const n = cleanPlatformName(r);
    if (n && !seen.has(n.toLowerCase())) { seen.add(n.toLowerCase()); out.push(n); }
  }
  return out.slice(0, 200);
}

/** The store's list with one more (case-insensitive: an existing spelling wins). */
export function withPlatform(list: string[], name: string): string[] {
  const n = cleanPlatformName(name);
  if (!n || list.some((x) => x.toLowerCase() === n.toLowerCase())) return list;
  return [...list, n].slice(0, 200);
}

export interface PlatformGroups { yours: string[]; more: string[] }

/** The dropdown's two groups. Catalog spellings are kept exactly as stored
 *  (a dropdown must never rename a listing's platform behind your back). */
export function platformGroups(catalog: (string | null | undefined)[], custom: string[]): PlatformGroups {
  const seen = new Map<string, string>();
  for (const n of [...custom, ...catalog]) {
    const name = cleanPlatformName(n);
    if (!name || BRAND_ONLY.test(name)) continue; // "Nintendo" isn't a platform
    if (!seen.has(name.toLowerCase())) seen.set(name.toLowerCase(), name);
  }
  const yours = [...seen.values()].sort((a, b) => a.localeCompare(b));
  // A built-in is left out only when it's literally one of yours — "PC Engine"
  // in the catalog must not hide "TurboGrafx-16" (a different release).
  const covered = new Set(yours.map((y) => y.toLowerCase()));
  const more = PLATFORM_ALIASES.map((p) => p.canonical).filter((c) => !covered.has(c.toLowerCase())).sort((a, b) => a.localeCompare(b));
  return { yours, more };
}

/** The option a name means: the same spelling, else the built-in platform it
 *  spells ("PS4" → "PlayStation 4"). Never a sibling / regional name ("PC
 *  Engine" for "TurboGrafx-16") — those are different releases. */
export function matchPlatform(name: string, options: string[]): string | null {
  const n = cleanPlatformName(name);
  if (!n) return null;
  const exact = options.find((o) => o.toLowerCase() === n.toLowerCase());
  if (exact) return exact;
  const canon = resolveStaticPlatform(n);
  if (!canon) return null;
  return options.find((o) => o.toLowerCase() === canon.toLowerCase()) ?? null;
}
