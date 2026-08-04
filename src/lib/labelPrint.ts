// Client-side label printing, shared by inventory, entries, and pricing.
// printLabels() renders one .label-page per copy into a hidden container, sets
// @page to the template's physical size (roll printers take one label per page),
// applies the print-visibility trick, calls window.print(), and cleans up.
// openPrintDialog() is the shared chooser: template picker + per-line copies +
// optional "all copies" toggle + a 1-label test print. Self-contained styling
// (CSS vars from app.css only), so it drops into any POS page.
import { renderLabelSvg, ensureLabelFont, DEFAULT_TEMPLATE, type LabelTemplate, type LabelItem } from "./labels";

export type PrintJob = { item: LabelItem; copies: number };

export async function printLabels(jobs: PrintJob[], tpl: LabelTemplate, opts?: { rotate?: boolean }): Promise<void> {
  const real = jobs.filter((j) => j.copies > 0);
  if (!real.length) return;
  await ensureLabelFont(tpl); // font ready BEFORE print — no fallback-font tags
  document.getElementById("label-print")?.remove();
  document.getElementById("label-print-style")?.remove();

  // ROTATE mode: compose the label sideways onto a PORTRAIT page (roll-native
  // for most thermal drivers). Safari applies the Landscape toggle to the
  // output but NOT to the CSS layout surface, so a wide label on a portrait-
  // normalized roll shrinks — rotating in CSS sidesteps the driver entirely:
  // print with Orientation: Portrait, scale 100%.
  const rot = !!opts?.rotate;
  const pw = rot ? tpl.heightMm : tpl.widthMm;  // page width
  const ph = rot ? tpl.widthMm : tpl.heightMm;  // page height

  const style = document.createElement("style");
  style.id = "label-print-style";
  style.textContent = `
    @page { size: ${pw}mm ${ph}mm; margin: 0; }
    #label-print { position: fixed; left: -9999px; top: 0; background: #fff; }
    .label-page { width: ${pw}mm; height: ${ph}mm; overflow: hidden; break-after: page; page-break-after: always; }
    .label-page:last-child { break-after: auto; page-break-after: auto; }
    .label-page svg { display: block; }
    .label-rot { width: ${tpl.widthMm}mm; height: ${tpl.heightMm}mm; transform: rotate(90deg) translateY(-${tpl.heightMm}mm); transform-origin: top left; }
    @media print {
      /* display:none, NOT the visibility trick: hidden boxes keep their height,
         and the app shell in normal flow would feed a stack of BLANK labels
         before the real ones on a roll printer. */
      body > :not(#label-print) { display: none !important; }
      #label-print { position: static !important; left: 0 !important; }
      /* Safari ignores @page size — pin the document to the page's exact
         geometry so its shrink-to-fit math has nothing to shrink. */
      html, body { width: ${pw}mm !important; margin: 0 !important; padding: 0 !important; }
      .label-page { break-inside: avoid; page-break-inside: avoid; }
    }`;

  const wrap = document.createElement("div");
  wrap.id = "label-print";
  const pages: string[] = [];
  for (const j of real) for (let i = 0; i < Math.min(500, j.copies); i++) {
    const svg = renderLabelSvg(tpl, j.item);
    pages.push(`<div class="label-page">${rot ? `<div class="label-rot">${svg}</div>` : svg}</div>`);
  }
  wrap.innerHTML = pages.join("");

  document.head.appendChild(style);
  document.body.appendChild(wrap);
  const cleanup = () => { wrap.remove(); style.remove(); window.removeEventListener("afterprint", cleanup); };
  window.addEventListener("afterprint", cleanup);
  window.print();
  // Safari can skip afterprint — sweep up eventually either way.
  setTimeout(cleanup, 60_000);
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
        ↻ Rotate 90° — for drivers that feed the roll tall/portrait (then print with Orientation: Portrait)
      </label>
      <div style="display:flex;gap:0.5rem;align-items:center;flex-wrap:wrap;border-top:1px solid var(--border,#333);padding-top:0.7rem;">
        <button id="lp-print" type="button" style="font:inherit;font-weight:700;padding:0.45rem 0.9rem;background:var(--cyan,#2ce6e0);color:#04222a;border:1px solid var(--cyan,#2ce6e0);cursor:pointer;">🖨 Print</button>
        <button id="lp-test" type="button" title="Print a single label to check printer alignment" style="font:inherit;padding:0.45rem 0.7rem;background:transparent;color:var(--text,#eee);border:1px solid var(--border-strong,#444);cursor:pointer;">Print 1 test</button>
        <button id="lp-cancel" type="button" style="font:inherit;padding:0.45rem 0.7rem;background:transparent;color:var(--muted,#999);border:1px solid var(--border,#333);cursor:pointer;margin-left:auto;">Cancel</button>
      </div>
      <p style="margin:0;color:var(--muted-2,#888);font-size:0.72rem;">Set the printer driver to the same label size and print at 100% / Actual size.</p>
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
  const rotCb = overlay.querySelector<HTMLInputElement>("#lp-rot")!;
  try { rotCb.checked = localStorage.getItem("tl-print-rot") === "1"; } catch { /* private mode */ }
  rotCb.addEventListener("change", () => { try { localStorage.setItem("tl-print-rot", rotCb.checked ? "1" : "0"); } catch { /* private mode */ } });
  overlay.querySelector("#lp-print")!.addEventListener("click", () => {
    const jobs: PrintJob[] = lines.map((l, i) => ({
      item: l.item,
      copies: Math.max(0, Math.round(Number(overlay.querySelector<HTMLInputElement>(`[data-lp-copies="${i}"]`)!.value)) || 0),
    }));
    if (!jobs.some((j) => j.copies > 0)) { alert("Set at least one copy."); return; }
    const rotate = rotCb.checked;
    close();
    printLabels(jobs, chosenTpl(), { rotate });
  });
  overlay.querySelector("#lp-test")!.addEventListener("click", () => {
    printLabels([{ item: lines[0].item, copies: 1 }], chosenTpl(), { rotate: rotCb.checked });
  });

  document.body.appendChild(overlay);
}
