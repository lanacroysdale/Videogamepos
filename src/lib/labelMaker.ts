// LABEL MAKER — free-text labels ("Includes IPS Screen Mod") on the store's
// small stickers or a 4×6 shipping label. Text auto-fits: the biggest size at
// which every line (wrapped at word boundaries) fits the label. Shared by the
// page preview, the browser print path and the Zebra raster path, so what you
// see is what prints. Images come later.
import { LABEL_FONTS } from "./labels";

export type TextSize = "fill" | "large" | "medium" | "small";
/** One styled stretch of text; a line is a list of runs. */
export type Run = { text: string; bold: boolean; italic: boolean; scale: number };
export type RichLine = Run[];
export type TextLabelSpec = {
  widthMm: number;
  heightMm: number;
  lines: RichLine[];          // the lines as typed, each a list of styled runs
  fontKey: string;            // LABEL_FONTS key (not "custom")
  align: "left" | "center";
  textSize: TextSize;         // "fill" = as big as fits; the others cap it
  border: boolean;
};
/** Width in px of `text` drawn with a CSS font string (canvas measureText). */
export type MeasureFn = (text: string, cssFont: string) => number;

export const LM_FONTS = LABEL_FONTS.filter((f) => f.key !== "custom");
/** Per-word sizes (× the label's text size). `font` = the editor's
 *  execCommand fontSize step that shows it (16px base: 13 / 16 / 24 / 32px). */
export const WORD_SIZES = [
  { key: "small", label: "Small", scale: 0.8125, font: "2" },
  { key: "normal", label: "Normal", scale: 1, font: "3" },
  { key: "large", label: "Large", scale: 1.5, font: "5" },
  { key: "huge", label: "Huge", scale: 2, font: "6" },
] as const;
const CAP: Record<TextSize, number> = { fill: Infinity, large: 0.34, medium: 0.22, small: 0.14 }; // × label height
const LINE = 1.16;   // line pitch, × the line's biggest text
const ASC = 0.8;     // baseline below the line top, × the line's biggest text

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));

type Style = { bold: boolean; italic: boolean; scale: number };
export function fontOf(fontKey: string) {
  const f = LM_FONTS.find((x) => x.key === fontKey) ?? LM_FONTS[0];
  const weight = (st: Style) => (f.noBold ? 400 : st.bold ? 800 : 500);
  const css = (st: Style, px: number) => `${st.italic ? "italic " : ""}${weight(st)} ${px}px ${f.family}`;
  return { f, family: f.family.replace(/"/g, "'"), weight, css };
}

// ---- rich text helpers --------------------------------------------------------
/** Plain text (one line per typed line) → runs. */
export function linesFromText(text: string, bold = false): RichLine[] {
  return String(text ?? "").replace(/\r/g, "").split("\n").map((l) => (l ? [{ text: l, bold, italic: false, scale: 1 }] : []));
}
export const plainText = (lines: RichLine[]) => lines.map((l) => l.map((r) => r.text).join("")).join("\n");
/** Trust boundary for stored / pasted runs: sizes, counts, lengths. */
export function sanitizeLines(raw: any): RichLine[] {
  if (!Array.isArray(raw)) return [];
  let budget = 600;
  const out: RichLine[] = [];
  for (const line of raw.slice(0, 20)) {
    const runs: Run[] = [];
    for (const r of Array.isArray(line) ? line.slice(0, 60) : []) {
      const text = String(r?.text ?? "").replace(/[\r\n\t]/g, " ").slice(0, Math.max(0, budget));
      if (!text) continue;
      budget -= text.length;
      const scale = Math.round(Math.min(3, Math.max(0.5, Number(r?.scale) || 1)) * 100) / 100;
      const prev = runs[runs.length - 1];
      const st = { bold: r?.bold === true, italic: r?.italic === true, scale };
      // Neighbours with the same style become one run.
      if (prev && prev.bold === st.bold && prev.italic === st.italic && prev.scale === st.scale) prev.text += text;
      else runs.push({ text, ...st });
    }
    out.push(runs);
  }
  while (out.length && !out[out.length - 1].length) out.pop(); // trailing blank lines
  return out;
}

// A word = consecutive styled pieces with no space between ("Super" +
// bold "Mario" stay together); spaces between words take the left word's style.
type Piece = { text: string; st: Style };
type Word = { pieces: Piece[]; space: Style | null };
function wordsOf(line: RichLine): Word[] {
  const words: Word[] = [];
  let cur: Word | null = null;
  for (const r of line) {
    const st: Style = { bold: r.bold, italic: r.italic, scale: r.scale };
    for (const seg of r.text.split(/(\s+)/)) {
      if (!seg) continue;
      if (/^\s+$/.test(seg)) { if (cur) { cur.space = st; cur = null; } continue; }
      if (cur) cur.pieces.push({ text: seg, st });
      else { cur = { pieces: [{ text: seg, st }], space: null }; words.push(cur); }
    }
  }
  return words;
}

export type TextLayout = { lines: Word[][]; sizeMm: number; pad: number; borderW: number; fits: boolean };

/** Lay the text out: largest size (mm) at which it fits, and its lines. */
export function layoutTextLabel(spec: TextLabelSpec, measure?: MeasureFn): TextLayout {
  const W = spec.widthMm, H = spec.heightMm;
  const { f, css } = fontOf(spec.fontKey);
  const short = Math.min(W, H);
  const borderW = spec.border ? Math.max(0.4, short * 0.012) : 0;
  const pad = spec.border ? 1.2 + borderW + Math.max(1.2, short * 0.04) : Math.max(1.5, short * 0.06);
  const innerW = W - pad * 2, innerH = H - pad * 2;
  // Width of a piece at text size s (mm): measured once at 100px, scaled.
  const cache = new Map<string, number>();
  const at100 = (t: string, st: Style) => {
    const k = `${st.bold ? 1 : 0}${st.italic ? 1 : 0}|${t}`;
    let w = cache.get(k);
    if (w === undefined) {
      w = measure ? measure(t, css(st, 100)) : t.length * (f.charW ?? 0.55) * 100 * (st.bold ? 1.06 : 1);
      cache.set(k, w);
    }
    return w;
  };
  const pieceW = (t: string, st: Style, s: number) => { const z = s * st.scale; return (at100(t, st) * z) / 100 + (f.spacing ? f.spacing * z * t.length : 0); };
  const wordW = (w: Word, s: number) => w.pieces.reduce((a, p) => a + pieceW(p.text, p.st, s), 0);
  const lineW = (ws: Word[], s: number) => ws.reduce((a, w, i) => a + wordW(w, s) + (i < ws.length - 1 && w.space ? pieceW(" ", w.space, s) : 0), 0);
  const lineScale = (ws: Word[]) => Math.max(1e-6, ...ws.flatMap((w) => w.pieces.map((p) => p.st.scale))) || 1;
  const scaleOf = (ws: Word[]) => (ws.length ? lineScale(ws) : 1);
  const typed = spec.lines.map(wordsOf);
  // Greedy word wrap at size s; a word wider than the label breaks by letters.
  // keepLines = the lines exactly as typed (no wrapping).
  const wrap = (s: number, keepLines: boolean): Word[][] => {
    if (keepLines) return typed.map((ws) => [...ws]);
    const out: Word[][] = [];
    for (const ws of typed) {
      if (!ws.length) { out.push([]); continue; }
      let line: Word[] = [];
      for (const w of ws) {
        if (lineW([...line, w], s) <= innerW) { line.push(w); continue; }
        if (line.length) out.push(line);
        if (wordW(w, s) <= innerW) { line = [w]; continue; }
        // Too wide even alone: split it letter by letter (styles kept).
        let chunk: Word = { pieces: [], space: null };
        for (const p of w.pieces) for (const ch of p.text) {
          const next: Word = { pieces: [...chunk.pieces, { text: ch, st: p.st }], space: null };
          if (wordW(next, s) <= innerW || !chunk.pieces.length) chunk = next;
          else { out.push([chunk]); chunk = { pieces: [{ text: ch, st: p.st }], space: null }; }
        }
        chunk.space = w.space;
        line = [chunk];
      }
      out.push(line);
    }
    return out;
  };
  const blockH = (ls: Word[][], s: number) => ls.reduce((a, l, i) => a + s * scaleOf(l) * (i === 0 ? 1 : LINE), 0);
  const fitsAt = (s: number, keepLines: boolean) => {
    const ls = wrap(s, keepLines);
    return blockH(ls, s) <= innerH && ls.every((l) => lineW(l, s) <= innerW + 1e-6) ? ls : null;
  };
  const maxS = Math.max(1.2, Math.min(innerH, spec.textSize === "fill" ? Infinity : H * CAP[spec.textSize], 80));
  // Largest size that fits (binary search).
  const solve = (keepLines: boolean) => {
    let lo = 1.2, hi = maxS, best: Word[][] | null = fitsAt(lo, keepLines);
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
  const asTyped = typed.length > 1 ? solve(true) : null;
  const pick = asTyped && (!wrapped || asTyped.size >= Math.max(2.4, wrapped.size * 0.4)) ? asTyped : wrapped;
  return { lines: pick?.lines ?? wrap(1.2, false), sizeMm: pick?.size ?? 1.2, pad, borderW, fits: !!pick };
}

/** The label as SVG (mm units), same conventions as renderLabelSvg. */
export function renderTextLabelSvg(spec: TextLabelSpec, measure?: MeasureFn): string {
  const W = spec.widthMm, H = spec.heightMm;
  const { f, family, weight } = fontOf(spec.fontKey);
  const L = layoutTextLabel(spec, measure);
  const s = L.sizeMm;
  const parts: string[] = [`<rect x="0" y="0" width="${W}" height="${H}" fill="#fff"/>`];
  if (spec.border) {
    const o = 1.2 + L.borderW / 2;
    parts.push(`<rect x="${o.toFixed(2)}" y="${o.toFixed(2)}" width="${(W - o * 2).toFixed(2)}" height="${(H - o * 2).toFixed(2)}" fill="none" stroke="#000" stroke-width="${L.borderW.toFixed(2)}"/>`);
  }
  const scaleOf = (ws: Word[]) => (ws.length ? Math.max(...ws.flatMap((w) => w.pieces.map((p) => p.st.scale))) : 1);
  const blockH = L.lines.reduce((a, l, i) => a + s * scaleOf(l) * (i === 0 ? 1 : LINE), 0);
  const x = spec.align === "center" ? W / 2 : L.pad;
  const anchor = spec.align === "center" ? "middle" : "start";
  const tspan = (t: string, st: Style) => {
    const z = s * st.scale;
    const ls = f.spacing ? ` letter-spacing="${(f.spacing * z).toFixed(2)}"` : "";
    return `<tspan font-weight="${weight(st)}"${st.italic ? ' font-style="italic"' : ""} font-size="${z.toFixed(2)}"${ls}>${esc(t)}</tspan>`;
  };
  let y = L.pad + (H - L.pad * 2 - blockH) / 2;
  L.lines.forEach((ws, i) => {
    const m = scaleOf(ws);
    y += i === 0 ? s * m * ASC : s * m * LINE;
    if (!ws.length) return;
    const spans = ws.map((w, j) => w.pieces.map((p) => tspan(p.text, p.st)).join("") + (j < ws.length - 1 && w.space ? tspan(" ", w.space) : "")).join("");
    parts.push(`<text x="${x.toFixed(2)}" y="${y.toFixed(2)}" text-anchor="${anchor}" font-family="${family}" fill="#000" xml:space="preserve">${spans}</text>`);
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
  id: string; name: string;
  text: string;          // plain text (button tooltip, duplicate check)
  lines: RichLine[];     // the formatted text
  sizeKey: string; landscape: boolean; customW?: number; customH?: number;
  fontKey: string; align: "left" | "center"; textSize: TextSize; border: boolean;
};
export function sanitizeSaved(raw: any): SavedLabel[] {
  const arr = Array.isArray(raw) ? raw.slice(0, 60) : [];
  const out: SavedLabel[] = [];
  for (const r of arr) {
    // Labels saved before formatting existed: plain text + an all-bold flag.
    const lines = Array.isArray(r?.lines) ? sanitizeLines(r.lines) : sanitizeLines(linesFromText(String(r?.text ?? "").slice(0, 400), r?.bold !== false));
    const text = plainText(lines);
    if (!text.trim()) continue;
    const num = (v: any) => (Number.isFinite(Number(v)) ? Math.min(300, Math.max(10, Number(v))) : undefined);
    out.push({
      id: String(r.id ?? "").replace(/[^a-z0-9-]/gi, "").slice(0, 40) || Math.random().toString(36).slice(2, 10),
      name: String(r.name ?? "").trim().slice(0, 40) || text.split("\n")[0].trim().slice(0, 40),
      text, lines,
      sizeKey: String(r.sizeKey ?? "").slice(0, 80),
      landscape: r.landscape === true,
      customW: num(r.customW), customH: num(r.customH),
      fontKey: LM_FONTS.some((f) => f.key === r.fontKey) ? r.fontKey : LM_FONTS[0].key,
      align: r.align === "left" ? "left" : "center",
      textSize: (["fill", "large", "medium", "small"] as const).includes(r.textSize) ? r.textSize : "fill",
      border: r.border === true,
    });
  }
  return out;
}
