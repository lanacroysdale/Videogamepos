// Price-label templates + SVG renderer, shared by the Settings designer preview
// and every print surface (inventory, entries, pricing). Templates are
// STRUCTURED config stored in store_settings.settings.labelTemplates — never
// freeform markup; the sanitizer here is the trust boundary. All sizes in mm.
// Modeled on the wrap tag: a vertical price spine + a face with title/meta/
// price/barcode. Integer cents throughout.
import { code128SvgGroup, code128Modules } from "./barcode";

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
  };
  barcodeHeightMm: number;               // 5–20
  barcodeShowText: boolean;              // human-readable code under the bars
  titleMaxLines: 1 | 2;
  fontScale: number;                     // 0.7–1.5
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
  internalCode: string;   // barcode payload (TL…)
  sku: string;
  storeName: string;      // spine logo text
};

export const DEFAULT_TEMPLATE: LabelTemplate = {
  id: "wrap-57x32",
  name: "Wrap tag 2.25 × 1.25″",
  widthMm: 57,
  heightMm: 32,
  spine: "right",
  spineWidthMm: 13,
  show: { logo: true, title: true, category: true, condition: true, price: true, invType: true, location: true, sku: false, barcode: true },
  barcodeHeightMm: 8,
  barcodeShowText: true,
  titleMaxLines: 1,
  fontScale: 1,
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
      },
      barcodeHeightMm: clamp(t.barcodeHeightMm, 5, 20, d.barcodeHeightMm),
      barcodeShowText: t.barcodeShowText !== false,
      titleMaxLines: t.titleMaxLines === 2 ? 2 : 1,
      fontScale: clamp(t.fontScale, 0.7, 1.5, 1),
      isDefault: t.isDefault === true,
    });
    // Cross-clamps: independent ranges can still combine into impossible
    // geometry (spine wider than the label; bars taller than the label).
    const cur = out[out.length - 1];
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
const money = (c: number) => "$" + ((c || 0) / 100).toFixed(2);

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
export function renderLabelSvg(tpl: LabelTemplate, item: LabelItem): string {
  const W = tpl.widthMm, H = tpl.heightMm, fs = tpl.fontScale;
  const INSET = 2; // safe inset for printer drift
  const spineW = tpl.spine === "none" ? 0 : tpl.spineWidthMm;
  const faceX = tpl.spine === "left" ? spineW : 0;
  const faceW = W - spineW;
  const fx = faceX + INSET;
  const fw = faceW - INSET * 2;
  const parts: string[] = [];

  parts.push(`<rect x="0" y="0" width="${W}" height="${H}" fill="#fff"/>`);

  // ---- Barcode geometry first: a real 12-char code at scanner-safe density
  // (≥0.25mm modules) needs ~47mm — wider than the face once a spine is on. In
  // that case the barcode strip spans the FULL label width, the spine divider
  // stops above it, and the spine text re-centers on the remaining height.
  // Bars crossing the divider would read as a phantom bar → unscannable.
  const wantBarcode = tpl.show.barcode && !!item.internalCode;
  const bcTextMm = wantBarcode && tpl.barcodeShowText ? 2.4 * fs : 0;
  const bcY = H - INSET - tpl.barcodeHeightMm - bcTextMm;
  let bcModules = 0;
  let bcFullWidth = false;
  if (wantBarcode) {
    try {
      bcModules = code128Modules(item.internalCode);
      bcFullWidth = spineW > 0 && bcModules * MIN_MODULE_MM > fw;
    } catch { /* unencodable — no barcode drawn below */ }
  }
  const spineBottom = wantBarcode && bcFullWidth ? Math.max(6, bcY - 1) : H;

  // ---- Spine: vertical price + logo (reads bottom-up, VGW style) ----
  if (spineW > 0) {
    const sx = tpl.spine === "left" ? 0 : W - spineW;
    const cx = sx + spineW / 2;
    const cy = spineBottom / 2;
    parts.push(`<line x1="${tpl.spine === "left" ? spineW : sx}" y1="0" x2="${tpl.spine === "left" ? spineW : sx}" y2="${spineBottom.toFixed(2)}" stroke="#000" stroke-width="0.3"/>`);
    if (tpl.show.price) {
      parts.push(`<text x="${cx}" y="${cy.toFixed(2)}" transform="rotate(-90 ${cx} ${cy.toFixed(2)})" text-anchor="middle" dominant-baseline="${tpl.show.logo ? "auto" : "middle"}" font-family="Arial,Helvetica,sans-serif" font-weight="800" font-size="${(5.2 * fs).toFixed(2)}" fill="#000">${esc(money(item.priceCents))}</text>`);
    }
    if (tpl.show.logo && item.storeName) {
      parts.push(`<text x="${cx}" y="${cy.toFixed(2)}" transform="rotate(-90 ${cx} ${cy.toFixed(2)})" dy="${(3.4 * fs).toFixed(2)}" text-anchor="middle" font-family="Arial,Helvetica,sans-serif" font-weight="700" font-size="${(2.1 * fs).toFixed(2)}" letter-spacing="0.3" fill="#000">${esc(item.storeName.toUpperCase())}</text>`);
    }
  }

  // ---- Face ----
  let y = INSET + 3.2 * fs;
  if (tpl.show.title) {
    const maxChars = Math.max(8, Math.floor(fw / (1.9 * fs)));
    for (const line of wrapTitle(item.title, maxChars, tpl.titleMaxLines)) {
      parts.push(`<text x="${fx}" y="${y.toFixed(2)}" font-family="Arial,Helvetica,sans-serif" font-weight="800" font-size="${(3.2 * fs).toFixed(2)}" fill="#000">${esc(line)}</text>`);
      y += 3.6 * fs;
    }
  }
  const metaBits = [
    tpl.show.category ? item.categoryName : "",
    tpl.show.condition ? item.condShort : "",
    tpl.show.sku && item.sku ? item.sku : "",
  ].filter(Boolean);
  if (metaBits.length) {
    parts.push(`<text x="${fx}" y="${y.toFixed(2)}" font-family="Arial,Helvetica,sans-serif" font-size="${(2.4 * fs).toFixed(2)}" fill="#000">${esc(metaBits.join("  ·  "))}</text>`);
    y += 3 * fs;
  }
  // Price (face) + inventory type / location tag line.
  const tagBits = [tpl.show.invType ? item.invTypeName : "", tpl.show.location ? item.locationKey : ""].filter(Boolean);
  if (tpl.show.price || tagBits.length) {
    const py = y + 1.4 * fs;
    if (tpl.show.price) {
      parts.push(`<text x="${fx}" y="${py.toFixed(2)}" font-family="Arial,Helvetica,sans-serif" font-weight="800" font-size="${(4.4 * fs).toFixed(2)}" fill="#000">${esc(money(item.priceCents))}</text>`);
    }
    if (tagBits.length) {
      parts.push(`<text x="${(fx + fw).toFixed(2)}" y="${py.toFixed(2)}" text-anchor="end" font-family="Arial,Helvetica,sans-serif" font-size="${(2.1 * fs).toFixed(2)}" fill="#000">${esc(tagBits.join(" · "))}</text>`);
    }
    y = py;
  }
  // Barcode pinned to the bottom (face-width, or full label width — see above).
  if (wantBarcode && bcModules > 0) {
    const areaX = bcFullWidth ? INSET : fx;
    const areaW = bcFullWidth ? W - INSET * 2 : fw;
    const modMm = Math.max(MIN_MODULE_MM, Math.min(0.5, areaW / bcModules));
    const { svg } = code128SvgGroup(item.internalCode, areaX + Math.max(0, (areaW - bcModules * modMm) / 2), bcY, {
      moduleMm: modMm, heightMm: tpl.barcodeHeightMm, showText: tpl.barcodeShowText, textMm: 2.2 * fs,
    });
    parts.push(svg);
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}mm" height="${H}mm" viewBox="0 0 ${W} ${H}">${parts.join("")}</svg>`;
}
