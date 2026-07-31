// Code 128 (subset B) barcode encoder — zero dependencies, SVG out. Encodes the
// printable ASCII range (32–126), which covers the POS internal label codes
// ("TL" + 10 hex) and any UPC-style digits. Used by the price-label renderer;
// pure functions so the math is unit-testable.
//
// Structure: [Start B (104)] [char values…] [checksum] [Stop (106)]. Each symbol
// is 11 modules drawn as 6 alternating bar/space widths; Stop is 13 modules / 7
// widths. Checksum = (104 + Σ valueᵢ·i) mod 103 with 1-based positions.

// Standard Code 128 width patterns, values 0–106 (index = symbol value).
const PATTERNS = [
  "212222","222122","222221","121223","121322","131222","122213","122312","132212","221213",
  "221312","231212","112232","122132","122231","113222","123122","123221","223211","221132",
  "221231","213212","223112","312131","311222","321122","321221","312212","322112","322211",
  "212123","212321","232121","111323","131123","131321","112313","132113","132311","211313",
  "231113","231311","112133","112331","132131","113123","113321","133121","313121","211331",
  "231131","213113","213311","213131","311123","311321","331121","312113","312311","332111",
  "314111","221411","431111","111224","111422","121124","121421","141122","141221","112214",
  "112412","122114","122411","142112","142211","241211","221114","413111","241112","134111",
  "111242","121142","121241","114212","124112","124211","411212","421112","421211","212141",
  "214121","412121","111143","111341","131141","114113","114311","411113","411311","113141",
  "114131","311141","411131","211412","211214","211232",
  "2331112", // 106 = Stop (13 modules)
];

// Integrity check at module load: every symbol must be exactly 11 modules
// (Stop = 13). A single mistyped digit would print unscannable bars silently —
// this makes it throw loudly instead.
for (let i = 0; i < PATTERNS.length; i++) {
  const sum = PATTERNS[i].split("").reduce((s, d) => s + Number(d), 0);
  const want = i === 106 ? 13 : 11;
  if (sum !== want) throw new Error(`Code128 pattern table corrupt at value ${i} (${PATTERNS[i]} sums to ${sum}, want ${want})`);
}

const START_B = 104;
const STOP = 106;
export const QUIET_MODULES = 10; // quiet zone on each side (spec minimum)

// Bar/space module widths for the full symbol run (quiet zones NOT included).
// Odd positions in the flat array are bars, even are spaces (starting with a bar).
export function code128Widths(text: string): number[] {
  if (!text) throw new Error("Empty barcode text");
  const values: number[] = [];
  for (const ch of text) {
    const code = ch.charCodeAt(0);
    if (code < 32 || code > 126) throw new Error(`Code128B can't encode character "${ch}"`);
    values.push(code - 32);
  }
  let checksum = START_B;
  values.forEach((v, i) => { checksum += v * (i + 1); });
  checksum %= 103;
  const symbols = [START_B, ...values, checksum, STOP];
  const widths: number[] = [];
  for (const s of symbols) for (const d of PATTERNS[s]) widths.push(Number(d));
  return widths;
}

// Total modules incl. both quiet zones — for fitting math in the label renderer.
export function code128Modules(text: string): number {
  return code128Widths(text).reduce((s, w) => s + w, 0) + QUIET_MODULES * 2;
}

export interface Code128Options {
  moduleMm: number;      // width of one module in mm (clamp ≥0.25 for 203dpi thermal)
  heightMm: number;      // bar height
  showText?: boolean;    // human-readable text under the bars
  textMm?: number;       // text size (default 2.4mm)
}

// Render as an SVG fragment (<g>) positioned at x,y (mm coordinates). Returns
// { svg, widthMm } so the caller can center it. Text is drawn monospace.
export function code128SvgGroup(text: string, x: number, y: number, opts: Code128Options): { svg: string; widthMm: number } {
  const widths = code128Widths(text);
  const m = Math.max(0.25, opts.moduleMm);
  const totalModules = widths.reduce((s, w) => s + w, 0) + QUIET_MODULES * 2;
  const widthMm = totalModules * m;
  let cursor = x + QUIET_MODULES * m;
  const rects: string[] = [];
  widths.forEach((w, i) => {
    if (i % 2 === 0) rects.push(`<rect x="${cursor.toFixed(3)}" y="${y}" width="${(w * m).toFixed(3)}" height="${opts.heightMm}" fill="#000"/>`);
    cursor += w * m;
  });
  const textMm = opts.textMm ?? 2.4;
  const label = opts.showText
    ? `<text x="${(x + widthMm / 2).toFixed(3)}" y="${(y + opts.heightMm + textMm).toFixed(3)}" font-family="ui-monospace,Menlo,monospace" font-size="${textMm}" text-anchor="middle" fill="#000">${text.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c] as string))}</text>`
    : "";
  return { svg: `<g>${rects.join("")}${label}</g>`, widthMm };
}
