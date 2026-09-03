// Deterministic label output: render each label SVG to a canvas at the
// printer's native 203dpi (8px/mm) and assemble a hand-written PDF whose
// pages are EXACTLY the label size. Browser print CSS (@page) is a lost cause
// on Safari + thermal drivers — a PDF prints pixel-identical from any viewer
// at 100% / Actual Size, ends the orientation guessing, and previews honestly.
//
// SVG-as-image quirks handled here: an <img> SVG can't reach document fonts or
// the network, so web fonts are fetched and INLINED as data: @font-face and
// the logo image is swapped to a data: URL before rasterizing.
import { renderLabelSvg, ensureLabelFont, LABEL_FONTS, type LabelTemplate, type LabelItem } from "./labels";

export type PdfJob = { item: LabelItem; copies: number };

const PX_PER_MM = 8; // 203.2 dpi — native for the MUNBYN-class thermal heads
const PT_PER_MM = 72 / 25.4;

const b64 = (buf: ArrayBuffer) => {
  const bytes = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};

// ---- font + logo inlining (cached per URL for the session) ----
const cssCache = new Map<string, string>();
async function inlineFontCss(cssUrl: string): Promise<string> {
  if (cssCache.has(cssUrl)) return cssCache.get(cssUrl)!;
  try {
    const css = await (await fetch(cssUrl)).text();
    const urls = [...css.matchAll(/url\((https:\/\/[^)]+)\)/g)].map((m) => m[1]);
    let out = css;
    for (const u of new Set(urls)) {
      const buf = await (await fetch(u)).arrayBuffer();
      out = out.split(u).join(`data:font/woff2;base64,${b64(buf)}`);
    }
    cssCache.set(cssUrl, out);
    return out;
  } catch { return ""; } // fallback font renders instead
}

const logoCache = new Map<string, string>();
export async function inlineLogo(url: string): Promise<string> {
  if (logoCache.has(url)) return logoCache.get(url)!;
  try {
    const blob = await (await fetch(url)).blob();
    const data = await new Promise<string>((res, rej) => {
      const r = new FileReader();
      r.onload = () => res(String(r.result));
      r.onerror = rej;
      r.readAsDataURL(blob);
    });
    logoCache.set(url, data);
    return data;
  } catch { return url; } // leave as-is; the image slot renders empty
}

export async function fontStyleTag(tpl: LabelTemplate): Promise<string> {
  if (tpl.fontKey === "custom" && tpl.fontUrl) {
    try {
      const buf = await (await fetch(tpl.fontUrl)).arrayBuffer();
      return `<style>@font-face{font-family:'TLLabelCustom';src:url(data:font/woff2;base64,${b64(buf)})}</style>`;
    } catch { return ""; }
  }
  const f = LABEL_FONTS.find((x) => x.key === tpl.fontKey);
  if (!f?.css) return ""; // system faces work inside svg-images natively
  const css = await inlineFontCss(f.css);
  return css ? `<style>${css}</style>` : "";
}

// esc() in labels.ts entity-encodes the logo URL inside href="…"
export const escAttr = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));

export type PdfTune = { scalePct?: number; nudgeXMm?: number; nudgeYMm?: number };

async function rasterize(svg: string, wMm: number, hMm: number, deg: 0 | 90 | 180 | 270, tune?: PdfTune): Promise<{ jpeg: Uint8Array; pw: number; ph: number }> {
  const img = new Image();
  await new Promise<void>((res, rej) => {
    img.onload = () => res();
    img.onerror = () => rej(new Error("Label image failed to render"));
    img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
  });
  const w = Math.round(wMm * PX_PER_MM), h = Math.round(hMm * PX_PER_MM);
  const sideways = deg === 90 || deg === 270;
  // Rotate onto a page-size scratch canvas first…
  const rotated = document.createElement("canvas");
  rotated.width = sideways ? h : w;
  rotated.height = sideways ? w : h;
  const rctx = rotated.getContext("2d")!;
  rctx.fillStyle = "#fff";
  rctx.fillRect(0, 0, rotated.width, rotated.height);
  if (deg === 90) { rctx.translate(rotated.width, 0); rctx.rotate(Math.PI / 2); }
  else if (deg === 180) { rctx.translate(rotated.width, rotated.height); rctx.rotate(Math.PI); }
  else if (deg === 270) { rctx.translate(0, rotated.height); rctx.rotate(-Math.PI / 2); }
  rctx.drawImage(img, 0, 0, w, h);
  // …then apply the per-station physical alignment (size % + mm nudges) in
  // plain page coordinates.
  const s = Math.min(100, Math.max(60, Math.round(Number(tune?.scalePct) || 100))) / 100;
  const nx = Math.min(8, Math.max(-8, Number(tune?.nudgeXMm) || 0)) * PX_PER_MM;
  const ny = Math.min(8, Math.max(-8, Number(tune?.nudgeYMm) || 0)) * PX_PER_MM;
  const canvas = document.createElement("canvas");
  canvas.width = rotated.width;
  canvas.height = rotated.height;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const dw = rotated.width * s, dh = rotated.height * s;
  ctx.drawImage(rotated, (canvas.width - dw) / 2 + nx, (canvas.height - dh) / 2 + ny, dw, dh);
  const dataUrl = canvas.toDataURL("image/jpeg", 0.93);
  const bin = atob(dataUrl.slice(dataUrl.indexOf(",") + 1));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return { jpeg: bytes, pw: canvas.width, ph: canvas.height };
}

// ---- minimal PDF writer: one image XObject per unique label, one page per copy ----
function buildPdf(images: { jpeg: Uint8Array; pw: number; ph: number }[], pageOfCopy: number[], wPt: number, hPt: number): Blob {
  const enc = new TextEncoder();
  const parts: (Uint8Array | string)[] = [];
  let offset = 0;
  const offsets: number[] = [];
  const push = (x: string | Uint8Array) => {
    const b = typeof x === "string" ? enc.encode(x) : x;
    parts.push(b);
    offset += b.length;
  };
  const obj = (n: number, body: string) => { offsets[n] = offset; push(`${n} 0 obj\n${body}\nendobj\n`); };

  const nImg = images.length;
  const imgObj = (i: number) => 3 + i;                 // image XObjects
  const cntObj = (i: number) => 3 + nImg + i;          // shared content stream per image
  const pageObj = (i: number) => 3 + 2 * nImg + i;     // one per copy
  const total = 2 + 2 * nImg + pageOfCopy.length;

  push("%PDF-1.4\n%âãÏÓ\n");
  obj(1, "<< /Type /Catalog /Pages 2 0 R >>");
  obj(2, `<< /Type /Pages /Kids [${pageOfCopy.map((_, i) => `${pageObj(i)} 0 R`).join(" ")}] /Count ${pageOfCopy.length} >>`);
  images.forEach((im, i) => {
    offsets[imgObj(i)] = offset;
    push(`${imgObj(i)} 0 obj\n<< /Type /XObject /Subtype /Image /Width ${im.pw} /Height ${im.ph} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${im.jpeg.length} >>\nstream\n`);
    push(im.jpeg);
    push("\nendstream\nendobj\n");
  });
  images.forEach((_, i) => {
    const s = `q ${wPt.toFixed(2)} 0 0 ${hPt.toFixed(2)} 0 0 cm /Im${i} Do Q`;
    obj(cntObj(i), `<< /Length ${s.length} >>\nstream\n${s}\nendstream`);
  });
  pageOfCopy.forEach((imgIdx, i) => {
    obj(pageObj(i), `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${wPt.toFixed(2)} ${hPt.toFixed(2)}] /Resources << /XObject << /Im${imgIdx} ${imgObj(imgIdx)} 0 R >> >> /Contents ${cntObj(imgIdx)} 0 R >>`);
  });

  const xrefAt = offset;
  push(`xref\n0 ${total + 1}\n0000000000 65535 f \n`);
  for (let n = 1; n <= total; n++) push(`${String(offsets[n]).padStart(10, "0")} 00000 n \n`);
  push(`trailer\n<< /Size ${total + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF`);
  return new Blob(parts as BlobPart[], { type: "application/pdf" });
}

// Render every job to a PDF blob. rotateDeg composes each label at the given
// orientation (90/270 = sideways on a portrait page, roll-native for
// portrait-fed drivers; 180 = flat upside down).
export async function labelsToPdf(jobs: PdfJob[], tpl: LabelTemplate, opts?: { rotateDeg?: 0 | 90 | 180 | 270 } & PdfTune): Promise<Blob> {
  const real = jobs.filter((j) => j.copies > 0);
  if (!real.length) throw new Error("Nothing to print.");
  await ensureLabelFont(tpl);
  const deg = ([0, 90, 180, 270] as const).includes(opts?.rotateDeg as any) ? opts!.rotateDeg! : 0;
  const sideways = deg === 90 || deg === 270;
  const styleTag = await fontStyleTag(tpl);
  const logoData = tpl.logoUrl ? await inlineLogo(tpl.logoUrl) : "";

  const images: { jpeg: Uint8Array; pw: number; ph: number }[] = [];
  const pageOfCopy: number[] = [];
  for (const j of real) {
    let svg = renderLabelSvg(tpl, j.item);
    if (styleTag) svg = svg.replace(/(<svg[^>]*>)/, `$1${styleTag}`);
    if (tpl.logoUrl && logoData) svg = svg.split(escAttr(tpl.logoUrl)).join(logoData).split(tpl.logoUrl).join(logoData);
    const im = await rasterize(svg, tpl.widthMm, tpl.heightMm, deg, opts);
    const idx = images.push(im) - 1;
    for (let c = 0; c < Math.min(500, j.copies); c++) pageOfCopy.push(idx);
  }
  const wPt = (sideways ? tpl.heightMm : tpl.widthMm) * PT_PER_MM;
  const hPt = (sideways ? tpl.widthMm : tpl.heightMm) * PT_PER_MM;
  return buildPdf(images, pageOfCopy, wPt, hPt);
}
