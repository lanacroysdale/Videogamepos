// Split a long, keyword-stuffed eBay title into a clean main title + a smaller
// subtitle of trailing qualifiers (condition / region / model # / bundle spam).
//
// STRONG qualifiers split at any case (region free, tested, OEM, model #s…).
// WEAK words (new, mint, complete…) only split when UPPERCASE, so Title-Case
// game names like "New Leaf" or "New Super Mario Bros" stay in the main title.
const STRONG =
  /\b(region[ -]?free|ntsc(?:[- ]?[uj])?|\bpal\b|jpn|japan(?:ese)?|import(?:ed)?|tested|working|authentic|genuine|\boem\b|\bcib\b|sealed|refurbished|certified|open box|bundle|\blot\b|fast ship\w*|ships? from \w+|free ship\w*|must see|local pick ?up|w\/ ?tag|with \d|x[2-9]\b|\d+ ?(?:controllers?|games?|discs?|pack)|(?:dol|scph|hac|agb|ntr|sns|dmg|cgb|wup|ctr|usg|hdh)-?\d{2,4})\b/i;
const WEAK =
  /\b(NEW|MINT|SEALED|RARE|USED|LOOSE|COMPLETE|VINTAGE|EXCELLENT|VERY GOOD|GOOD CONDITION|BRAND NEW|NEAR MINT|LIKE NEW|HTF|OG|NIB|MIB|BNIB)\b/;

export function splitTitle(title: string): { main: string; sub: string | null } {
  const t = (title || "").trim();
  if (t.length < 45) return { main: t, sub: null };

  let best = -1;
  let m: RegExpExecArray | null;
  const reS = new RegExp(STRONG, "gi");
  while ((m = reS.exec(t))) { if (m.index >= 14) { best = m.index; break; } }
  const reW = new RegExp(WEAK, "g");
  while ((m = reW.exec(t))) { if (m.index >= 14) { if (best < 0 || m.index < best) best = m.index; break; } }
  if (best < 0) return { main: t, sub: null };

  // Never cut inside a bracket ("…Edition [Japan Import]" must not become
  // "…Edition [" + "Japan Import]"): back the cut up to the unclosed "[" / "(".
  const opens: number[] = [];
  for (let i = 0; i < best; i++) {
    if (t[i] === "[" || t[i] === "(") opens.push(i);
    else if ((t[i] === "]" || t[i] === ")") && opens.length) opens.pop();
  }
  if (opens.length) best = opens[0];

  const main = t.slice(0, best).replace(/[\s\-|+/·,:;[(]+$/, "").trim();
  let sub = t.slice(best).replace(/^[\s\-|+/·,:;\])]+/, "").trim();
  // A subtitle that is one whole bracket group reads better unwrapped; one
  // whose bracket never closes (a cut-off eBay title) loses the stray opener.
  const wrapped = sub.match(/^[[(]([^[\]()]*)[\])]$/);
  if (wrapped) sub = wrapped[1].trim();
  else if (/^[[(]/.test(sub) && !/[\])]/.test(sub)) sub = sub.slice(1).trim();
  if (main.length < 14 || sub.length < 3) return { main: t, sub: null };
  return { main, sub };
}
