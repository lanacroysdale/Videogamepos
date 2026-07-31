// Price-label templates + SVG renderer, shared by the Settings designer preview
// and every print surface (inventory, entries, pricing). Templates are
// STRUCTURED config stored in store_settings.settings.labelTemplates — never
// freeform markup; the sanitizer here is the trust boundary. All sizes in mm.
// Modeled on the wrap tag: a vertical price spine + a face with title/meta/
// price/barcode. Integer cents throughout.
import { code128SvgGroup, code128Modules } from "./barcode";

// Label font choices with per-font OPTICAL PROFILES — each face renders at a
// different visual size for the same nominal mm, so the renderer corrects:
//   scale  — size multiplier (pixel fonts have huge em boxes → shrink; narrow
//            condensed faces read small → grow)
//   charW  — average character width in em, drives the title auto-fit
//   spacing— extra letter-spacing in em
//   noBold — face has one weight; synthetic bold looks smeared → use 400/500
//   titleItalic — slant the title line (the League Gothic tag look)
//   titleTop — first-baseline advance factor (<1 lifts the title higher)
//   titleGap — mm of clear air between title descenders and the meta line
//   metaScale — shrink the meta line (condensed display type pairs small caps)
//   priceBoost / priceStrong / priceItalic — face-price size ×, SVG-stroke
//     faux bold (deterministic, unlike browser synthetic bold), italic slant
//   spineShift — mm the spine price+tagline pair slides toward the logo
// Google-hosted faces load on demand (ensureLabelFont) and are awaited before
// printing so a tag never prints in a fallback font. Futura is the macOS
// system face (labels print from the shop Macs); elsewhere it falls back.
export type LabelFontDef = {
  key: string; label: string; family: string; css?: string;
  scale?: number; charW?: number; spacing?: number; noBold?: boolean; titleItalic?: boolean;
  titleTop?: number; titleGap?: number; metaScale?: number;
  priceBoost?: number; priceStrong?: boolean; priceItalic?: boolean; spineShift?: number;
};
export const LABEL_FONTS: LabelFontDef[] = [
  { key: "system", label: "Clean (Arial)", family: "Arial,Helvetica,sans-serif" },
  { key: "futura", label: "Futura (system)", family: "Futura,'Century Gothic','Trebuchet MS',Arial,sans-serif", charW: 0.56, titleTop: 0.86, spineShift: 2.5 },
  { key: "roboto", label: "Roboto", family: "'Roboto',Arial,sans-serif", css: "https://fonts.googleapis.com/css2?family=Roboto:wght@400;500;700&display=swap" },
  { key: "league", label: "League Gothic", family: "'League Gothic',Arial,sans-serif", css: "https://fonts.googleapis.com/css2?family=League+Gothic:ital@0;1&display=swap", scale: 1.3, charW: 0.4, spacing: 0.05, noBold: true, titleItalic: true, titleTop: 0.78, titleGap: 1.4, metaScale: 0.85, priceBoost: 1.35 },
  { key: "condensed", label: "Condensed (Oswald)", family: "'Oswald',Arial,sans-serif", css: "https://fonts.googleapis.com/css2?family=Oswald:wght@400;700&display=swap", scale: 1.1, charW: 0.46 },
  { key: "pixel", label: "Pixel (Press Start 2P)", family: "'Press Start 2P',monospace", css: "https://fonts.googleapis.com/css2?family=Press+Start+2P&display=swap", scale: 0.58, charW: 1.05, noBold: true },
  { key: "mono", label: "Mono", family: "ui-monospace,Menlo,monospace", charW: 0.62 },
  { key: "custom", label: "Custom (uploaded)", family: "'TLLabelCustom',Arial,sans-serif" },
];

// Inject + await the template's font (browser only; 2s cap so a slow font can
// never block printing — worst case the tag prints in the fallback).
export async function ensureLabelFont(tpl: LabelTemplate): Promise<void> {
  if (typeof document === "undefined") return;
  try {
    if (tpl.fontKey === "custom" && tpl.fontUrl) {
      if (!document.getElementById("lt-font-custom")) {
        const st = document.createElement("style");
        st.id = "lt-font-custom";
        st.textContent = `@font-face{font-family:'TLLabelCustom';src:url('${tpl.fontUrl.replace(/'/g, "%27")}');font-display:swap}`;
        document.head.appendChild(st);
      }
      await Promise.race([(document as any).fonts.load("16px 'TLLabelCustom'"), new Promise((r) => setTimeout(r, 2000))]);
      return;
    }
    const f = LABEL_FONTS.find((x) => x.key === tpl.fontKey);
    if (!f?.css) return;
    const id = "lt-font-" + f.key;
    if (!document.getElementById(id)) {
      const link = document.createElement("link");
      link.id = id; link.rel = "stylesheet"; link.href = f.css;
      document.head.appendChild(link);
    }
    const fam = f.family.split(",")[0].replace(/'/g, "");
    // Load italic too — harmless no-op for faces without one.
    await Promise.race([
      Promise.all([(document as any).fonts.load(`16px '${fam}'`), (document as any).fonts.load(`italic 16px '${fam}'`)]),
      new Promise((r) => setTimeout(r, 2000)),
    ]);
  } catch { /* fallback font is acceptable */ }
}

export type LabelTemplate = {
  id: string;
  name: string;
  widthMm: number;                       // 20–110 (2.25in ≈ 57)
  heightMm: number;                      // 10–80  (1.25in ≈ 32)
  spine: "left" | "right" | "none";      // vertical price-flag column
  spineWidthMm: number;                  // 8–25 (ignored when spine === "none")
  show: {
    logo: boolean; title: boolean; category: boolean; condition: boolean;
    price: boolean; invType: boolean; location: boolean; sku: boolean; barcode: boolean;
    spineText: boolean;
  };
  spineText: string;                     // tagline under the spine price, e.g. "Buy | Sell | Chill"
  barcodeHeightMm: number;               // 5–20
  barcodeShowText: boolean;              // human-readable code under the bars
  titleMaxLines: 1 | 2;
  fontScale: number;                     // 0.7–1.5
  priceScale: number;                    // 0.8–2 — sizes the price (face + spine)
  fontKey: string;                       // LABEL_FONTS key ('system' | 'league' | 'pixel' | …)
  fontUrl: string;                       // uploaded custom font (fontKey 'custom')
  logoUrl: string;                       // uploaded logo image ("" = store name text)
  logoHeightMm: number;                  // 3–15 — logo size on the spine
  logoRotate: "upright" | "sideways";    // sideways = rotated with the spine price
  titleMaxChars: number;                 // 10–60 — hard cut-off (… beyond this)
  isDefault?: boolean;
};

// What one label prints for one variant (built by the caller from live rows).
export type LabelItem = {
  title: string;
  categoryName: string;   // e.g. "Super Nintendo" (platform preferred)
  condShort: string;      // e.g. "CIB · ★★★" (conditionDisplay compAbbrev style)
  priceCents: number;
  invTypeName: string;    // e.g. "Personal Collection" ("" hides)
  locationKey: string;    // e.g. "PDX"
  internalCode: string;   // fallback barcode payload (TL…, wide)
  labelCode?: string;     // preferred payload: 10-digit numeric → compact Code 128C
  sku: string;
  storeName: string;      // spine logo text (used when no logoUrl)
};

export const DEFAULT_TEMPLATE: LabelTemplate = {
  id: "wrap-57x32",
  name: "Wrap tag 2.25 × 1.25″",
  widthMm: 57,
  heightMm: 32,
  spine: "left", // front-to-spine: face on the case FRONT, flap wraps the spine
  spineWidthMm: 13,
  show: { logo: true, title: true, category: true, condition: true, price: true, invType: true, location: true, sku: false, barcode: true, spineText: true },
  spineText: "",
  barcodeHeightMm: 8,
  barcodeShowText: true,
  titleMaxLines: 1,
  fontScale: 1,
  priceScale: 1.25,
  fontKey: "system",
  fontUrl: "",
  logoUrl: "",
  logoHeightMm: 8,
  logoRotate: "upright",
  titleMaxChars: 28,
  isDefault: true,
};

const clamp = (n: any, lo: number, hi: number, def: number) => {
  const x = Number(n);
  return Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : def;
};
const slug = (s: any, fallback: string) =>
  (String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40)) || fallback;

// The trust boundary for the settings jsonb: clamp every number, whitelist
// enums, coerce booleans, dedupe ids, enforce exactly one default, cap count.
export function sanitizeLabelTemplates(raw: any): LabelTemplate[] {
  const arr = Array.isArray(raw) ? raw.slice(0, 12) : [];
  const seen = new Set<string>();
  const out: LabelTemplate[] = [];
  for (let i = 0; i < arr.length; i++) {
    const t = arr[i] ?? {};
    let id = slug(t.id || t.name, `template-${i + 1}`);
    while (seen.has(id)) id += "-2";
    seen.add(id);
    const d = DEFAULT_TEMPLATE;
    out.push({
      id,
      name: String(t.name ?? "").trim().slice(0, 60) || `Template ${i + 1}`,
      widthMm: clamp(t.widthMm, 20, 110, d.widthMm),
      heightMm: clamp(t.heightMm, 10, 80, d.heightMm),
      spine: ["left", "right", "none"].includes(t.spine) ? t.spine : d.spine,
      spineWidthMm: clamp(t.spineWidthMm, 8, 25, d.spineWidthMm),
      show: {
        logo: t.show?.logo !== false, title: t.show?.title !== false, category: t.show?.category !== false,
        condition: t.show?.condition !== false, price: t.show?.price !== false, invType: t.show?.invType !== false,
        location: t.show?.location !== false, sku: t.show?.sku === true, barcode: t.show?.barcode !== false,
        spineText: t.show?.spineText !== false,
      },
      spineText: String(t.spineText ?? "").slice(0, 30),
      barcodeHeightMm: clamp(t.barcodeHeightMm, 5, 20, d.barcodeHeightMm),
      barcodeShowText: t.barcodeShowText !== false,
      titleMaxLines: t.titleMaxLines === 2 ? 2 : 1,
      fontScale: clamp(t.fontScale, 0.7, 1.5, 1),
      priceScale: clamp(t.priceScale, 0.8, 2, d.priceScale),
      fontKey: LABEL_FONTS.some((f) => f.key === t.fontKey) ? t.fontKey : "system",
      fontUrl: typeof t.fontUrl === "string" && /^https?:\/\/.+\.(woff2?|ttf|otf)(\?.*)?$/i.test(t.fontUrl) ? t.fontUrl.slice(0, 500) : "",
      logoUrl: typeof t.logoUrl === "string" && /^https?:\/\//.test(t.logoUrl) ? t.logoUrl.slice(0, 500) : "",
      logoHeightMm: clamp(t.logoHeightMm, 3, 15, d.logoHeightMm),
      logoRotate: t.logoRotate === "sideways" ? "sideways" : "upright",
      titleMaxChars: clamp(t.titleMaxChars, 10, 60, d.titleMaxChars),
      isDefault: t.isDefault === true,
    });
    // Cross-clamps: independent ranges can still combine into impossible
    // geometry (spine wider than the label; bars taller than the label).
    const cur = out[out.length - 1];
    if (cur.fontKey === "custom" && !cur.fontUrl) cur.fontKey = "system";
    cur.spineWidthMm = Math.min(cur.spineWidthMm, Math.max(8, cur.widthMm - 15));
    cur.barcodeHeightMm = Math.min(cur.barcodeHeightMm, Math.max(5, cur.heightMm - 8));
  }
  if (!out.length) out.push({ ...DEFAULT_TEMPLATE });
  // Exactly one default.
  const defIdx = Math.max(0, out.findIndex((t) => t.isDefault));
  out.forEach((t, i) => (t.isDefault = i === defIdx));
  return out;
}

// Reader for store_settings.settings.labelTemplates (settings-helper idiom).
export function labelTemplates(rawSettings: any): LabelTemplate[] {
  return sanitizeLabelTemplates(rawSettings?.labelTemplates);
}

const esc = (s: any) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
// Whole-dollar prices print clean ("$260"); odd cents keep them ("$12.99").
const money = (c: number) => {
  const d = (c || 0) / 100;
  return Number.isInteger(d) ? "$" + d : "$" + d.toFixed(2);
};

// Smallest printable module width (2 dots at 203dpi thermal ≈ 0.25mm). The
// designer warns when a code doesn't fit the face at this floor.
export const MIN_MODULE_MM = 0.25;
export function barcodeFits(text: string, availWidthMm: number): boolean {
  try { return code128Modules(text) * MIN_MODULE_MM <= availWidthMm; } catch { return false; }
}

// Crude character-budget title wrap (SVG has no native wrapping).
function wrapTitle(title: string, maxChars: number, maxLines: 1 | 2): string[] {
  const words = title.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    if ((cur + " " + w).trim().length <= maxChars) cur = (cur + " " + w).trim();
    else {
      if (lines.length + 1 >= maxLines) { cur = cur ? cur : w; break; }
      lines.push(cur || w.slice(0, maxChars));
      cur = cur ? w : w.slice(maxChars);
    }
  }
  if (cur) lines.push(cur);
  const out = lines.slice(0, maxLines);
  const flat = out.join(" ");
  if (flat.length < title.replace(/\s+/g, " ").trim().length && out.length) {
    const last = out[out.length - 1];
    out[out.length - 1] = last.slice(0, Math.max(1, maxChars - 1)) + "…";
  }
  return out;
}

// Render one label as a full SVG document string, physically sized (mm units).
// opts.preview draws designer-only guides (the spine divider) that must NOT
// appear on the printed label.
export function renderLabelSvg(tpl: LabelTemplate, item: LabelItem, opts?: { preview?: boolean }): string {
  const W = tpl.widthMm, H = tpl.heightMm, fs = tpl.fontScale;
  const FP = LABEL_FONTS.find((f) => f.key === tpl.fontKey) ?? LABEL_FONTS[0];
  const fam = FP.family.replace(/"/g, "'");
  const fsc = FP.scale ?? 1;
  const chW = FP.charW ?? 0.54;
  const wHeavy = FP.noBold ? "500" : "800";
  const wMid = FP.noBold ? "400" : "700";
  const ls = (sz: number) => (FP.spacing ? ` letter-spacing="${(FP.spacing * sz).toFixed(2)}"` : "");
  const titleStyleAttr = FP.titleItalic ? ' font-style="italic"' : "";
  const INSET = 2; // safe inset for printer drift
  const spineW = tpl.spine === "none" ? 0 : tpl.spineWidthMm;
  const faceX = tpl.spine === "left" ? spineW : 0;
  const faceW = W - spineW;
  const fx = faceX + INSET;
  const fw = faceW - INSET * 2;
  const parts: string[] = [];

  parts.push(`<rect x="0" y="0" width="${W}" height="${H}" fill="#fff"/>`);

  // ---- Barcode geometry first. Preferred payload = the 10-digit numeric
  // label_code (Code 128C, ~27mm — the compact wrap-tag look); the 12-char
  // internal_code fallback is wide (~47mm) and may need the FULL label width,
  // in which case the spine divider stops above the strip (bars crossing the
  // divider would read as a phantom bar → unscannable).
  const bcPayload = item.labelCode || item.internalCode;
  const wantBarcode = tpl.show.barcode && !!bcPayload;
  const bcTextMm = wantBarcode && tpl.barcodeShowText ? 2.4 * fs : 0;
  const bcY = H - INSET - tpl.barcodeHeightMm - bcTextMm;
  let bcModules = 0;
  let bcFullWidth = false;
  if (wantBarcode) {
    try {
      bcModules = code128Modules(bcPayload);
      bcFullWidth = spineW > 0 && bcModules * MIN_MODULE_MM > fw;
    } catch { /* unencodable — no barcode drawn below */ }
  }
  const spineBottom = wantBarcode && bcFullWidth ? Math.max(6, bcY - 1) : H;

  // ---- Spine: logo stamp at the top (uploaded image, else store name), then
  // the price reading bottom-up — deterministic positions, no baseline stacking.
  if (spineW > 0) {
    const sx = tpl.spine === "left" ? 0 : W - spineW;
    // Spine reading direction follows the fold: a LEFT flap reads TOP-DOWN
    // (book-spine convention when the case faces you); a right flap bottom-up.
    const rot = tpl.spine === "left" ? 90 : -90;
    // The divider is a DESIGNER GUIDE only — printed tags fold on this line and
    // a printed rule reads as clutter (owner feedback).
    if (opts?.preview) {
      parts.push(`<line x1="${tpl.spine === "left" ? spineW : sx}" y1="0" x2="${tpl.spine === "left" ? spineW : sx}" y2="${spineBottom.toFixed(2)}" stroke="#bbb" stroke-width="0.25" stroke-dasharray="1,0.8"/>`);
    }
    let logoBottom = 0;
    if (tpl.show.logo) {
      if (tpl.logoUrl) {
        const cx = sx + spineW / 2;
        if (tpl.logoRotate === "sideways") {
          // Rotated with the price: image length runs down the spine.
          const len = Math.max(4, Math.min(tpl.logoHeightMm * 1.8, spineBottom * 0.4));
          const across = Math.min(tpl.logoHeightMm, spineW - 1.6);
          const ly = 1.2 + len / 2;
          parts.push(`<image href="${esc(tpl.logoUrl)}" x="${(cx - len / 2).toFixed(2)}" y="${(ly - across / 2).toFixed(2)}" width="${len.toFixed(2)}" height="${across.toFixed(2)}" preserveAspectRatio="xMidYMid meet" transform="rotate(${rot} ${cx.toFixed(2)} ${ly.toFixed(2)})"/>`);
          logoBottom = 1.2 + len + 0.8;
        } else {
          const lh = Math.max(3, Math.min(tpl.logoHeightMm, spineBottom * 0.4));
          parts.push(`<image href="${esc(tpl.logoUrl)}" x="${(sx + 0.8).toFixed(2)}" y="1.2" width="${(spineW - 1.6).toFixed(2)}" height="${lh.toFixed(2)}" preserveAspectRatio="xMidYMid meet"/>`);
          logoBottom = 1.2 + lh + 0.8;
        }
      } else if (item.storeName) {
        parts.push(`<text x="${(sx + spineW / 2).toFixed(2)}" y="3" text-anchor="middle" font-family="${fam}" font-weight="${wMid}" font-size="${(1.9 * fs * fsc).toFixed(2)}" letter-spacing="0.2" fill="#000">${esc(item.storeName.toUpperCase().slice(0, 12))}</text>`);
        logoBottom = 4.4;
      }
    }
    const tagline = tpl.show.spineText ? tpl.spineText.trim() : "";
    if (tpl.show.price || tagline) {
      const cx = sx + spineW / 2;
      // Price + tagline sit side-by-side across the spine (a 32mm spine can't
      // fit both end-to-end); the PAIR is optically centered on the spine's
      // width so it lines up under the centered logo.
      const priceH = tpl.show.price ? 4.8 * fs * tpl.priceScale * fsc * 0.72 : 0;
      const tagH = tagline ? 2.0 * fs * fsc : 0;
      const gap = priceH && tagH ? 0.9 : 0;
      const total = priceH + gap + tagH;
      let cy = logoBottom + (spineBottom - logoBottom) / 2;
      // Per-font nudge toward the logo end of the spine (never onto it).
      if (FP.spineShift) cy = Math.max(logoBottom + total / 2 + 0.6, cy - FP.spineShift);
      const rotAttr = `transform="rotate(${rot} ${cx.toFixed(2)} ${cy.toFixed(2)})"`;
      const priceDy = tagH ? -(total / 2 - priceH / 2) : 0;
      const tagDy = priceH ? total / 2 - tagH / 2 : 0;
      if (tpl.show.price) {
        parts.push(`<text x="${cx.toFixed(2)}" y="${cy.toFixed(2)}" ${rotAttr} dy="${priceDy.toFixed(2)}" text-anchor="middle" dominant-baseline="central" font-family="${fam}" font-weight="${wHeavy}"${ls(4.8 * fs * tpl.priceScale * fsc)} font-size="${(4.8 * fs * tpl.priceScale * fsc).toFixed(2)}" fill="#000">${esc(money(item.priceCents))}</text>`);
      }
      if (tagline) {
        parts.push(`<text x="${cx.toFixed(2)}" y="${cy.toFixed(2)}" ${rotAttr} dy="${tagDy.toFixed(2)}" text-anchor="middle" dominant-baseline="central" font-family="${fam}" font-weight="${wMid}" font-size="${(2.0 * fs * fsc).toFixed(2)}" letter-spacing="0.2" fill="#000">${esc(tagline)}</text>`);
      }
    }
  }

  // ---- Face ----
  // The inventory-type · location tag runs as a VERTICAL rail down the face's
  // right edge (owner spec), so text content keeps clear of that strip.
  const tagBits = [tpl.show.invType ? item.invTypeName : "", tpl.show.location ? item.locationKey : ""].filter(Boolean);
  const railW = tagBits.length ? 2.8 * fs : 0;
  const contentW = fw - railW;
  const cxFace = fx + contentW / 2; // face text centers on the content column

  // Title auto-sizes: short names print BIG, long names shrink to fit, and the
  // configurable titleMaxChars cut-off ellipsizes runaways.
  let y = INSET;
  // No spine → the logo still belongs on the tag: centered header at the top
  // of the face (image if uploaded, else the store name), face flows below.
  if (spineW === 0 && tpl.show.logo) {
    if (tpl.logoUrl) {
      const lh = Math.min(tpl.logoHeightMm, 10);
      const lw = Math.min(contentW * 0.6, lh * 3.2);
      parts.push(`<image href="${esc(tpl.logoUrl)}" x="${(cxFace - lw / 2).toFixed(2)}" y="${y.toFixed(2)}" width="${lw.toFixed(2)}" height="${lh.toFixed(2)}" preserveAspectRatio="xMidYMid meet"/>`);
      y += lh + 1;
    } else if (item.storeName) {
      y += 2.1 * fs * fsc;
      parts.push(`<text x="${cxFace.toFixed(2)}" y="${y.toFixed(2)}" text-anchor="middle" font-family="${fam}" font-weight="${wMid}" font-size="${(2.1 * fs * fsc).toFixed(2)}" letter-spacing="0.25" fill="#000">${esc(item.storeName.toUpperCase().slice(0, 18))}</text>`);
      y += 0.9;
    }
    // Tagline rides under the no-spine header too.
    const nsTag = tpl.show.spineText ? tpl.spineText.trim() : "";
    if (nsTag) {
      y += 2.2 * fs * fsc;
      parts.push(`<text x="${cxFace.toFixed(2)}" y="${y.toFixed(2)}" text-anchor="middle" font-family="${fam}" font-weight="${wMid}" font-size="${(1.9 * fs * fsc).toFixed(2)}" letter-spacing="0.2" fill="#000">${esc(nsTag)}</text>`);
      y += 0.7;
    }
  }
  const metaSize = 2.4 * fs * fsc * (FP.metaScale ?? 1);
  if (tpl.show.title) {
    const raw = item.title.replace(/\s+/g, " ").trim();
    const cut = raw.length > tpl.titleMaxChars ? raw.slice(0, Math.max(1, tpl.titleMaxChars - 1)).trimEnd() + "…" : raw;
    const perLine = Math.max(6, Math.ceil(cut.length / tpl.titleMaxLines));
    const size = Math.min(4.8 * fs * fsc, Math.max(2.6 * fs, contentW / (perLine * chW)));
    const maxChars = Math.max(4, Math.floor(contentW / (size * chW)));
    y += size * (FP.titleTop ?? 1); // per-font lift: tall display faces start higher
    for (const line of wrapTitle(cut, maxChars, tpl.titleMaxLines)) {
      parts.push(`<text x="${cxFace.toFixed(2)}" y="${y.toFixed(2)}" text-anchor="middle" font-family="${fam}" font-weight="${wHeavy}"${titleStyleAttr}${ls(size)} font-size="${size.toFixed(2)}" fill="#000">${esc(line)}</text>`);
      y += size * 1.15;
    }
    // Hand off to the meta baseline GEOMETRICALLY — title descenders + meta cap
    // height + real air. (A fixed 3mm advance crowded under big display type.)
    y -= size * 1.15;
    y += size * 0.19 + metaSize * 0.72 + (FP.titleGap ?? 1.0);
  } else {
    y += 3.2 * fs;
  }
  const metaBits = [
    tpl.show.category ? item.categoryName : "",
    tpl.show.condition ? item.condShort : "",
    tpl.show.sku && item.sku ? item.sku : "",
  ].filter(Boolean);
  if (metaBits.length) {
    parts.push(`<text x="${cxFace.toFixed(2)}" y="${y.toFixed(2)}" text-anchor="middle" font-family="${fam}"${ls(metaSize)} font-size="${metaSize.toFixed(2)}" fill="#000">${esc(metaBits.join("  ·  "))}</text>`);
    y += metaSize * 1.08;
  }
  // Face price: big, centered — and ALWAYS clear of the barcode strip: the
  // baseline is clamped ≥1.2mm above the bars, and the font shrinks only if a
  // tall title/meta stack leaves genuinely too little room.
  if (tpl.show.price) {
    const floorY = wantBarcode ? bcY - 1.0 : H - INSET;
    let priceFont = 6.0 * fs * tpl.priceScale * fsc * (FP.priceBoost ?? 1);
    const room = floorY - y;
    // Digits carry no descenders, so 0.74 (cap height + air) is the honest
    // block height — the old 0.82 was leaving ~10% of the price on the table.
    if (priceFont * 0.74 > room) priceFont = Math.max(3.2, room / 0.74);
    // Center the price in the leftover room: tight stacks degrade to the old
    // hug-the-top spot; roomy faces (small pixel text) drop it to the visual
    // middle instead of leaving a dead gap above the barcode.
    const py = Math.min(y + room / 2 + priceFont * 0.37, floorY);
    const strong = FP.priceStrong ? ` stroke="#000" stroke-width="${(priceFont * 0.05).toFixed(2)}" paint-order="stroke"` : "";
    const pItal = FP.priceItalic ? ' font-style="italic"' : "";
    parts.push(`<text x="${cxFace.toFixed(2)}" y="${py.toFixed(2)}" text-anchor="middle" font-family="${fam}" font-weight="${wHeavy}"${pItal}${strong}${ls(priceFont)} font-size="${priceFont.toFixed(2)}" fill="#000">${esc(money(item.priceCents))}</text>`);
    y = py;
  }
  // Vertical "Retail · PDX" rail along the right edge, centered on the LABEL's
  // full height so it reads as a cohesive side rail (owner spec).
  if (tagBits.length) {
    const rx = fx + fw - 0.8;
    parts.push(`<text x="${rx.toFixed(2)}" y="${(H / 2).toFixed(2)}" transform="rotate(-90 ${rx.toFixed(2)} ${(H / 2).toFixed(2)})" text-anchor="middle" dominant-baseline="central" font-family="${fam}" font-size="${(2.0 * fs * fsc).toFixed(2)}" letter-spacing="0.15" fill="#000">${esc(tagBits.join(" · "))}</text>`);
  }
  // Barcode pinned to the bottom (face-width, or full label width — see above).
  // Never stretch to fill: modules cap at 0.30mm so a compact numeric code
  // STAYS compact and centered instead of smearing across the label.
  if (wantBarcode && bcModules > 0) {
    // Centered on the same content column as the face text (cohesion).
    const areaX = bcFullWidth ? INSET : fx;
    const areaW = bcFullWidth ? W - INSET * 2 : contentW;
    const modMm = Math.max(MIN_MODULE_MM, Math.min(0.3, areaW / bcModules));
    const { svg } = code128SvgGroup(bcPayload, areaX + Math.max(0, (areaW - bcModules * modMm) / 2), bcY, {
      moduleMm: modMm, heightMm: tpl.barcodeHeightMm, showText: tpl.barcodeShowText, textMm: 2.2 * fs,
    });
    parts.push(svg);
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}mm" height="${H}mm" viewBox="0 0 ${W} ${H}">${parts.join("")}</svg>`;
}
