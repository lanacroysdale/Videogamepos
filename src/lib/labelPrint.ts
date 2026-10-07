// Client-side label printing, shared by inventory, entries, and pricing.
// printLabels() renders one .label-page per copy into a hidden container, sets
// @page to the template's physical size (roll printers take one label per page),
// applies the print-visibility trick, calls window.print(), and cleans up.
// openPrintDialog() is the shared chooser: template picker + per-line copies +
// optional "all copies" toggle + a 1-label test print. Self-contained styling
// (CSS vars from app.css only), so it drops into any POS page.
import { renderLabelSvg, ensureLabelFont, DEFAULT_TEMPLATE, type LabelTemplate, type LabelItem } from "./labels";
import { labelsToPdf, fontStyleTag, inlineLogo, escAttr, snapToInchGrid } from "./labelPdf";
import { findZebraPrinter, printDirect, ZebraError } from "./zebraDirect";

export type PrintJob = { item: LabelItem; copies: number };

// Per-station physical alignment — thermal drivers have head offsets, hidden
// margins, and feed directions no web page can detect, so the user dials
// these in once from a test label and they stick (localStorage).
export type RotateDeg = 0 | 90 | 180 | 270;
export type PrintTune = { rotateDeg?: RotateDeg; scalePct?: number; nudgeXMm?: number; nudgeYMm?: number; dpi?: number };

/** This station's saved label rotation ("0" / "90" / "180" / "270"), reading
 *  the older on/off setting forward; null = never chosen. */
export function storedRotDeg(): string | null {
  try {
    const deg = localStorage.getItem("tl-print-rotdeg");
    if (deg != null) return deg;
    const oldRot = localStorage.getItem("tl-print-rot-v2");
    return oldRot != null ? (oldRot === "1" ? "90" : "0") : null;
  } catch { return null; } // private mode
}

export async function printLabels(jobs: PrintJob[], tpl: LabelTemplate, opts?: PrintTune): Promise<void> {
  const real = jobs.filter((j) => j.copies > 0);
  if (!real.length) return;
  await ensureLabelFont(tpl); // warms the font cache the iframe will hit
  // This path prints from Chrome (the dialog labels it so): the label goes in
  // as INLINE VECTOR SVG — shapes and text, no bitmap anywhere — so the print
  // chain draws it at whatever resolution the device has. Nothing to
  // pixelate, nothing to rescale. (Safari mangles inline-SVG pagination; its
  // path is the PDF button.) Fonts and the logo inline as data: URLs so the
  // isolated iframe needs no network.
  const styleTag = await fontStyleTag(tpl);
  const logoData = tpl.logoUrl ? await inlineLogo(tpl.logoUrl) : "";
  const labels = real.map((j) => {
    let svg = renderLabelSvg(tpl, j.item);
    if (styleTag) svg = svg.replace(/(<svg[^>]*>)/, `$1${styleTag}`);
    if (tpl.logoUrl && logoData) svg = svg.split(escAttr(tpl.logoUrl)).join(logoData).split(tpl.logoUrl).join(logoData);
    return { svg, copies: j.copies };
  });
  await printSvgLabels(labels, { widthMm: tpl.widthMm, heightMm: tpl.heightMm }, opts);
}

/** Print ready-made label SVGs (fonts / images already inlined) through the
 *  browser's print dialog, one label per page at the label's physical size —
 *  price labels and the Label maker share this. */
export async function printSvgLabels(labels: { svg: string; copies: number }[], size: { widthMm: number; heightMm: number }, opts?: PrintTune): Promise<void> {
  const real = labels.filter((l) => l.copies > 0);
  if (!real.length) return;

  // Orientation: 90/270 compose the label sideways onto a PORTRAIT page —
  // roll-native for thermal drivers, which feed narrow-edge first. Which of
  // the four is right depends on the driver's feed direction; the picker in
  // the dialog remembers the answer per station.
  const deg = ([0, 90, 180, 270] as const).includes(opts?.rotateDeg as any) ? (opts!.rotateDeg as RotateDeg) : 0;
  const sideways = deg === 90 || deg === 270;
  // Page = the driver's inch-defined paper exactly (see snapToInchGrid in
  // labelPdf) so nothing gets shrink-to-fitted; the label centers inside.
  const pw = snapToInchGrid(sideways ? size.heightMm : size.widthMm);  // page width
  const ph = snapToInchGrid(sideways ? size.widthMm : size.heightMm);  // page height
  const scale = Math.min(100, Math.max(60, Math.round(Number(opts?.scalePct) || 100)));
  const nx = Math.min(30, Math.max(-30, Number(opts?.nudgeXMm) || 0));
  const ny = Math.min(30, Math.max(-30, Number(opts?.nudgeYMm) || 0));

  // Rotation happens INSIDE the SVG (a natively-oriented image), and each
  // label ships as an <img> — an ATOMIC replaced element that print
  // pagination can move or scale but never split. Safari fragmented both
  // CSS-transformed and inline-SVG labels across two pages.
  const W = size.widthMm, H = size.heightMm;
  const rotateSvg = (svg: string) => {
    if (!deg) return svg;
    const inner = svg.replace(/^<svg[^>]*>/, "").replace(/<\/svg>\s*$/, "");
    const g =
      deg === 90 ? `rotate(90) translate(0 -${H})` :
      deg === 180 ? `rotate(180) translate(-${W} -${H})` :
      `rotate(-90) translate(-${W} 0)`;
    const ow = sideways ? H : W, oh = sideways ? W : H;
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${ow}mm" height="${oh}mm" viewBox="0 0 ${ow} ${oh}"><g transform="${g}">${inner}</g></svg>`;
  };
  const lw = sideways ? size.heightMm : size.widthMm;  // label width on the page
  const lh = sideways ? size.widthMm : size.heightMm;
  // Alignment math in plain mm — no grid/object-fit/percent CSS for the print
  // engine to resolve: the svg gets explicit size and margins. The label
  // keeps its true size, centered on the (inch-exact) page.
  const imgW = (lw * scale) / 100, imgH = (lh * scale) / 100;
  const offX = (pw - imgW) / 2 + nx, offY = (ph - imgH) / 2 + ny;
  const pages: string[] = [];
  for (const l of real) {
    const svg = rotateSvg(l.svg);
    for (let i = 0; i < Math.min(500, l.copies); i++) {
      pages.push(`<div class="label-page">${svg}</div>`);
    }
  }

  // Print from an ISOLATED iframe document that contains nothing but the
  // labels. Printing from the app page itself (hide-the-shell-with-CSS) let
  // the shell's boxes bleed into pagination on Safari — phantom blank labels,
  // shrunk pages. A standalone document has nothing to interfere.
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    @page { size: ${pw}mm ${ph}mm; margin: 0; }
    html, body { margin: 0; padding: 0; width: ${pw}mm; background: #fff; }
    body { line-height: 0; font-size: 0; }
    /* Composed 1mm shy of the page: if the driver's page box is a hair
       smaller than the paper (hidden margins, mm rounding), the label clips
       a fraction instead of spilling to a second page. */
    .label-page { width: ${pw}mm; height: calc(${ph}mm - 1mm); overflow: hidden; break-after: page; page-break-after: always; break-inside: avoid; page-break-inside: avoid; }
    .label-page:last-child { break-after: auto; page-break-after: auto; }
    .label-page svg { display: block; width: ${imgW.toFixed(2)}mm; height: ${imgH.toFixed(2)}mm; margin: ${offY.toFixed(2)}mm 0 0 ${offX.toFixed(2)}mm; }
  </style></head><body>${pages.join("")}</body></html>`;

  document.getElementById("label-print-frame")?.remove();
  const frame = document.createElement("iframe");
  frame.id = "label-print-frame";
  // Not display:none — some engines skip printing invisible frames entirely.
  frame.style.cssText = "position:fixed;right:0;bottom:0;width:1px;height:1px;border:0;visibility:hidden;";
  frame.srcdoc = html;
  await new Promise<void>((res) => { frame.onload = () => res(); document.body.appendChild(frame); });
  const cw = frame.contentWindow!;
  // Fonts must be ready in the iframe before print, or text falls back.
  try { await Promise.race([(cw.document as any).fonts?.ready, new Promise((r) => setTimeout(r, 2500))]); } catch { /* fallback font ok */ }
  await new Promise((r) => setTimeout(r, 50)); // one layout tick
  const cleanup = () => frame.remove();
  cw.addEventListener("afterprint", () => setTimeout(cleanup, 500));
  setTimeout(cleanup, 120_000); // Safari can skip afterprint — sweep up either way
  cw.focus();
  cw.print();
}

export type PrintLine = {
  item: LabelItem;
  defaultCopies: number;         // pre-filled (e.g. qty just received; 1 for reprints)
  allCopies?: number | null;     // copies in stock: shown on the line, + an "All N" button when > 1
  hint?: string;                 // e.g. "price changed since last batch"
};

// The − / + beside each copies box.
const STEP_CSS = "flex:none;width:1.9rem;height:1.9rem;padding:0;font:inherit;font-weight:700;line-height:1;background:transparent;color:var(--text,#eee);border:1px solid var(--border-strong,#444);cursor:pointer;";

const escH = (s: any) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
// "Okami HD [JP]" — the same text form as displayTitle(), so a US and a JP
// copy of one game can be told apart when choosing copies.
const lineTitle = (it: LabelItem) => {
  const tag = (it.region ?? "").trim();
  return tag && !it.title.toLowerCase().endsWith(`[${tag.toLowerCase()}]`) ? `${it.title} [${tag}]` : it.title;
};

// Shared chooser dialog. Returns immediately; printing happens on user action.
export function openPrintDialog(lines: PrintLine[], templates: LabelTemplate[], opts?: { title?: string; onClose?: () => void }): void {
  if (!lines.length) { alert("Nothing to print."); return; }
  document.getElementById("lp-dialog")?.remove();
  const tpls = templates.length ? templates : [{ ...DEFAULT_TEMPLATE }];
  const defIdx = Math.max(0, tpls.findIndex((t) => t.isDefault));

  const overlay = document.createElement("div");
  overlay.id = "lp-dialog";
  overlay.style.cssText = "position:fixed;inset:0;z-index:2000;background:rgba(0,0,0,.55);display:grid;place-items:center;padding:1rem;";
  // The copies list is a minmax(0,1fr) grid: a long title wraps instead of
  // stretching its row past the dialog and pushing the copies box off-screen.
  overlay.innerHTML = `
    <div style="width:100%;max-width:520px;max-height:90vh;overflow:auto;background:var(--panel,#111);border:1px solid var(--border-strong,#444);padding:1.1rem 1.2rem;display:grid;gap:0.7rem;color:var(--text,#eee);">
      <h3 style="margin:0;">🏷 ${escH(opts?.title || "Print labels")}</h3>
      <label style="display:grid;gap:0.25rem;font-size:0.82rem;font-weight:600;">Template
        <select id="lp-tpl" style="font:inherit;padding:0.4rem 0.5rem;background:var(--bg,#000);color:var(--text,#eee);border:1px solid var(--border-strong,#444);">
          ${tpls.map((t, i) => `<option value="${i}"${i === defIdx ? " selected" : ""}>${escH(t.name)} (${t.widthMm}×${t.heightMm}mm)${t.isDefault ? " ⭐" : ""}</option>`).join("")}
        </select>
      </label>
      <div style="display:grid;grid-template-columns:minmax(0,1fr);gap:0.5rem;max-height:44vh;overflow-y:auto;overflow-x:hidden;border-top:1px solid var(--border,#333);padding-top:0.55rem;">
        <div id="lp-skip" hidden style="padding:0.4rem 0.55rem;font-size:0.78rem;background:rgba(44,230,224,.08);border:1px solid rgba(44,230,224,.3);"></div>
        <div style="display:flex;justify-content:space-between;font-size:0.7rem;font-weight:700;letter-spacing:0.05em;text-transform:uppercase;color:var(--muted-2,#888);"><span>Label</span><span>Copies</span></div>
        ${lines.map((l, i) => `
          <div data-lp-row="${i}" style="display:flex;flex-wrap:wrap;align-items:center;gap:0.4rem 0.6rem;min-width:0;">
            <div style="flex:1 1 11rem;min-width:0;font-size:0.88rem;line-height:1.3;overflow-wrap:break-word;">
              ${escH(lineTitle(l.item))}
              <div style="color:var(--muted-2,#888);font-size:0.76rem;">${escH(l.item.condShort)}${l.allCopies != null ? ` · ${l.allCopies} in stock` : ""}${l.hint ? `<span style="color:var(--magenta,#ff49d0);"> · ${escH(l.hint)}</span>` : ""}<span data-lp-range="${i}"></span>${i > 0 ? ` <button data-lp-start="${i}" type="button" title="Print from this line on — the lines above get 0 copies (they already printed)" style="font:inherit;font-size:0.72rem;padding:0 0.2rem;background:none;border:0;color:var(--cyan,#2ce6e0);cursor:pointer;text-decoration:underline;">▶ Start here</button>` : ""}</div>
            </div>
            <div style="flex:none;margin-left:auto;display:flex;align-items:center;gap:0.3rem;">
              ${l.allCopies != null && l.allCopies > 1 ? `<button data-lp-all="${i}" type="button" title="A label for every copy in stock" style="flex:none;font:inherit;font-size:0.76rem;font-weight:700;padding:0.3rem 0.55rem;background:transparent;color:var(--cyan,#2ce6e0);border:1px solid var(--cyan,#2ce6e0);cursor:pointer;white-space:nowrap;">All ${l.allCopies}</button>` : ""}
              <button data-lp-step="${i}" data-d="-1" type="button" aria-label="One fewer" style="${STEP_CSS}">−</button>
              <input data-lp-copies="${i}" type="number" min="0" inputmode="numeric" aria-label="Copies" value="${Math.max(0, l.defaultCopies)}" style="width:3.4rem;flex:none;text-align:center;font:inherit;padding:0.3rem 0.2rem;background:var(--bg,#000);color:var(--text,#eee);border:1px solid var(--border-strong,#444);">
              <button data-lp-step="${i}" data-d="1" type="button" aria-label="One more" style="${STEP_CSS}">+</button>
            </div>
          </div>`).join("")}
      </div>
      <label style="display:flex;align-items:center;gap:0.55rem;font-size:0.78rem;color:var(--muted,#999);flex-wrap:wrap;">
        <span>↻ Orientation on the roll</span>
        <select id="lp-rotdeg" style="font:inherit;padding:0.3rem 0.4rem;background:var(--bg,#000);color:var(--text,#eee);border:1px solid var(--border-strong,#444);">
          <option value="90">Sideways 90° — most label printers</option>
          <option value="270">Sideways 270° — roll feed, other direction</option>
          <option value="0">Flat 0° — sheet printers</option>
          <option value="180">Flat 180° — upside down</option>
        </select>
        <span style="font-size:0.72rem;">wrong way on the sticker? try the next option — saves on this station</span>
      </label>
      <p id="lp-paper" style="margin:0;padding:0.45rem 0.6rem;background:rgba(44,230,224,.08);border:1px solid rgba(44,230,224,.3);color:var(--text,#eee);font-size:0.76rem;"></p>
      <details id="lp-tune-wrap" style="font-size:0.78rem;color:var(--muted,#999);">
        <summary style="cursor:pointer;">🎛 Fine-tune alignment (if the printed label is clipped or off-center — saves on this station)</summary>
        <div style="display:flex;gap:0.9rem;align-items:center;flex-wrap:wrap;margin-top:0.5rem;">
          <label style="display:flex;align-items:center;gap:0.35rem;" title="Match your printer's head — sharpest output is one pixel per printer dot">Printer
            <select id="lp-dpi" style="font:inherit;padding:0.25rem 0.35rem;background:var(--bg,#000);color:var(--text,#eee);border:1px solid var(--border-strong,#444);">
              <option value="203">203 dpi (most thermal printers)</option>
              <option value="300">300 dpi</option>
              <option value="600">600 dpi</option>
            </select>
          </label>
          <label style="display:flex;align-items:center;gap:0.35rem;">Size
            <input id="lp-scale" type="number" min="60" max="100" step="1" value="100" style="width:4.2rem;font:inherit;padding:0.25rem 0.35rem;background:var(--bg,#000);color:var(--text,#eee);border:1px solid var(--border-strong,#444);">%
          </label>
          <label style="display:flex;align-items:center;gap:0.35rem;" title="Positive moves the label right on the page">Nudge →
            <input id="lp-nx" type="number" min="-30" max="30" step="0.5" value="0" style="width:4.2rem;font:inherit;padding:0.25rem 0.35rem;background:var(--bg,#000);color:var(--text,#eee);border:1px solid var(--border-strong,#444);">mm
          </label>
          <label style="display:flex;align-items:center;gap:0.35rem;" title="Positive moves the label down the page">Nudge ↓
            <input id="lp-ny" type="number" min="-30" max="30" step="0.5" value="0" style="width:4.2rem;font:inherit;padding:0.25rem 0.35rem;background:var(--bg,#000);color:var(--text,#eee);border:1px solid var(--border-strong,#444);">mm
          </label>
        </div>
      </details>
      <div id="lp-buttons" style="display:flex;gap:0.5rem;align-items:center;flex-wrap:wrap;border-top:1px solid var(--border,#333);padding-top:0.7rem;">
        <button id="lp-browser" type="button" title="Opens a print-ready PDF — the reliable way to print labels from a browser" style="font:inherit;font-weight:700;padding:0.45rem 0.9rem;background:var(--cyan,#2ce6e0);color:#04222a;border:1px solid var(--cyan,#2ce6e0);cursor:pointer;">🖨 Print</button>
        <button id="lp-print" type="button" title="Sharpest output — prints the labels as vectors straight from this tab. Use in Chrome; Safari's print engine mangles it" style="font:inherit;padding:0.45rem 0.7rem;background:transparent;color:var(--muted,#999);border:1px solid var(--border,#333);cursor:pointer;">⚡ Vector print (Chrome)</button>
        <button id="lp-test" type="button" title="One-label PDF to check printer alignment" style="font:inherit;padding:0.45rem 0.7rem;background:transparent;color:var(--muted,#999);border:1px solid var(--border,#333);cursor:pointer;">1 test label</button>
        <button id="lp-cancel" type="button" style="font:inherit;padding:0.45rem 0.7rem;background:transparent;color:var(--muted,#999);border:1px solid var(--border,#333);cursor:pointer;margin-left:auto;">Cancel</button>
      </div>
      <p style="margin:0;color:var(--muted-2,#888);font-size:0.72rem;">Print opens a ready-made PDF in a new tab — press <b>⌘P</b> there and print at 100%. Every page is exactly one label; what you see is what prints.</p>
    </div>`;

  let sending = false; // a direct print is streaming — the dialog stays put
  const close = () => { if (sending) return; overlay.remove(); opts?.onClose?.(); };
  overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
  overlay.querySelector("#lp-cancel")!.addEventListener("click", close);
  overlay.querySelectorAll<HTMLButtonElement>("[data-lp-all]").forEach((b) =>
    b.addEventListener("click", () => {
      const i = Number(b.dataset.lpAll);
      overlay.querySelector<HTMLInputElement>(`[data-lp-copies="${i}"]`)!.value = String(lines[i].allCopies);
    }));
  const chosenTpl = () => tpls[Number((overlay.querySelector("#lp-tpl") as HTMLSelectElement).value)] ?? tpls[0];
  // Rotation preference sticks per station (it's a printer-driver trait).
  // Unset = ON for landscape labels: roll printers feed narrow-edge first, so
  // sideways-on-a-portrait-page is the shape that prints right by default.
  // Which of the four orientations is correct is a per-station driver trait;
  // migrate the old boolean keys forward, then remember the choice.
  const rotSel = overlay.querySelector<HTMLSelectElement>("#lp-rotdeg")!;
  const storedDeg = storedRotDeg();
  rotSel.value = ["0", "90", "180", "270"].includes(storedDeg ?? "")
    ? storedDeg!
    : chosenTpl().widthMm > chosenTpl().heightMm ? "90" : "0";
  const rotDeg = () => (Number(rotSel.value) || 0) as 0 | 90 | 180 | 270;
  rotSel.addEventListener("change", () => { try { localStorage.setItem("tl-print-rotdeg", rotSel.value); } catch { /* private mode */ } });

  // Physical-alignment tune values persist per station; the details block
  // opens automatically when a saved value is in play so it's never hidden.
  const tuneEls = {
    dpi: overlay.querySelector<HTMLSelectElement>("#lp-dpi")!,
    scale: overlay.querySelector<HTMLInputElement>("#lp-scale")!,
    nx: overlay.querySelector<HTMLInputElement>("#lp-nx")!,
    ny: overlay.querySelector<HTMLInputElement>("#lp-ny")!,
  };
  try {
    tuneEls.dpi.value = ["203", "300", "600"].includes(localStorage.getItem("tl-print-dpi") ?? "") ? localStorage.getItem("tl-print-dpi")! : "203";
    tuneEls.scale.value = localStorage.getItem("tl-print-scale") || "100";
    tuneEls.nx.value = localStorage.getItem("tl-print-nx") || "0";
    tuneEls.ny.value = localStorage.getItem("tl-print-ny") || "0";
  } catch { /* private mode */ }
  if (tuneEls.scale.value !== "100" || tuneEls.nx.value !== "0" || tuneEls.ny.value !== "0" || tuneEls.dpi.value !== "203") {
    overlay.querySelector<HTMLDetailsElement>("#lp-tune-wrap")!.open = true;
  }
  const tune = (): { scalePct: number; nudgeXMm: number; nudgeYMm: number; dpi: number } => {
    const t = {
      scalePct: Number(tuneEls.scale.value) || 100,
      nudgeXMm: Number(tuneEls.nx.value) || 0,
      nudgeYMm: Number(tuneEls.ny.value) || 0,
      dpi: Number(tuneEls.dpi.value) || 203,
    };
    try {
      localStorage.setItem("tl-print-dpi", String(t.dpi));
      localStorage.setItem("tl-print-scale", String(t.scalePct));
      localStorage.setItem("tl-print-nx", String(t.nudgeXMm));
      localStorage.setItem("tl-print-ny", String(t.nudgeYMm));
    } catch { /* private mode */ }
    return t;
  };

  // Live label count on the Print button + the driver paper size to match —
  // the "why did it print 8 pages" and "why is it tiny" answers, up front.
  const inch = (mm: number) => (mm / 25.4).toFixed(2).replace(/0$/, "");
  const copiesInput = (i: number) => overlay.querySelector<HTMLInputElement>(`[data-lp-copies="${i}"]`)!;
  const copiesAt = (i: number) => Math.max(0, Math.round(Number(copiesInput(i).value)) || 0);
  const refreshInfo = () => {
    const t = chosenTpl();
    const sideways = rotDeg() === 90 || rotDeg() === 270;
    // Each line's label numbers in print order (#4–6) — what "▶ Start here"
    // and a stopped print talk about.
    let n = 0;
    lines.forEach((_, i) => {
      const c = copiesAt(i);
      overlay.querySelector(`[data-lp-range="${i}"]`)!.textContent = c ? ` · #${n + 1}${c > 1 ? `–${n + c}` : ""}` : "";
      overlay.querySelector<HTMLElement>(`[data-lp-row="${i}"]`)!.style.opacity = c ? "" : "0.5";
      n += c;
    });
    overlay.querySelector("#lp-browser")!.textContent = `🖨 Print ${n} label${n === 1 ? "" : "s"}`;
    // Talk in the LABEL's terms — the driver's paper picker lists it as
    // W×H (e.g. "2.25x1.25") regardless of which way the page is composed.
    overlay.querySelector("#lp-paper")!.innerHTML =
      `Printer setup: paper size <b>${inch(t.widthMm)} × ${inch(t.heightMm)}″</b> (${t.widthMm}×${t.heightMm}mm — your label size), margins <b>none</b>, scale <b>100%</b>.` +
      (sideways ? ` Pages are composed sideways to match the roll feed — one page = one label.` : ` One page = one label.`);
  };
  refreshInfo();
  rotSel.addEventListener("change", refreshInfo);
  overlay.querySelector("#lp-tpl")!.addEventListener("change", refreshInfo);
  overlay.querySelectorAll<HTMLInputElement>("[data-lp-copies]").forEach((inp) => inp.addEventListener("input", refreshInfo));
  overlay.querySelectorAll<HTMLButtonElement>("[data-lp-step]").forEach((b) => b.addEventListener("click", () => {
    const inp = overlay.querySelector<HTMLInputElement>(`[data-lp-copies="${b.dataset.lpStep}"]`)!;
    inp.value = String(Math.max(0, (Math.round(Number(inp.value)) || 0) + Number(b.dataset.d)));
    refreshInfo();
  }));
  overlay.querySelectorAll<HTMLButtonElement>("[data-lp-all]").forEach((b) => b.addEventListener("click", refreshInfo));
  // ▶ Start here — skip the lines above (already printed, e.g. after a print
  // stopped part-way). `saved` keeps the batch's original copies (for every
  // line touched) so ↺ can put them back.
  let skipped: { from: number; saved: number[] } | null = null;
  const skipBox = overlay.querySelector<HTMLElement>("#lp-skip")!;
  const showSkip = (note?: string) => {
    skipBox.hidden = !skipped;
    if (skipped) {
      const { from, saved } = skipped;
      const n = saved.reduce((a, c, i) => a + Math.max(0, c - copiesAt(i)), 0);
      const partial = copiesAt(from) < (saved[from] ?? 0);
      skipBox.innerHTML = `${note ? `${note}<br>` : ""}▶ Starting at <b>${escH(lineTitle(lines[from].item))}</b>${partial ? ` (its last ${copiesAt(from)})` : ""} — skipping ${n} label${n === 1 ? "" : "s"} of the batch. <button type="button" id="lp-unskip" style="font:inherit;font-size:0.76rem;padding:0;background:none;border:0;color:var(--cyan,#2ce6e0);cursor:pointer;text-decoration:underline;">↺ Put them back</button>`;
      skipBox.querySelector("#lp-unskip")!.addEventListener("click", () => startAt(0));
    }
    refreshInfo();
  };
  const startAt = (from: number) => {
    if (skipped) skipped.saved.forEach((c, i) => (copiesInput(i).value = String(c)));
    skipped = from > 0 ? { from, saved: lines.slice(0, from).map((_, i) => copiesAt(i)) } : null;
    if (skipped) for (let i = 0; i < from; i++) copiesInput(i).value = "0";
    showSkip();
  };
  // After a direct print stops: `run` = the copies that run was sent with.
  // Lines before `from` went out, `from` keeps `first`, later lines keep the
  // run's copies — never the batch's originals (some of those already printed
  // in an earlier run). The originals stay in `saved` for ↺.
  const carryOn = (run: number[], from: number, first: number, note: string) => {
    const old = skipped?.saved ?? [];
    const saved = Array.from({ length: Math.max(from + 1, old.length) }, (_, i) => (i < old.length ? old[i] : run[i]));
    run.forEach((c, i) => (copiesInput(i).value = String(i < from ? 0 : i === from ? first : c)));
    skipped = { from, saved };
    showSkip(note);
  };
  overlay.querySelectorAll<HTMLButtonElement>("[data-lp-start]").forEach((b) => b.addEventListener("click", () => {
    startAt(Number(b.dataset.lpStart));
    skipBox.scrollIntoView({ block: "nearest" });
  }));
  const gatherJobs = (): PrintJob[] | null => {
    const jobs: PrintJob[] = lines.map((l, i) => ({ item: l.item, copies: copiesAt(i) }));
    if (!jobs.some((j) => j.copies > 0)) { alert("Set at least one copy."); return null; }
    return jobs;
  };
  const openPdf = async (jobs: PrintJob[], btn: HTMLButtonElement) => {
    const orig = btn.textContent;
    btn.disabled = true; btn.textContent = "Rendering…";
    try {
      const blob = await labelsToPdf(jobs, chosenTpl(), { rotateDeg: rotDeg(), ...tune() });
      const url = URL.createObjectURL(blob);
      const w = window.open(url, "_blank");
      if (!w) { const a = document.createElement("a"); a.href = url; a.download = "labels.pdf"; a.click(); }
      setTimeout(() => URL.revokeObjectURL(url), 120_000);
      return true;
    } catch (e: any) { alert("Couldn't build the PDF: " + e.message); return false; }
    finally { btn.disabled = false; btn.textContent = orig; }
  };
  // PRIMARY: the PDF path — the only browser label-printing approach that is
  // deterministic across engines (what Shopify/ShipStation-class tools do).
  // Safari's HTML print pagination mangled every layout we fed it.
  overlay.querySelector("#lp-browser")!.addEventListener("click", async (ev) => {
    const jobs = gatherJobs();
    if (!jobs) return;
    if (await openPdf(jobs, ev.currentTarget as HTMLButtonElement)) close();
  });

  // BEST, where available: the Zebra Browser Print agent — ZPL straight to
  // the printer, no macOS printing, no dialogs, no paper sizes, dot-exact.
  // Probed async; the button appears only when the agent answers.
  findZebraPrinter().then((z) => {
    if (!z || !overlay.isConnected) return;
    const row = overlay.querySelector("#lp-buttons")!;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.id = "lp-zebra";
    btn.title = `Sends the labels straight to ${z.name} through Zebra Browser Print — no print dialog, dot-perfect`;
    btn.style.cssText = "font:inherit;font-weight:700;padding:0.45rem 0.9rem;background:var(--green,#80ff72);color:#0a2506;border:1px solid var(--green,#80ff72);cursor:pointer;";
    btn.textContent = `⚡ Direct to ${z.name}`;
    row.prepend(btn);
    // Streams paced to the printer (zebraDirect). While it runs the other
    // buttons are off, ■ Stop ends it after the label being sent, and leaving
    // the page asks first. If it stops, the copies are set up to carry on
    // from the first label the printer didn't take.
    const stopBtn = document.createElement("button");
    stopBtn.type = "button";
    stopBtn.hidden = true;
    stopBtn.style.cssText = "font:inherit;font-weight:700;padding:0.45rem 0.9rem;background:transparent;color:var(--text,#eee);border:1px solid var(--border-strong,#444);cursor:pointer;";
    stopBtn.textContent = "■ Stop";
    btn.after(stopBtn);
    let stopAsked = false;
    stopBtn.addEventListener("click", () => { stopAsked = true; stopBtn.disabled = true; stopBtn.textContent = "Stopping…"; });
    const guard = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ""; };
    const others = () => [...overlay.querySelectorAll<HTMLButtonElement | HTMLInputElement>("#lp-browser, #lp-print, #lp-test, #lp-cancel, [data-lp-start], [data-lp-step], [data-lp-all], #lp-unskip, [data-lp-copies]")];
    btn.addEventListener("click", async () => {
      const jobs = gatherJobs();
      if (!jobs) return;
      const orig = btn.textContent;
      const before = jobs.map((j) => j.copies);
      sending = true; stopAsked = false;
      btn.disabled = true; btn.textContent = "Preparing…";
      stopBtn.hidden = false; stopBtn.disabled = false; stopBtn.textContent = "■ Stop";
      others().forEach((b) => { b.disabled = true; b.style.opacity = "0.45"; });
      window.addEventListener("beforeunload", guard);
      try {
        const n = await printDirect(z.device, jobs, chosenTpl(), tune(), {
          shouldStop: () => stopAsked,
          onProgress: (p) => { btn.textContent = p.phase === "render" ? `Preparing ${p.done}/${p.total}…` : `Sending ${p.done}/${p.total}…`; },
        });
        btn.textContent = `✓ Sent ${n} label${n === 1 ? "" : "s"}`;
        sending = false;
        setTimeout(close, 1200);
      } catch (e: any) {
        sending = false;
        btn.disabled = false; btn.textContent = orig;
        if (e instanceof ZebraError && e.kind === "stopped" && !e.sent) return; // stopped before anything went out
        if (!(e instanceof ZebraError) || !e.at || !e.sent) {
          alert(`Direct print stopped: ${e?.message || e}\n\nCheck that the Zebra is on and ready (green light, labels loaded, lid closed) and is the default printer in the Zebra Browser Print menu-bar app.`);
          return;
        }
        const sent = e.sent, held = e.held;
        const left = before.reduce((a, c) => a + c, 0) - sent;
        const plural = (n: number) => `${n} label${n === 1 ? "" : "s"}`;
        let from = e.at.line, first = before[e.at.line] - e.at.copyStart, more: string;
        if (e.kind === "stopped") more = ` The first ${plural(sent)} are at the printer and finish on their own.`;
        else if (e.kind === "disconnected" && held) {
          // Switched off = the labels it was still holding are gone: carry on
          // from those (a few repeats beat a gap).
          from = held.line; first = before[held.line] - held.copyStart;
          more = ` If it was switched off, the labels it hadn't printed yet are lost — up to the last ${plural(held.copies)} sent — so this starts from those. If some of them did come out, lower the copies below.`;
        } else {
          more = ` The first ${plural(sent)} are at the printer and print once it's fixed — don't switch it off${held ? ` (that would lose the last ${held.copies})` : ""}.`;
          if (e.kind === "agent" || e.kind === "unreachable") more += ` The next ${plural(e.at.copies)} may have reached it too — if they come out, lower the copies below.`;
        }
        const note = `${e.kind === "stopped" ? "■" : "⚠"} ${escH(e.message)}${escH(more)} <b>${left} not sent</b> — fix the printer if needed, then press ⚡ again.`;
        carryOn(before, from, first, note);
        skipBox.scrollIntoView({ block: "nearest" });
      } finally {
        sending = false;
        stopBtn.hidden = true;
        others().forEach((b) => { b.disabled = false; b.style.opacity = ""; });
        window.removeEventListener("beforeunload", guard);
      }
    });
  });
  // Test label: same PDF pipeline, one label, dialog stays open for tuning.
  overlay.querySelector("#lp-test")!.addEventListener("click", (ev) => {
    openPdf([{ item: lines[0].item, copies: 1 }], ev.currentTarget as HTMLButtonElement);
  });
  // Chrome-only convenience: print straight from the tab, no PDF step.
  overlay.querySelector("#lp-print")!.addEventListener("click", () => {
    const jobs = gatherJobs();
    if (!jobs) return;
    const opts = { rotateDeg: rotDeg(), ...tune() };
    close();
    printLabels(jobs, chosenTpl(), opts);
  });

  document.body.appendChild(overlay);
}
