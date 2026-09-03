// Client-side label printing, shared by inventory, entries, and pricing.
// printLabels() renders one .label-page per copy into a hidden container, sets
// @page to the template's physical size (roll printers take one label per page),
// applies the print-visibility trick, calls window.print(), and cleans up.
// openPrintDialog() is the shared chooser: template picker + per-line copies +
// optional "all copies" toggle + a 1-label test print. Self-contained styling
// (CSS vars from app.css only), so it drops into any POS page.
import { renderLabelSvg, ensureLabelFont, DEFAULT_TEMPLATE, type LabelTemplate, type LabelItem } from "./labels";
import { labelsToPdf, fontStyleTag, inlineLogo, escAttr } from "./labelPdf";

export type PrintJob = { item: LabelItem; copies: number };

export async function printLabels(jobs: PrintJob[], tpl: LabelTemplate, opts?: { rotate?: boolean }): Promise<void> {
  const real = jobs.filter((j) => j.copies > 0);
  if (!real.length) return;
  await ensureLabelFont(tpl); // warms the font cache the iframe will hit

  // ROTATE mode: compose the label sideways onto a PORTRAIT page — roll-native
  // for thermal drivers, which feed labels narrow-edge first and normalize the
  // page portrait. Print with Orientation: Portrait, scale 100%.
  const rot = !!opts?.rotate;
  const pw = rot ? tpl.heightMm : tpl.widthMm;  // page width
  const ph = rot ? tpl.widthMm : tpl.heightMm;  // page height

  // Rotation happens INSIDE the SVG (a natively-portrait image), and each
  // label ships as an <img> — an ATOMIC replaced element that print
  // pagination can move or scale but never split. Safari fragmented both
  // CSS-transformed and inline-SVG labels across two pages.
  const W = tpl.widthMm, H = tpl.heightMm;
  const rotateSvg = (svg: string) => {
    const inner = svg.replace(/^<svg[^>]*>/, "").replace(/<\/svg>\s*$/, "");
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${H}mm" height="${W}mm" viewBox="0 0 ${H} ${W}"><g transform="rotate(90) translate(0 -${H})">${inner}</g></svg>`;
  };
  // An <img>'s SVG is an isolated document: no external fetches — inline the
  // web font and logo as data: URLs (same treatment the PDF path uses).
  const styleTag = await fontStyleTag(tpl);
  const logoData = tpl.logoUrl ? await inlineLogo(tpl.logoUrl) : "";
  const pages: string[] = [];
  for (const j of real) {
    let svg = renderLabelSvg(tpl, j.item);
    if (styleTag) svg = svg.replace(/(<svg[^>]*>)/, `$1${styleTag}`);
    if (tpl.logoUrl && logoData) svg = svg.split(escAttr(tpl.logoUrl)).join(logoData).split(tpl.logoUrl).join(logoData);
    if (rot) svg = rotateSvg(svg);
    const src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
    for (let i = 0; i < Math.min(500, j.copies); i++) {
      pages.push(`<div class="label-page"><img src="${src}" alt=""></div>`);
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
    /* Composed 1mm shy of the page and contain-fitted: if the driver's page
       box is a hair smaller than the paper (hidden margins, mm rounding),
       the label scales down a percent instead of spilling to a second page. */
    .label-page { width: ${pw}mm; height: calc(${ph}mm - 1mm); overflow: hidden; display: grid; place-items: center; break-after: page; page-break-after: always; break-inside: avoid; page-break-inside: avoid; }
    .label-page:last-child { break-after: auto; page-break-after: auto; }
    .label-page img { display: block; width: 100%; height: 100%; object-fit: contain; }
  </style></head><body>${pages.join("")}</body></html>`;

  document.getElementById("label-print-frame")?.remove();
  const frame = document.createElement("iframe");
  frame.id = "label-print-frame";
  // Not display:none — some engines skip printing invisible frames entirely.
  frame.style.cssText = "position:fixed;right:0;bottom:0;width:1px;height:1px;border:0;visibility:hidden;";
  frame.srcdoc = html;
  await new Promise<void>((res) => { frame.onload = () => res(); document.body.appendChild(frame); });
  const cw = frame.contentWindow!;
  // Every label <img> must be decoded before print or pages come out empty.
  try {
    const imgs = [...cw.document.images];
    await Promise.race([
      Promise.all(imgs.map((im) => im.decode().catch(() => undefined))),
      new Promise((r) => setTimeout(r, 3000)),
    ]);
  } catch { /* print what we have */ }
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
  allCopies?: number | null;     // when set, offer "all copies (N)" (price-update case)
  hint?: string;                 // e.g. "price changed since last batch"
};

const escH = (s: any) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));

// Shared chooser dialog. Returns immediately; printing happens on user action.
export function openPrintDialog(lines: PrintLine[], templates: LabelTemplate[], opts?: { title?: string }): void {
  if (!lines.length) { alert("Nothing to print."); return; }
  document.getElementById("lp-dialog")?.remove();
  const tpls = templates.length ? templates : [{ ...DEFAULT_TEMPLATE }];
  const defIdx = Math.max(0, tpls.findIndex((t) => t.isDefault));

  const overlay = document.createElement("div");
  overlay.id = "lp-dialog";
  overlay.style.cssText = "position:fixed;inset:0;z-index:2000;background:rgba(0,0,0,.55);display:grid;place-items:center;padding:1rem;";
  overlay.innerHTML = `
    <div style="width:100%;max-width:520px;max-height:90vh;overflow:auto;background:var(--panel,#111);border:1px solid var(--border-strong,#444);padding:1.1rem 1.2rem;display:grid;gap:0.7rem;color:var(--text,#eee);">
      <h3 style="margin:0;">🏷 ${escH(opts?.title || "Print labels")}</h3>
      <label style="display:grid;gap:0.25rem;font-size:0.82rem;font-weight:600;">Template
        <select id="lp-tpl" style="font:inherit;padding:0.4rem 0.5rem;background:var(--bg,#000);color:var(--text,#eee);border:1px solid var(--border-strong,#444);">
          ${tpls.map((t, i) => `<option value="${i}"${i === defIdx ? " selected" : ""}>${escH(t.name)} (${t.widthMm}×${t.heightMm}mm)${t.isDefault ? " ⭐" : ""}</option>`).join("")}
        </select>
      </label>
      <div style="display:grid;gap:0.35rem;max-height:44vh;overflow:auto;border-top:1px solid var(--border,#333);padding-top:0.55rem;">
        ${lines.map((l, i) => `
          <div style="display:flex;align-items:center;gap:0.6rem;">
            <span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:0.88rem;">
              ${escH(l.item.title)} <span style="color:var(--muted-2,#888);font-size:0.78rem;">${escH(l.item.condShort)}</span>
              ${l.hint ? `<span style="color:var(--magenta,#ff49d0);font-size:0.74rem;"> · ${escH(l.hint)}</span>` : ""}
            </span>
            <input data-lp-copies="${i}" type="number" min="0" value="${Math.max(0, l.defaultCopies)}" style="width:4rem;text-align:right;font:inherit;padding:0.3rem 0.4rem;background:var(--bg,#000);color:var(--text,#eee);border:1px solid var(--border-strong,#444);">
            ${l.allCopies != null && l.allCopies > l.defaultCopies ? `<button data-lp-all="${i}" type="button" title="Re-tag every shelf copy" style="font:inherit;font-size:0.72rem;padding:0.25rem 0.5rem;background:transparent;color:var(--cyan,#2ce6e0);border:1px solid var(--cyan,#2ce6e0);cursor:pointer;">all ${l.allCopies}</button>` : ""}
          </div>`).join("")}
      </div>
      <label style="display:flex;align-items:center;gap:0.45rem;font-size:0.78rem;color:var(--muted,#999);cursor:pointer;">
        <input type="checkbox" id="lp-rot" style="accent-color:var(--cyan,#2ce6e0);width:1rem;height:1rem;">
        ↻ Rotate for roll feed — label printers feed narrow-edge first; leave ON for a label printer, turn off for a regular sheet printer
      </label>
      <p id="lp-paper" style="margin:0;padding:0.45rem 0.6rem;background:rgba(44,230,224,.08);border:1px solid rgba(44,230,224,.3);color:var(--text,#eee);font-size:0.76rem;"></p>
      <div style="display:flex;gap:0.5rem;align-items:center;flex-wrap:wrap;border-top:1px solid var(--border,#333);padding-top:0.7rem;">
        <button id="lp-browser" type="button" style="font:inherit;font-weight:700;padding:0.45rem 0.9rem;background:var(--cyan,#2ce6e0);color:#04222a;border:1px solid var(--cyan,#2ce6e0);cursor:pointer;">🖨 Print</button>
        <button id="lp-print" type="button" title="Build a PDF with exactly label-sized pages — prints identically from any device or viewer at 100%" style="font:inherit;padding:0.45rem 0.7rem;background:transparent;color:var(--text,#eee);border:1px solid var(--border-strong,#444);cursor:pointer;">📄 PDF</button>
        <button id="lp-test" type="button" title="Print a single label to check printer alignment" style="font:inherit;padding:0.45rem 0.7rem;background:transparent;color:var(--muted,#999);border:1px solid var(--border,#333);cursor:pointer;">1 test label</button>
        <button id="lp-cancel" type="button" style="font:inherit;padding:0.45rem 0.7rem;background:transparent;color:var(--muted,#999);border:1px solid var(--border,#333);cursor:pointer;margin-left:auto;">Cancel</button>
      </div>
    </div>`;

  const close = () => overlay.remove();
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
  // v2 key: the old key predates rotate-ON-by-default and pinned stale "off"
  // values from early experiments onto stations that need rotation.
  const rotCb = overlay.querySelector<HTMLInputElement>("#lp-rot")!;
  let stored: string | null = null;
  try { stored = localStorage.getItem("tl-print-rot-v2"); } catch { /* private mode */ }
  rotCb.checked = stored == null ? chosenTpl().widthMm > chosenTpl().heightMm : stored === "1";
  rotCb.addEventListener("change", () => { try { localStorage.setItem("tl-print-rot-v2", rotCb.checked ? "1" : "0"); } catch { /* private mode */ } });

  // Live label count on the Print button + the driver paper size to match —
  // the "why did it print 8 pages" and "why is it tiny" answers, up front.
  const inch = (mm: number) => (mm / 25.4).toFixed(2).replace(/0$/, "");
  const refreshInfo = () => {
    const t = chosenTpl();
    const rot = rotCb.checked;
    const pw = rot ? t.heightMm : t.widthMm, ph = rot ? t.widthMm : t.heightMm;
    const n = lines.reduce((a, _, i) => a + Math.max(0, Math.round(Number(overlay.querySelector<HTMLInputElement>(`[data-lp-copies="${i}"]`)!.value)) || 0), 0);
    overlay.querySelector("#lp-browser")!.textContent = `🖨 Print ${n} label${n === 1 ? "" : "s"}`;
    overlay.querySelector("#lp-paper")!.innerHTML =
      `Printer setup: paper size <b>${pw.toFixed(1)} × ${ph.toFixed(1)} mm</b> (${inch(pw)} × ${inch(ph)}″), orientation <b>${pw > ph ? "Landscape" : "Portrait"}</b>, scale <b>100%</b>. One page = one label.`;
  };
  refreshInfo();
  rotCb.addEventListener("change", refreshInfo);
  overlay.querySelector("#lp-tpl")!.addEventListener("change", refreshInfo);
  overlay.querySelectorAll<HTMLInputElement>("[data-lp-copies]").forEach((inp) => inp.addEventListener("input", refreshInfo));
  overlay.querySelectorAll<HTMLButtonElement>("[data-lp-all]").forEach((b) => b.addEventListener("click", refreshInfo));
  const gatherJobs = (): PrintJob[] | null => {
    const jobs: PrintJob[] = lines.map((l, i) => ({
      item: l.item,
      copies: Math.max(0, Math.round(Number(overlay.querySelector<HTMLInputElement>(`[data-lp-copies="${i}"]`)!.value)) || 0),
    }));
    if (!jobs.some((j) => j.copies > 0)) { alert("Set at least one copy."); return null; }
    return jobs;
  };
  const openPdf = async (jobs: PrintJob[], btn: HTMLButtonElement) => {
    const orig = btn.textContent;
    btn.disabled = true; btn.textContent = "Rendering…";
    try {
      const blob = await labelsToPdf(jobs, chosenTpl(), { rotate: rotCb.checked });
      const url = URL.createObjectURL(blob);
      const w = window.open(url, "_blank");
      if (!w) { const a = document.createElement("a"); a.href = url; a.download = "labels.pdf"; a.click(); }
      setTimeout(() => URL.revokeObjectURL(url), 120_000);
      return true;
    } catch (e: any) { alert("Couldn't build the PDF: " + e.message); return false; }
    finally { btn.disabled = false; btn.textContent = orig; }
  };
  overlay.querySelector("#lp-print")!.addEventListener("click", async (ev) => {
    const jobs = gatherJobs();
    if (!jobs) return;
    if (await openPdf(jobs, ev.currentTarget as HTMLButtonElement)) close();
  });
  overlay.querySelector("#lp-test")!.addEventListener("click", (ev) => {
    openPdf([{ item: lines[0].item, copies: 1 }], ev.currentTarget as HTMLButtonElement);
  });
  overlay.querySelector("#lp-browser")!.addEventListener("click", () => {
    const jobs = gatherJobs();
    if (!jobs) return;
    const rotate = rotCb.checked;
    close();
    printLabels(jobs, chosenTpl(), { rotate });
  });

  document.body.appendChild(overlay);
}
