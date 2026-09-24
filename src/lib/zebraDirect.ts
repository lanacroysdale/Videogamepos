// Direct-to-Zebra printing via the free Zebra Browser Print agent
// (https://www.zebra.com/browserprint) — bypasses macOS printing entirely.
// No print dialogs, no paper sizes, no orientation, no driver scaling: the
// label is rendered here at the head's exact dot pitch and shipped as native
// ZPL, so what the POS composes is what the head burns, dot for dot. The ZPL
// also declares the label length (^LL) and gap tracking (^MN), which stops
// the runaway blank-label feeding a mismatched macOS paper size causes.
//
// The agent serves http://127.0.0.1:9100. Chrome treats localhost as a
// secure context, so the HTTPS POS may call it; the agent asks the user to
// approve the site on first contact. Requests are sent without custom
// headers (simple requests — the agent doesn't answer CORS preflights).
import { renderLabelSvg, ensureLabelFont, type LabelTemplate, type LabelItem } from "./labels";
import { fontStyleTag, inlineLogo, escAttr, snapToInchGrid } from "./labelPdf";

export type ZebraJob = { item: LabelItem; copies: number };
export type ZebraTune = { scalePct?: number; nudgeXMm?: number; nudgeYMm?: number };

const AGENT = "http://127.0.0.1:9100";
const DOTS_PER_MM = 8; // ZD-series 203dpi class = 8 dots/mm exactly

// Resolves to the agent's default printer device (JSON blob the /write call
// needs back verbatim), or null when the agent isn't running on this station.
export async function findZebraPrinter(): Promise<{ device: any; name: string } | null> {
  try {
    const r = await fetch(`${AGENT}/default?type=printer`, { signal: AbortSignal.timeout(1500) });
    if (!r.ok) return null;
    const t = (await r.text()).trim();
    if (!t) return null;
    const j = JSON.parse(t);
    const device = j?.connection ? j : Array.isArray(j?.printer) ? j.printer[0] : null;
    if (!device?.connection) return null;
    return { device, name: String(device.name || "Zebra") };
  } catch { return null; }
}

// Render one label to a 1-bit ZPL graphic field at exact head dots.
async function labelToZplBitmap(tpl: LabelTemplate, item: LabelItem, tune?: ZebraTune, deps?: { styleTag: string; logoData: string }): Promise<{ hex: string; rowBytes: number; rows: number; pw: number }> {
  let svg = renderLabelSvg(tpl, item);
  if (deps?.styleTag) svg = svg.replace(/(<svg[^>]*>)/, `$1${deps.styleTag}`);
  if (tpl.logoUrl && deps?.logoData) svg = svg.split(escAttr(tpl.logoUrl)).join(deps.logoData).split(tpl.logoUrl).join(deps.logoData);

  const img = new Image();
  await new Promise<void>((res, rej) => {
    img.onload = () => res();
    img.onerror = () => rej(new Error("Label failed to render"));
    img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
  });

  // Canvas = the physical label at 8 dots/mm (inch-exact size).
  const pw = Math.round(snapToInchGrid(tpl.widthMm) * DOTS_PER_MM);
  const rows = Math.round(snapToInchGrid(tpl.heightMm) * DOTS_PER_MM);
  const canvas = document.createElement("canvas");
  canvas.width = pw;
  canvas.height = rows;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, pw, rows);
  const s = Math.min(100, Math.max(60, Math.round(Number(tune?.scalePct) || 100))) / 100;
  const nx = Math.min(30, Math.max(-30, Number(tune?.nudgeXMm) || 0)) * DOTS_PER_MM;
  const ny = Math.min(30, Math.max(-30, Number(tune?.nudgeYMm) || 0)) * DOTS_PER_MM;
  const dw = tpl.widthMm * DOTS_PER_MM * s, dh = tpl.heightMm * DOTS_PER_MM * s;
  ctx.drawImage(img, (pw - dw) / 2 + nx, (rows - dh) / 2 + ny, dw, dh);

  // 1 bit per dot, MSB first, rows byte-aligned. In ZPL ^GFA a 1 is BLACK.
  const px = ctx.getImageData(0, 0, pw, rows).data;
  const rowBytes = Math.ceil(pw / 8);
  const bytes = new Uint8Array(rowBytes * rows);
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < pw; x++) {
      const i = (y * pw + x) * 4;
      const lum = px[i] * 0.299 + px[i + 1] * 0.587 + px[i + 2] * 0.114;
      if (lum < 128) bytes[y * rowBytes + (x >> 3)] |= 0x80 >> (x & 7);
    }
  }
  let hex = "";
  for (let i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, "0").toUpperCase();
  return { hex, rowBytes, rows, pw };
}

export function buildZpl(bitmap: { hex: string; rowBytes: number; rows: number; pw: number }, copies: number): string {
  const total = bitmap.rowBytes * bitmap.rows;
  // ^MNY gap tracking + ^PW/^LL pin the geometry so the printer never
  // free-runs past the label gap; ^PQ prints N copies of the one format.
  return `^XA^MNY^PW${bitmap.pw}^LL${bitmap.rows}^LH0,0^FO0,0^GFA,${total},${total},${bitmap.rowBytes},${bitmap.hex}^FS^PQ${Math.max(1, Math.min(500, copies))}^XZ`;
}

// Render every job and hand the ZPL to the agent's chosen printer.
export async function printDirect(device: any, jobs: ZebraJob[], tpl: LabelTemplate, tune?: ZebraTune): Promise<number> {
  const real = jobs.filter((j) => j.copies > 0);
  if (!real.length) return 0;
  await ensureLabelFont(tpl);
  const deps = { styleTag: await fontStyleTag(tpl), logoData: tpl.logoUrl ? await inlineLogo(tpl.logoUrl) : "" };
  let zpl = "";
  let n = 0;
  for (const j of real) {
    const bmp = await labelToZplBitmap(tpl, j.item, tune, deps);
    zpl += buildZpl(bmp, j.copies);
    n += Math.min(500, j.copies);
  }
  const r = await fetch(`${AGENT}/write`, {
    method: "POST",
    body: JSON.stringify({ device, data: zpl }),
    signal: AbortSignal.timeout(20000),
  });
  if (!r.ok) throw new Error(`The Zebra agent refused the job (${r.status})`);
  return n;
}
