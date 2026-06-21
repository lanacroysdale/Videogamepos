// Shared completeness display + typed-shorthand resolution.
//
// Levels come from the completeness_levels table ({ code, label, aliases }).
// The `code` doubles as the short badge (CIB, COB, IB, NEW); single-letter codes
// like "L" (Loose) fall back to the full label so the badge stays readable.

export interface CompLevel {
  code: string;
  label: string;
  aliases?: string[] | null;
}

/** Short badge for a completeness code — e.g. "CIB", "COB", or "Loose". */
export function compAbbrev(code: string | null | undefined, levels: CompLevel[]): string {
  if (!code) return "";
  const l = levels.find((x) => x.code === code);
  if (!l) return code;
  return l.code.length >= 2 && /^[A-Z0-9]+$/.test(l.code) ? l.code : l.label;
}

/** Full label for a completeness code. */
export function compLabelOf(code: string | null | undefined, levels: CompLevel[]): string {
  if (!code) return "";
  return levels.find((x) => x.code === code)?.label ?? code;
}

/**
 * Resolve free text someone typed ("cib", "complete", "open box") to a canonical
 * completeness code. Exact match on code/label/alias first, then a prefix match.
 * Returns "" if nothing matches.
 */
export function resolveComp(input: string, levels: CompLevel[]): string {
  const t = input.trim().toLowerCase();
  if (!t) return "";
  for (const l of levels) {
    if (l.code.toLowerCase() === t) return l.code;
    if (l.label.toLowerCase() === t) return l.code;
    if ((l.aliases ?? []).some((a) => a.toLowerCase() === t)) return l.code;
  }
  for (const l of levels) {
    if (l.label.toLowerCase().startsWith(t)) return l.code;
    if ((l.aliases ?? []).some((a) => a.toLowerCase().startsWith(t))) return l.code;
  }
  return "";
}
