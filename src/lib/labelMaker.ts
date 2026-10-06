// LABEL MAKER — free-text labels ("Includes IPS Screen Mod") on the store's
// small stickers or a 4×6 shipping label. Text auto-fits: the biggest size at
// which every line (wrapped at word boundaries) fits the label. Shared by the
// page preview, the browser print path and the Zebra raster path, so what you
// see is what prints. Images come later.
import { LABEL_FONTS } from "./labels";

export type TextSize = "fill" | "large" | "medium" | "small";
export type TextLabelSpec = {
  widthMm: number;
  heightMm: number;
  text: string;
  fontKey: string;            // LABEL_FONTS key (not "custom")
  bold: boolean;
  align: "left" | "center";
  textSize: TextSize;         // "fill" = as big as fits; the others cap it
  border: boolean;
};
/** Width in px of `text` drawn with a CSS font string (canvas measureText). */
export type MeasureFn = (text: string, cssFont: string) => number;

export const LM_FONTS = LABEL_FONTS.filter((f) => f.key !== "custom");
const CAP: Record<TextSize, number> = { fill: Infinity, large: 0.34, medium: 0.22, small: 0.14 }; // × label height
const LINE = 1.16;   // line pitch, × text size
const ASC = 0.8;     // first baseline below the block top, × text size

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));

export function fontOf(spec: Pick<TextLabelSpec, "fontKey" | "bold">) {
  const f = LM_FONTS.find((x) => x.key === spec.fontKey) ?? LM_FONTS[0];
  const weight = f.noBold ? 400 : spec.bold ? 800 : 500;
  return { f, family: f.family.replace(/"/g, "'"), weight, css: (px: number) => `${weight} ${px}px ${f.family}` };
}

export type TextLayout = { lines: string[]; sizeMm: number; pad: number; borderW: number; fits: boolean };

/** Lay the text out: largest size (mm) at which it fits, and its lines. */
export function layoutTextLabel(spec: TextLabelSpec, measure?: MeasureFn): TextLayout {
  const W = spec.widthMm, H = spec.heightMm;
  const { f, css } = fontOf(spec);
  const short = Math.min(W, H);
  const borderW = spec.border ? Math.max(0.4, short * 0.012) : 0;
  const pad = spec.border ? 1.2 + borderW + Math.max(1.2, short * 0.04) : Math.max(1.5, short * 0.06);
  const innerW = W - pad * 2, innerH = H - pad * 2;
  // Width of a string at text size s (mm): measured once at 100px, scaled.
  const cache = new Map<string, number>();
  const at100 = (t: string) => {
    let w = cache.get(t);
    if (w === undefined) {
      w = measure ? measure(t, css(100)) : t.length * (f.charW ?? 0.55) * 100 * (spec.bold ? 1.06 : 1);
      cache.set(t, w);
    }
    return w;
  };
  const widthMm = (t: string, s: number) => (at100(t) * s) / 100 + (f.spacing ? f.spacing * s * Math.max(0, t.length - 1) : 0);
  const paras = spec.text.replace(/\r/g, "").split("\n").map((p) => p.replace(/\s+/g, " ").trim());
  // Greedy word wrap at size s; a word wider than the label breaks by letters.
  // keepLines = the lines exactly as typed (no wrapping).
  const wrap = (s: number, keepLines = false): string[] => {
    if (keepLines) return [...paras];
    const out: string[] = [];
    for (const para of paras) {
      if (!para) { out.push(""); continue; }
      let line = "";
      for (const word of para.split(" ")) {
        const tryLine = line ? `${line} ${word}` : word;
        if (widthMm(tryLine, s) <= innerW) { line = tryLine; continue; }
        if (line) out.push(line);
        if (widthMm(word, s) <= innerW) { line = word; continue; }
        let chunk = "";
        for (const ch of word) {
          if (widthMm(chunk + ch, s) <= innerW || !chunk) chunk += ch;
          else { out.push(chunk); chunk = ch; }
        }
        line = chunk;
      }
      out.push(line);
    }
    return out;
  };
  const fitsAt = (s: number, keepLines: boolean) => {
    const lines = wrap(s, keepLines);
    const h = s + (lines.length - 1) * s * LINE;
    return h <= innerH && lines.every((l) => widthMm(l, s) <= innerW + 1e-6) ? lines : null;
  };
  const maxS = Math.max(1.2, Math.min(innerH, spec.textSize === "fill" ? Infinity : H * CAP[spec.textSize], 80));
  // Largest size that fits (binary search).
  const solve = (keepLines: boolean) => {
    let lo = 1.2, hi = maxS, best: string[] | null = fitsAt(lo, keepLines);
    const top = fitsAt(hi, keepLines);
    if (top) return { size: hi, lines: top };
    for (let i = 0; i < 28 && hi - lo > 0.05; i++) {
      const mid = (lo + hi) / 2;
      const ls = fitsAt(mid, keepLines);
      if (ls) { lo = mid; best = ls; } else hi = mid;
    }
    return best ? { size: lo, lines: best } : null;
  };
  // Lines you broke yourself stay as typed ("Includes / IPS SCREEN MOD") —
  // unless that leaves the text tiny, then it wraps like one long sentence.
  const wrapped = solve(false);
  const typed = paras.length > 1 ? solve(true) : null;
  const pick = typed && (!wrapped || typed.size >= Math.max(2.4, wrapped.size * 0.4)) ? typed : wrapped;
  return { lines: pick?.lines ?? wrap(1.2), sizeMm: pick?.size ?? 1.2, pad, borderW, fits: !!pick };
}

/** The label as SVG (mm units), same conventions as renderLabelSvg. */
export function renderTextLabelSvg(spec: TextLabelSpec, measure?: MeasureFn): string {
  const W = spec.widthMm, H = spec.heightMm;
  const { f, family, weight } = fontOf(spec);
  const L = layoutTextLabel(spec, measure);
  const s = L.sizeMm;
  const parts: string[] = [`<rect x="0" y="0" width="${W}" height="${H}" fill="#fff"/>`];
  if (spec.border) {
    const o = 1.2 + L.borderW / 2;
    parts.push(`<rect x="${o.toFixed(2)}" y="${o.toFixed(2)}" width="${(W - o * 2).toFixed(2)}" height="${(H - o * 2).toFixed(2)}" fill="none" stroke="#000" stroke-width="${L.borderW.toFixed(2)}"/>`);
  }
  const n = L.lines.length;
  const blockH = s + (n - 1) * s * LINE;
  const top = L.pad + (H - L.pad * 2 - blockH) / 2;
  const x = spec.align === "center" ? W / 2 : L.pad;
  const anchor = spec.align === "center" ? "middle" : "start";
  const ls = f.spacing ? ` letter-spacing="${(f.spacing * s).toFixed(2)}"` : "";
  L.lines.forEach((line, i) => {
    if (!line) return;
    const y = top + s * ASC + i * s * LINE;
    parts.push(`<text x="${x.toFixed(2)}" y="${y.toFixed(2)}" text-anchor="${anchor}" font-family="${family}" font-weight="${weight}"${ls} font-size="${s.toFixed(2)}" fill="#000" xml:space="preserve">${esc(line)}</text>`);
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}mm" height="${H}mm" viewBox="0 0 ${W} ${H}">${parts.join("")}</svg>`;
}

// ---- Sizes --------------------------------------------------------------------
export const SIZE_4X6 = { widthMm: 101.6, heightMm: 152.4 };
// Label stock is sold in inches: "57mm" is 2¼″ (the same ⅛-inch snap the print path uses).
export const inches = (mm: number) => {
  const q = Math.round(mm / 3.175) * 3.175;
  return ((q > 0 && Math.abs(q - mm) <= 0.6 ? q : mm) / 25.4).toFixed(2).replace(/\.?0+$/, "");
};

/** Saved labels (store_settings.settings.labelMakerSaved). */
export type SavedLabel = {
  id: string; name: string; text: string;
  sizeKey: string; landscape: boolean; customW?: number; customH?: number;
  fontKey: string; bold: boolean; align: "left" | "center"; textSize: TextSize; border: boolean;
};
export function sanitizeSaved(raw: any): SavedLabel[] {
  const arr = Array.isArray(raw) ? raw.slice(0, 60) : [];
  const out: SavedLabel[] = [];
  for (const r of arr) {
    const text = String(r?.text ?? "").slice(0, 400);
    if (!text.trim()) continue;
    const num = (v: any) => (Number.isFinite(Number(v)) ? Math.min(300, Math.max(10, Number(v))) : undefined);
    out.push({
      id: String(r.id ?? "").replace(/[^a-z0-9-]/gi, "").slice(0, 40) || Math.random().toString(36).slice(2, 10),
      name: String(r.name ?? "").trim().slice(0, 40) || text.split("\n")[0].trim().slice(0, 40),
      text,
      sizeKey: String(r.sizeKey ?? "").slice(0, 80),
      landscape: r.landscape === true,
      customW: num(r.customW), customH: num(r.customH),
      fontKey: LM_FONTS.some((f) => f.key === r.fontKey) ? r.fontKey : LM_FONTS[0].key,
      bold: r.bold !== false,
      align: r.align === "left" ? "left" : "center",
      textSize: (["fill", "large", "medium", "small"] as const).includes(r.textSize) ? r.textSize : "fill",
      border: r.border === true,
    });
  }
  return out;
}
