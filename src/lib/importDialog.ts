// Collection CSV import dialog — shared by the inventory entry screen (stages
// lines onto the open draft) and the trade-in screen (fills buy-ticket rows).
//
// Flow: pick/drop a .csv → columns auto-detected (editable) → every row is
// matched against the catalog (existing condition / new condition on the same
// listing / new listing) → the employee reviews + overrides → Import. Nothing
// is written until `onImport` runs; the caller owns the persistence.

import { parseDelimited } from "./csv";
import {
  COLUMN_DEFS, type ColumnKey, type ColumnMap, detectColumns, headerSignature, looksLikeHeader,
  buildRows, prepareCatalog, matchRow, chooseProduct, centsColumns, isSummaryRow, newListingKey, officialTitleFor, norm,
  type CatalogProduct, type ImportRow, type ResolvedRow,
} from "./collectionImport";
import type { PlatformAlias, TaxoEntry } from "./smartSearch";
import { type Region, regionsOn, regionOf, isDefaultRegion, defaultRegionCode, regionByCode, regionBadgeHtml, displayTitle, splitTitleRegion, regionSortKey } from "./regions";

export interface ImportChoices {
  categoryId: string;
  inventoryTypeId: string;
  gradeCode: string;
  completenessCode: string;
  pricePct: number;
  /** New prices round UP to whole dollars ($19.37 → $20). */
  roundUp: boolean;
  /** The imported file's name. */
  fileName?: string;
  /** name|size|lastModified — with each row's contents, forms its import key. */
  fileKey?: string;
  /** Region for rows the sheet doesn't place (regions on only). */
  regionCode?: string;
}
export interface ImportDialogOpts {
  mode: "entry" | "trade";
  catalog: CatalogProduct[];
  completeness: TaxoEntry[];
  grades: TaxoEntry[];
  platforms: PlatformAlias[];
  categories: { id: string; name: string; default_completeness?: string | null }[];
  defaultCategoryId?: string;
  invTypes?: { id: string; name: string; icon?: string | null; key?: string }[];
  /** The store's regions (loadRegions); missing / [] = before the migration. */
  regions?: Region[];
  onImport: (rows: ResolvedRow[], choices: ImportChoices, progress: (msg: string) => void) => Promise<void>;
}

const CSS = `
.tli-overlay{position:fixed;inset:0;z-index:1000;background:rgba(0,0,0,.72);backdrop-filter:blur(4px);display:flex;align-items:flex-start;justify-content:center;padding:2.5vh 1rem;overflow:auto}
.tli-card{width:100%;max-width:1180px;max-height:95vh;display:flex;flex-direction:column;background:var(--panel,#14101d);border:1px solid var(--cyan,#2ce6e0);box-shadow:0 24px 60px rgba(0,0,0,.6)}
.tli-head{display:flex;align-items:center;gap:.8rem;padding:.8rem 1rem;border-bottom:1px solid var(--border,#333)}
.tli-head h3{margin:0;font-size:1.05rem}
.tli-head .tli-x{margin-left:auto}
.tli-body{padding:.9rem 1rem;overflow:auto;display:grid;grid-template-columns:minmax(0,1fr);gap:.9rem}
.tli-body>*{min-width:0}
.tli-drop{border:2px dashed var(--border-strong,#555);padding:1.6rem 1rem;text-align:center;cursor:pointer;color:var(--muted,#aaa)}
.tli-drop.over{border-color:var(--cyan,#2ce6e0);color:var(--cyan,#2ce6e0)}
.tli-drop strong{color:inherit}
.tli-drop input{display:none}
.tli-row{display:flex;gap:.8rem;flex-wrap:wrap;align-items:flex-end}
.tli-row label{display:flex;flex-direction:column;gap:.25rem;font-size:.74rem;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--muted-2,#999)}
.tli-row label select,.tli-row label input{font-size:.86rem;padding:.35rem .45rem;min-width:8rem;text-transform:none;letter-spacing:0}
.tli-row label.chk{flex-direction:row;align-items:center;gap:.4rem}
.tli-sec{font-size:.74rem;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:var(--muted-2,#999);margin:0}
.tli-map label{min-width:0}
.tli-map select{min-width:7rem}
.tli-map .req select{border-color:var(--cyan,#2ce6e0)}
.tli-table-wrap{overflow:auto;max-height:52vh;border:1px solid var(--border,#333)}
.tli-table{width:100%;border-collapse:collapse;font-size:.82rem}
.tli-table th,.tli-table td{padding:.35rem .5rem;border-bottom:1px solid var(--border,#333);text-align:left;vertical-align:middle;white-space:nowrap}
.tli-table th{position:sticky;top:0;background:var(--panel,#14101d);z-index:1;font-size:.7rem;text-transform:uppercase;letter-spacing:.06em;color:var(--muted-2,#999)}
.tli-table td.t{white-space:normal;min-width:14rem;font-weight:600}
.tli-table td.num{text-align:right;font-family:var(--font-mono,monospace)}
.tli-table tr.skip td{opacity:.4}
.tli-table tr.review td.t{color:var(--magenta,#ff49d0)}
.tli-table select{max-width:22rem;font-size:.8rem;padding:.25rem .35rem}
.tli-table select[data-cat]{max-width:9rem}
.tli-table .warn{cursor:help;color:var(--magenta,#ff49d0)}
.tli-pill{display:inline-block;padding:.1rem .45rem;font-size:.68rem;font-weight:700;border:1px solid var(--border-strong,#555);white-space:nowrap}
.tli-pill.ok{color:var(--green,#80ff72);border-color:rgba(128,255,114,.4)}
.tli-pill.cond{color:var(--cyan,#2ce6e0);border-color:rgba(44,230,224,.4)}
.tli-pill.new{color:#ffd166;border-color:rgba(255,209,102,.4)}
.tli-pill.rev{color:var(--magenta,#ff49d0);border-color:rgba(255,73,208,.4)}
.tli-fix{font-size:.72rem;font-weight:400;color:var(--muted,#aaa);margin-top:.15rem}
.tli-link{background:none;border:0;padding:0;color:var(--cyan,#2ce6e0);cursor:pointer;font-size:.72rem;text-decoration:underline}
.tli-pill.noninv{color:var(--muted,#aaa);border-color:var(--border-strong,#555)}
.tli-table label.tli-ni{display:inline-flex;align-items:center;gap:.25rem;font-size:.72rem;color:var(--muted,#aaa);margin-left:.35rem;cursor:pointer}
.tli-foot{display:flex;align-items:center;gap:1rem;flex-wrap:wrap;padding:.7rem 1rem;border-top:1px solid var(--border,#333)}
.tli-foot .tli-sum{font-size:.84rem;color:var(--muted,#aaa)}
.tli-foot .tli-sum strong{font-family:var(--font-mono,monospace)}
.tli-foot .tli-go{margin-left:auto}
.tli-note{font-size:.82rem;color:var(--muted,#aaa);margin:0}
.tli-err{color:var(--magenta,#ff49d0);font-size:.84rem}
.tli-muted{color:var(--muted-2,#999)}
`;

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[m] as string));
const money = (c: number) => (c / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });

/** A NEW listing/condition's price from the sheet: × the percentage, then
 *  (when on) rounded UP to whole dollars — $19.37 → $20, $20.00 stays. */
export function importPrice(sheetCents: number, ch: { pricePct: number; roundUp?: boolean }): number {
  const c = Math.round(sheetCents * ch.pricePct / 100);
  return ch.roundUp && c > 0 ? Math.ceil(c / 100) * 100 : c;
}

export function openImportDialog(o: ImportDialogOpts) {
  if (!document.getElementById("tli-css")) {
    const st = document.createElement("style"); st.id = "tli-css"; st.textContent = CSS; document.head.appendChild(st);
  }
  const prepared = prepareCatalog(o.catalog, o.platforms, o.regions);
  const rOn = regionsOn(o.regions);
  const regionName = (code: string) => { const g = regionByCode(code, o.regions); return g ? `${g.flag ? g.flag + " " : ""}${g.short}` : code; };
  const byId = new Map(o.catalog.map((p) => [p.id, p]));
  const compLabel = (code: string) => o.completeness.find((c) => c.code === code)?.label || code || "—";
  const gradeLabel = (code: string) => { const g = o.grades.find((x) => x.code === code); return g ? `${g.icon ? g.icon + " " : ""}${g.label}` : code; };
  const defaultCat = o.defaultCategoryId || o.categories.find((c) => /video game/i.test(c.name))?.id || o.categories[0]?.id || "";

  // ---- state ----
  let fileName = "";
  let fileKey = "";
  let records: string[][] = [];   // data rows (header removed when present)
  let header: string[] = [];
  let hasHeader = true;
  let map: ColumnMap = {};
  let resolved: ResolvedRow[] = [];
  let busy = false;
  let folderSel: string | null = null; // folder filter (null = every folder)
  let platformSel: string | null = null; // platform filter (null = every platform; "" = rows with none)
  let regionSel: string | null = null; // region filter (null = every region)
  // Official titles from the game database (LaunchBox copy) for rows that
  // would create a NEW listing — fixes sheet typos ("Links Aweakening").
  const titleFix = new Map<string, { name: string; sim: number } | null>(); // key: norm(title)|platform
  const keepSheet = new Set<number>(); // rows the employee reverted to the sheet's title
  let useOfficial = true;
  let fixInFlight = false;
  const fixKey = (row: ImportRow) => `${norm(row.title)}|${row.platform}`;
  const catPicks = new Map<number, string>(); // employee's per-row category picks (by source line)
  const regionPicks = new Map<number, string>(); // employee's per-row region picks for new listings (by source line)
  // Employee's per-row listing picks + skips (by source line). Persistent so a
  // folder switch or a re-match doesn't drop rows that aren't on screen.
  const picks = new Map<number, { productId: string; skip: boolean; nonInventory: boolean }>();
  let cleared = new Set<string>(); // columns the employee set to "—" for this header layout
  // Consoles / accessories / collectibles default to a matching category when the store has one.
  const findCat = (re: RegExp) => o.categories.find((c) => re.test(c.name))?.id || "";
  const kindCat: Record<string, string> = {
    console: findCat(/console|hardware|system/i),
    accessory: findCat(/accessor/i),
    collectible: findCat(/collect|amiibo|figure|toy/i),
  };
  const choices: ImportChoices = {
    categoryId: defaultCat,
    inventoryTypeId: o.invTypes?.find((t) => t.key === "retail")?.id || o.invTypes?.[0]?.id || "",
    gradeCode: o.grades.find((g) => g.code === "3")?.code || o.grades[0]?.code || "",
    completenessCode: "",
    pricePct: 100,
    regionCode: rOn ? defaultRegionCode(o.regions) : "",
    roundUp: (() => { try { return localStorage.getItem("tl-import-roundup") !== "0"; } catch { return true; } })(),
  };
  // Existing stock rows only count when they're the chosen inventory type
  // (entry mode) — a Personal Collection copy gets its own row, same listing.
  const typeFilter = () => (o.mode === "entry" ? choices.inventoryTypeId : "");
  const catDefaultComp = () => o.categories.find((c) => c.id === choices.categoryId)?.default_completeness || o.completeness.find((c) => c.code === "CIB")?.code || o.completeness[0]?.code || "";
  choices.completenessCode = catDefaultComp();

  // ---- DOM ----
  const overlay = document.createElement("div");
  overlay.className = "tli-overlay";
  overlay.innerHTML = `
    <div class="tli-card" role="dialog" aria-modal="true">
      <div class="tli-head">
        <h3>📄 Import collection ${o.mode === "entry" ? "→ this entry" : "→ buy ticket"}</h3>
        <span class="tli-muted" id="tli-file"></span>
        <button class="btn btn-ghost btn-sm tli-x" type="button" id="tli-close">✕</button>
      </div>
      <div class="tli-body">
        <div class="tli-drop" id="tli-drop">
          <input type="file" id="tli-input" accept=".csv,.tsv,.txt,text/csv" />
          <strong>Drop a .csv here</strong> or click to choose · PriceCharting “export collection” files, or any sheet with Title / Platform / Condition columns
        </div>
        <div id="tli-map-wrap" hidden>
          <p class="tli-sec">Columns</p>
          <div class="tli-row tli-map" id="tli-map"></div>
        </div>
        <div id="tli-defaults" hidden>
          <p class="tli-sec">Defaults for new listings</p>
          <div class="tli-row" id="tli-def"></div>
        </div>
        <div id="tli-preview" hidden>
          <div class="tli-row" style="align-items:center;justify-content:space-between;">
            <p class="tli-sec" style="margin:0;">Preview — check the <em>Match</em> column, fix anything in magenta</p>
            <label class="chk" style="text-transform:none;letter-spacing:0;font-weight:600;"><input type="checkbox" id="tli-only-review" /> Only rows needing review</label>
          </div>
          <div class="tli-table-wrap"><table class="tli-table" id="tli-table"></table></div>
        </div>
        <div class="tli-err" id="tli-err" hidden></div>
      </div>
      <div class="tli-foot">
        <span class="tli-sum" id="tli-sum">Choose a file to begin.</span>
        <button class="btn btn-primary btn-sm tli-go" type="button" id="tli-go" disabled>Import</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  const $ = <T extends HTMLElement = HTMLElement>(id: string) => overlay.querySelector<T>("#" + id)!;
  const close = () => { if (busy) return; overlay.remove(); document.removeEventListener("keydown", onKey); };
  const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
  document.addEventListener("keydown", onKey);
  $("tli-close").addEventListener("click", close);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });

  // ---- file ----
  const drop = $("tli-drop");
  const input = $<HTMLInputElement>("tli-input");
  drop.addEventListener("click", () => input.click());
  drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("over"); });
  drop.addEventListener("dragleave", () => drop.classList.remove("over"));
  // No new file while an import is running — it would swap the rows out from
  // under the batches still being staged.
  drop.addEventListener("drop", (e) => { e.preventDefault(); drop.classList.remove("over"); const f = e.dataTransfer?.files?.[0]; if (f && !busy) loadFile(f); });
  // Clear the picker after reading, so choosing the same (edited) file again
  // reloads it — browsers only fire "change" when the selection differs.
  input.addEventListener("change", () => { const f = input.files?.[0]; input.value = ""; if (f && !busy) loadFile(f); });

  async function loadFile(f: File) {
    const text = await f.text();
    const all = parseDelimited(text);
    if (!all.length) { showErr("That file is empty."); return; }
    fileName = f.name;
    fileKey = `${f.name}|${f.size}|${f.lastModified}`;
    $("tli-file").textContent = `${f.name} · ${all.length} rows`;
    hasHeader = looksLikeHeader(all[0]);
    header = hasHeader ? all[0] : all[0].map((_, i) => `Column ${i + 1}`);
    records = hasHeader ? all.slice(1) : all;
    map = mapFor(all[0]);
    folderSel = null; platformSel = null; regionSel = null;
    // A new file: row numbers mean different games now.
    resolved = []; picks.clear(); catPicks.clear(); regionPicks.clear(); keepSheet.clear();
    if (map.title == null) showErr("Couldn't find a Title column — pick it under Columns."); else showErr("");
    renderMap(); renderDefaults(); rebuild();
  }
  // Auto-detect, unless the employee corrected this exact header layout before.
  function mapFor(first: string[]): ColumnMap {
    if (!hasHeader) return { title: 0, platform: 1, condition: 2 };
    let m = detectColumns(first);
    cleared = new Set();
    try {
      const saved = JSON.parse(localStorage.getItem("tl-import-map:" + headerSignature(first)) || "null");
      // Saved corrections win; columns the detector learned since still fill
      // in — except ones the employee explicitly cleared.
      if (saved && typeof saved === "object") {
        const { __cleared, ...cols } = saved as any;
        m = { ...m, ...cols };
        cleared = new Set(Array.isArray(__cleared) ? __cleared : []);
        for (const k of cleared) delete (m as any)[k];
      }
    } catch {}
    return m;
  }
  function showErr(msg: string) { const el = $("tli-err"); el.textContent = msg; el.hidden = !msg; }

  // ---- column mapping ----
  function renderMap() {
    const wrap = $("tli-map-wrap"); wrap.hidden = false;
    const opts = (sel: number | undefined) => `<option value="">—</option>` + header.map((h, i) => `<option value="${i}"${sel === i ? " selected" : ""}>${esc(h || `Column ${i + 1}`)}</option>`).join("");
    // No Region column before the regions migration (nowhere to keep it).
    const shown = COLUMN_DEFS.filter((d) => (o.mode === "entry" || !["cost"].includes(d.key)) && (rOn || d.key !== "region"));
    $("tli-map").innerHTML = shown.map((d) => `<label class="${d.required ? "req" : ""}">${esc(d.label)}${d.required ? " *" : ""}<select data-col="${d.key}">${opts(map[d.key])}</select></label>`).join("")
      + `<label class="chk" style="text-transform:none;letter-spacing:0;font-weight:600;"><input type="checkbox" id="tli-hdr" ${hasHeader ? "checked" : ""}/> First row is a header</label>`;
    $("tli-map").querySelectorAll<HTMLSelectElement>("select[data-col]").forEach((s) => s.addEventListener("change", () => {
      const k = s.dataset.col as ColumnKey;
      if (s.value === "") { delete map[k]; cleared.add(k); } else { map[k] = +s.value; cleared.delete(k); }
      try { localStorage.setItem("tl-import-map:" + headerSignature(header), JSON.stringify({ ...map, __cleared: [...cleared] })); } catch {}
      showErr(map.title == null ? "Couldn't find a Title column — pick it under Columns." : "");
      if (k === "folder") { folderSel = null; renderDefaults(); }
      if (k === "platform") platformSel = null;
      if (k === "region" || k === "platform" || k === "title") regionSel = null;
      rebuild();
    }));
    $<HTMLInputElement>("tli-hdr").addEventListener("change", (e) => {
      const on = (e.target as HTMLInputElement).checked;
      // Re-split the same file with/without a header row.
      const all = hasHeader ? [header, ...records] : records;
      hasHeader = on;
      header = on ? all[0] : all[0].map((_, i) => `Column ${i + 1}`);
      records = on ? all.slice(1) : all;
      map = mapFor(all[0]);
      folderSel = null; platformSel = null; regionSel = null;
      resolved = []; picks.clear(); catPicks.clear(); regionPicks.clear(); keepSheet.clear(); // row numbers shift by one
      renderMap(); renderDefaults(); rebuild();
    });
  }

  // ---- defaults ----
  function renderDefaults() {
    const wrap = $("tli-defaults"); wrap.hidden = false;
    const sel = (id: string, label: string, options: string, extra = "") => `<label>${label}<select id="${id}" ${extra}>${options}</select></label>`;
    let html = "";
    if (map.folder != null) {
      // PriceCharting collections are split into folders — import one at a time.
      const counts = new Map<string, number>();
      for (const r of records) { const f = String(r[map.folder] ?? "").trim(); counts.set(f, (counts.get(f) || 0) + 1); }
      const names = [...counts.keys()].sort((a, b) => (a === "" ? 1 : b === "" ? -1 : a.localeCompare(b)));
      html += sel("tli-folder", "Folder", `<option value="*"${folderSel == null ? " selected" : ""}>All folders (${records.length})</option>`
        + names.map((f) => `<option value="${esc(f)}"${folderSel === f ? " selected" : ""}>${esc(f || "(no folder)")} (${counts.get(f)})</option>`).join(""));
    }
    // Filled by rebuild(): the platforms / regions in the rows shown (after the folder).
    html += `<span id="tli-plat-slot" style="display:contents"></span><span id="tli-region-slot" style="display:contents"></span>`;
    html += sel("tli-cat", "Category", o.categories.map((c) => `<option value="${c.id}"${c.id === choices.categoryId ? " selected" : ""}>${esc(c.name)}</option>`).join(""));
    if (o.mode === "entry" && o.invTypes?.length) {
      html += sel("tli-type", "Inventory type", o.invTypes.map((t) => `<option value="${t.id}"${t.id === choices.inventoryTypeId ? " selected" : ""}>${esc((t.icon ? t.icon + " " : "") + t.name)}</option>`).join(""));
    }
    html += sel("tli-comp", "Condition when blank", o.completeness.map((c) => `<option value="${c.code}"${c.code === choices.completenessCode ? " selected" : ""}>${esc(c.label)}</option>`).join(""));
    html += sel("tli-grade", "Grade when blank", o.grades.map((g) => `<option value="${g.code}"${g.code === choices.gradeCode ? " selected" : ""}>${esc(gradeLabel(g.code))}</option>`).join(""));
    // A whole lot bought in Japan: every row the sheet doesn't place is JP.
    if (rOn) html += sel("tli-region", "Region when blank", o.regions!.filter((g) => g.isActive || g.code === choices.regionCode)
      .map((g) => `<option value="${esc(g.code)}"${g.code === choices.regionCode ? " selected" : ""}>${esc(`${g.flag ? g.flag + " " : ""}${g.name}`)}</option>`).join(""), `title="Used when the sheet has no Region column and the platform / title don't name one"`);
    if (o.mode === "entry") html += `<label>Price = sheet value ×<input id="tli-pct" type="number" min="1" max="500" step="1" value="${choices.pricePct}" style="width:5.5rem;" /></label>`
      + `<label class="chk" style="text-transform:none;letter-spacing:0;font-weight:600;" title="$19.37 → $20 — whole dollars, no change"><input type="checkbox" id="tli-round" ${choices.roundUp ? "checked" : ""}/> Round prices up to whole dollars</label>`;
    html += `<label class="chk" style="text-transform:none;letter-spacing:0;font-weight:600;" title="New listings take the game's official name from the game database — fixes typos in the sheet. The sheet's own title stays searchable."><input type="checkbox" id="tli-official" ${useOfficial ? "checked" : ""}/> Use official game titles</label>`;
    $("tli-def").innerHTML = html + `<span class="tli-note">Existing listings keep their own price; these only shape <em>new</em> ones.${o.mode === "entry" && o.invTypes?.length ? " A copy of a different inventory type gets its own stock row on the same listing." : ""}</span>`;
    overlay.querySelector<HTMLSelectElement>("#tli-folder")?.addEventListener("change", (e) => { const v = (e.target as HTMLSelectElement).value; folderSel = v === "*" ? null : v; rebuild(); });
    overlay.querySelector<HTMLInputElement>("#tli-official")?.addEventListener("change", (e) => { useOfficial = (e.target as HTMLInputElement).checked; rebuild(); });
    $<HTMLSelectElement>("tli-cat").addEventListener("change", (e) => { choices.categoryId = (e.target as HTMLSelectElement).value; choices.completenessCode = catDefaultComp(); const c = overlay.querySelector<HTMLSelectElement>("#tli-comp"); if (c) c.value = choices.completenessCode; rebuild(); });
    overlay.querySelector<HTMLSelectElement>("#tli-type")?.addEventListener("change", (e) => { choices.inventoryTypeId = (e.target as HTMLSelectElement).value; rebuild(); });
    $<HTMLSelectElement>("tli-comp").addEventListener("change", (e) => { choices.completenessCode = (e.target as HTMLSelectElement).value; rebuild(); });
    $<HTMLSelectElement>("tli-grade").addEventListener("change", (e) => { choices.gradeCode = (e.target as HTMLSelectElement).value; rebuild(); });
    overlay.querySelector<HTMLSelectElement>("#tli-region")?.addEventListener("change", (e) => { choices.regionCode = (e.target as HTMLSelectElement).value; rebuild(); });
    overlay.querySelector<HTMLInputElement>("#tli-pct")?.addEventListener("change", (e) => { choices.pricePct = Math.max(1, Math.min(500, Math.round(+(e.target as HTMLInputElement).value) || 100)); renderTable(); });
    overlay.querySelector<HTMLInputElement>("#tli-round")?.addEventListener("change", (e) => {
      choices.roundUp = (e.target as HTMLInputElement).checked;
      try { localStorage.setItem("tl-import-roundup", choices.roundUp ? "1" : "0"); } catch { /* private mode */ }
      renderTable();
    });
  }

  function renderPlatformFilter(counts: Map<string, number>, total: number) {
    const slot = overlay.querySelector<HTMLElement>("#tli-plat-slot");
    if (!slot) return;
    if (map.platform == null || counts.size < 2) { slot.innerHTML = ""; return; }
    const names = [...counts.keys()].sort((a, b) => (a === "" ? 1 : b === "" ? -1 : a.localeCompare(b)));
    slot.innerHTML = `<label>Platform<select id="tli-plat"><option value="*"${platformSel == null ? " selected" : ""}>All platforms (${total})</option>`
      + names.map((p) => `<option value="${esc(p)}"${platformSel === p ? " selected" : ""}>${esc(p || "(no platform)")} (${counts.get(p)})</option>`).join("")
      + `</select></label>`;
    slot.querySelector<HTMLSelectElement>("#tli-plat")!.addEventListener("change", (e) => { const v = (e.target as HTMLSelectElement).value; platformSel = v === "*" ? null : v; rebuild(); });
  }
  // Region filter — import one market at a time (only when the rows hold 2+).
  function renderRegionFilter(counts: Map<string, number>, total: number) {
    const slot = overlay.querySelector<HTMLElement>("#tli-region-slot");
    if (!slot) return;
    if (!rOn || counts.size < 2) { slot.innerHTML = ""; return; }
    const codes = [...counts.keys()].sort((a, b) => regionSortKey(a, o.regions) - regionSortKey(b, o.regions));
    slot.innerHTML = `<label>Region<select id="tli-rgn"><option value="*"${regionSel == null ? " selected" : ""}>All regions (${total})</option>`
      + codes.map((c) => `<option value="${esc(c)}"${regionSel === c ? " selected" : ""} title="${esc(regionByCode(c, o.regions)?.name || c)}">${esc(regionName(c))} (${counts.get(c)})</option>`).join("")
      + `</select></label>`;
    slot.querySelector<HTMLSelectElement>("#tli-rgn")!.addEventListener("change", (e) => { const v = (e.target as HTMLSelectElement).value; regionSel = v === "*" ? null : v; rebuild(); });
  }

  // ---- rows + matching ----
  function rebuild() {
    if (map.title == null) { resolved = []; renderTable(); return; }
    // Changing a default re-matches everything — keep the employee's picks and
    // skips (keyed by source line) instead of silently resetting them. Fold in
    // the rows on screen first (incl. rows the caller marked staged/skipped).
    for (const r of resolved) {
      const nonInv = !!r.nonInventory;
      if (r.product?.id !== r.match.product?.id || r.skip || nonInv !== defaultNonInv(r.row)) picks.set(r.row.n, { productId: r.product?.id ?? "", skip: r.skip, nonInventory: nonInv });
      else picks.delete(r.row.n);
    }
    const rows: ImportRow[] = buildRows(records, rOn ? map : { ...map, region: undefined }, {
      completeness: o.completeness, grades: o.grades, platforms: o.platforms,
      defaultCompleteness: choices.completenessCode, defaultGrade: choices.gradeCode,
      cents: centsColumns(header, map), folder: map.folder != null ? folderSel : null,
      regions: o.regions, defaultRegion: choices.regionCode,
    });
    // The employee's per-row region picks (a new listing whose sheet row was wrong).
    for (const r of rows) { const g = regionPicks.get(r.n); if (g) r.region = g; }
    // Platform filter — import one console at a time ("Nintendo DS only").
    const platCounts = new Map<string, number>();
    for (const r of rows) platCounts.set(r.platform || "", (platCounts.get(r.platform || "") || 0) + 1);
    if (platformSel != null && !platCounts.has(platformSel)) platformSel = null;
    renderPlatformFilter(platCounts, rows.length);
    const onPlat = platformSel == null ? rows : rows.filter((r) => (r.platform || "") === platformSel);
    // Region filter — the regions in the rows on that platform.
    const rgnCounts = new Map<string, number>();
    for (const r of onPlat) rgnCounts.set(r.region, (rgnCounts.get(r.region) || 0) + 1);
    if (regionSel != null && !rgnCounts.has(regionSel)) regionSel = null;
    renderRegionFilter(rgnCounts, onPlat.length);
    const shown = regionSel == null ? onPlat : onPlat.filter((r) => r.region === regionSel);
    const wanted: ImportRow[] = [];
    resolved = shown.map((row0) => {
      let row = row0;
      let match = matchRow(row, prepared, o.platforms, typeFilter(), o.regions);
      // A row that would create a NEW listing takes the game's official title
      // (then re-matches — the typo may have been hiding an existing listing).
      // Not an import's: the database's names are the North American ones.
      const isNewListing = match.status === "new-product" || match.status === "review";
      if (useOfficial && isNewListing && !row.kind && !row.lot && !keepSheet.has(row.n) && isDefaultRegion(row.region, o.regions)) {
        if (!titleFix.has(fixKey(row))) wanted.push(row);
        const fixed = officialTitleFor(row.title, titleFix.get(fixKey(row)), row.platform);
        if (fixed) {
          // The sheet's title stays searchable (alternative names) — without a region tag.
          row = { ...row, title: fixed, titleFrom: splitTitleRegion(row.title, o.regions).title };
          match = matchRow(row, prepared, o.platforms, typeFilter(), o.regions);
        }
      }
      const hint = row.kind ? kindCat[row.kind] : "";
      if (row.kind === "console" && !hint) row.warnings.push("Looks like a console/handheld — pick its category (no Consoles category found)");
      const r: ResolvedRow = { row, match, product: match.product, variant: match.variant, skip: false, categoryId: catPicks.get(row.n) ?? hint, nonInventory: defaultNonInv(row) };
      const k = picks.get(row.n);
      if (k) { chooseProduct(r, k.productId ? byId.get(k.productId) || null : null, typeFilter()); r.skip = k.skip; r.nonInventory = k.nonInventory; }
      return r;
    });
    renderTable();
    if (wanted.length) lookupOfficialTitles(wanted);
  }
  // Ask the server for the closest official title of each new-listing row
  // (batched), then re-run the matching with the answers.
  async function lookupOfficialTitles(rows: ImportRow[]) {
    if (fixInFlight) return;
    fixInFlight = true;
    if (useOfficial) { const go = $("tli-go") as HTMLButtonElement; go.disabled = true; go.textContent = "Checking titles…"; }
    const uniq = [...new Map(rows.map((r) => [fixKey(r), r])).values()];
    try {
      for (let i = 0; i < uniq.length; i += 200) {
        const chunk = uniq.slice(i, i + 200);
        if (useOfficial) $("tli-sum").textContent = `Checking titles against the game database… ${Math.min(i + 200, uniq.length)}/${uniq.length}`;
        let results: any[] = [];
        try {
          const r = await fetch("/api/pos/title-fix", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ items: chunk.map((x) => ({ title: x.title, platform: x.platform })) }) });
          results = (await r.json()).results || [];
        } catch { /* offline → keep sheet titles */ }
        chunk.forEach((x, k) => titleFix.set(fixKey(x), results[k] ?? null));
      }
    } finally { fixInFlight = false; }
    // Never swap the rows out from under an import that's running.
    if (busy) { rebuildAfterImport = true; return; }
    rebuild();
  }
  let rebuildAfterImport = false;

  // Entry imports: a lot ("Bulk …") defaults to non-inventory — money recorded, no stock.
  const defaultNonInv = (row: ImportRow) => o.mode === "entry" && row.lot;
  // Rounding is an entry option (the checkbox only shows there); trade-in values stay exact.
  const newPrice = (r: ResolvedRow) => r.row.priceCents == null ? null : importPrice(r.row.priceCents, o.mode === "entry" ? choices : { ...choices, roundUp: false });

  // A brand-new game's 2nd+ condition (Loose after CIB) lands on the SAME new
  // listing as its first row — the caller groups them the same way.
  // follower → the source line of the row that creates the listing.
  function followerRows(): Map<ResolvedRow, number> {
    const lead = new Map<string, number>(), out = new Map<ResolvedRow, number>();
    for (const r of resolved) {
      if (r.skip || r.product || r.nonInventory) continue;
      const k = newListingKey(r.row);
      if (lead.has(k)) out.set(r, lead.get(k)!); else lead.set(k, r.row.n);
    }
    return out;
  }
  function statusOf(r: ResolvedRow, followers: Map<ResolvedRow, number>): { cls: string; text: string } {
    if (r.nonInventory) return { cls: "noninv", text: "🧾 non-inventory" };
    if (followers.has(r)) return { cls: "cond", text: "+ condition (same new listing)" };
    if (r.product && r.variant) return { cls: "ok", text: "existing" };
    if (r.product) {
      // Same condition already on the listing, but another inventory type → its own row.
      const sameCond = r.product.variants.some((v) => (v.completenessCode || "") === (r.row.completenessCode || ""));
      return { cls: "cond", text: sameCond ? "+ own stock row" : "+ condition" };
    }
    if (r.match.status === "review") return { cls: "rev", text: "review" };
    return { cls: "new", text: "new listing" };
  }

  let syncAllBox = () => {}; // keeps the header select-all box in step with row toggles
  function renderTable() {
    const wrap = $("tli-preview"); wrap.hidden = !resolved.length;
    const onlyReview = $<HTMLInputElement>("tli-only-review").checked;
    const entry = o.mode === "entry";
    const pcCol = map.pcValue != null;
    const head = `<tr><th><input type="checkbox" id="tli-all" title="Select / unselect every row shown" aria-label="Select all rows" /></th><th>#</th><th>Title</th><th>Platform</th><th>Condition</th><th class="num">Qty</th><th class="num">${entry ? "Sheet value" : "Resale"}</th>${pcCol ? `<th class="num" title="PriceCharting / market value from the sheet">PC value</th>` : ""}${entry ? `<th class="num">Paid</th>` : ""}<th>Match</th>${entry ? `<th class="num">Price</th>` : ""}</tr>`;
    const catOpts = (sel: string) => o.categories.map((c) => `<option value="${c.id}"${c.id === sel ? " selected" : ""}>${esc(c.name)}</option>`).join("");
    const followers = followerRows();
    const body = resolved.map((r, i) => {
      const st = statusOf(r, followers);
      if (onlyReview && !(st.cls === "rev" || r.row.warnings.length)) return "";
      const cands = r.match.candidates;
      // Option text can't hold a badge: "Okami HD [JP] · Nintendo Switch".
      const optTitle = (p: CatalogProduct) => esc(displayTitle(p.title, p.regionCode, o.regions));
      const opts = [`<option value=""${!r.product ? " selected" : ""}>＋ New listing</option>`]
        .concat(cands.map((c) => `<option value="${c.product.id}"${r.product?.id === c.product.id ? " selected" : ""}>${optTitle(c.product)} · ${esc(c.product.platform || "?")} (${Math.round(c.score * 100)}%)</option>`));
      if (r.product && !cands.some((c) => c.product.id === r.product!.id)) opts.push(`<option value="${r.product.id}" selected>${optTitle(r.product)} · ${esc(r.product.platform || "?")}</option>`);
      // A PAL copy put on the US listing (or the other way round) is a different release.
      const rowRg = regionOf(r.row.region, o.regions);
      const prodRg = r.product ? regionOf(r.product.regionCode, o.regions) : rowRg;
      const rgWarn = rOn && !r.nonInventory && prodRg !== rowRg
        ? ` <span class="warn" title="This row is a ${esc(regionByCode(rowRg, o.regions)?.name || rowRg)} copy, but the chosen listing is ${esc(regionByCode(prodRg, o.regions)?.name || prodRg)} — a different release (own UPC / price). Pick “＋ New listing” unless the sheet's region is wrong.">⚠ ${esc(regionName(rowRg))} copy → ${esc(regionName(prodRg))} listing</span>` : "";
      // New listing: its region, editable (like its category).
      const rgPick = rOn && !r.product && !r.nonInventory && !followers.has(r)
        ? ` <select data-region title="Region of this new listing">${o.regions!.filter((g) => g.isActive || g.code === rowRg).map((g) => `<option value="${esc(g.code)}"${g.code === rowRg ? " selected" : ""}>${esc(regionName(g.code))}</option>`).join("")}</select>` : "";
      const cond = [compLabel(r.row.completenessCode), r.row.gradeCode ? gradeLabel(r.row.gradeCode) : ""].filter(Boolean).join(" · ");
      const badge = regionBadgeHtml(r.row.region, o.regions) ? " " + regionBadgeHtml(r.row.region, o.regions) : "";
      const warn = r.row.warnings.length ? ` <span class="warn" title="${esc(r.row.warnings.join("\n"))}">⚠</span>` : "";
      const price = entry ? (r.variant ? `<span class="tli-muted" title="Existing listing keeps its price">${money(r.variant.priceCents)}</span>` : newPrice(r) == null ? `<span class="warn" title="No value in the sheet — set the price on the entry screen">—</span>` : money(newPrice(r)!)) : "";
      return `<tr data-i="${i}" class="${r.skip ? "skip" : ""} ${st.cls === "rev" ? "review" : ""}">
        <td><input type="checkbox" data-keep ${r.skip ? "" : "checked"} title="Uncheck to skip this row" /></td>
        <td class="tli-muted">${r.row.n}</td>
        <td class="t">${esc(r.row.title)}${badge}${warn}${r.row.titleFrom ? `<div class="tli-fix" title="Official title from the game database — the sheet said “${esc(r.row.titleFrom)}” (kept as a search name)">✎ sheet: “${esc(r.row.titleFrom)}” <button type="button" class="tli-link" data-keeptitle>keep sheet title</button></div>` : ""}</td>
        <td>${esc(r.row.platform || "—")}${r.row.platformRaw && !r.row.platformResolved ? ` <span class="warn" title="Platform not recognized">?</span>` : ""}</td>
        <td>${esc(cond)}</td>
        <td class="num">${r.row.qty}</td>
        <td class="num">${r.row.priceCents == null ? "—" : money(r.row.priceCents)}</td>
        ${pcCol ? `<td class="num tli-muted">${r.row.pcValueCents == null ? "—" : money(r.row.pcValueCents)}</td>` : ""}
        ${entry ? `<td class="num">${r.row.costCents == null ? "—" : money(r.row.costCents)}</td>` : ""}
        <td>${r.nonInventory ? "" : `<select data-pick>${opts.join("")}</select> `}<span class="tli-pill ${st.cls}">${st.text}</span>${rgWarn}${rgPick}${r.nonInventory ? "" : followers.has(r) ? ` <span class="tli-muted" title="This condition is added to the listing row ${followers.get(r)} creates — set the category there">category: row ${followers.get(r)}</span>` : !r.product ? ` <select data-cat title="Category for this new listing">${catOpts(r.categoryId || choices.categoryId)}</select>` : ""}${entry ? `<label class="tli-ni" title="Non-inventory: record what was paid on the entry, but create no listing or stock (bulk lots, parts)"><input type="checkbox" data-noninv${r.nonInventory ? " checked" : ""} /> non-inv</label>` : ""}</td>
        ${entry ? `<td class="num">${price}</td>` : ""}
      </tr>`;
    }).join("");
    $("tli-table").innerHTML = head + body;
    // Header box: every row SHOWN (respects "only rows needing review").
    const shown = resolved.filter((r) => !onlyReview || statusOf(r, followers).cls === "rev" || r.row.warnings.length);
    const allBox = overlay.querySelector<HTMLInputElement>("#tli-all")!;
    syncAllBox = () => {
      allBox.checked = shown.length > 0 && shown.every((r) => !r.skip);
      allBox.indeterminate = !allBox.checked && shown.some((r) => !r.skip);
    };
    syncAllBox();
    allBox.addEventListener("change", () => { shown.forEach((r) => (r.skip = !allBox.checked)); renderTable(); });
    $("tli-table").querySelectorAll<HTMLElement>("tr[data-i]").forEach((tr) => {
      const r = resolved[+tr.dataset.i!];
      tr.querySelector<HTMLInputElement>("[data-keep]")!.addEventListener("change", (e) => {
        r.skip = !(e.target as HTMLInputElement).checked;
        // Skipping a new game's first row makes its next condition the one that creates the listing.
        if (!r.product) renderTable(); else { tr.classList.toggle("skip", r.skip); summary(); syncAllBox(); }
      });
      tr.querySelector<HTMLInputElement>("[data-noninv]")?.addEventListener("change", (e) => { r.nonInventory = (e.target as HTMLInputElement).checked; renderTable(); });
      tr.querySelector<HTMLButtonElement>("[data-keeptitle]")?.addEventListener("click", () => { keepSheet.add(r.row.n); rebuild(); });
      tr.querySelector<HTMLSelectElement>("[data-pick]")?.addEventListener("change", (e) => {
        const id = (e.target as HTMLSelectElement).value;
        chooseProduct(r, id ? byId.get(id) || null : null, typeFilter());
        renderTable();
      });
      tr.querySelector<HTMLSelectElement>("[data-cat]")?.addEventListener("change", (e) => {
        r.categoryId = (e.target as HTMLSelectElement).value;
        catPicks.set(r.row.n, r.categoryId);
      });
      // Another region = another listing: re-match (it may exist already).
      tr.querySelector<HTMLSelectElement>("[data-region]")?.addEventListener("change", (e) => {
        regionPicks.set(r.row.n, (e.target as HTMLSelectElement).value);
        rebuild();
      });
    });
    summary();
  }
  $<HTMLInputElement>("tli-only-review").addEventListener("change", renderTable);

  function summary() {
    const live = resolved.filter((r) => !r.skip);
    const n = { ex: 0, cond: 0, nw: 0, rev: 0, units: 0, ni: 0 };
    const followers = followerRows();
    for (const r of live) {
      const s = statusOf(r, followers).cls;
      if (s === "noninv") { n.ni++; continue; }
      n.units += r.row.qty;
      if (s === "ok") n.ex++; else if (s === "cond") n.cond++; else if (s === "rev") n.rev++; else n.nw++;
    }
    const nopl = live.filter((r) => !r.row.platform).length;
    const totals = map.title == null ? 0 : records.filter((rec) => isSummaryRow(String(rec[map.title!] ?? ""), map.platform == null ? "" : String(rec[map.platform] ?? ""))).length;
    $("tli-sum").innerHTML = live.length
      ? `<strong>${live.length}</strong> lines · <strong>${n.units}</strong> units — <strong>${n.ex}</strong> existing · <strong>${n.cond}</strong> new conditions · <strong>${n.nw + n.rev}</strong> new listings${n.rev ? ` (<strong style="color:var(--magenta)">${n.rev}</strong> need review)` : ""}${n.ni ? ` · <strong>${n.ni}</strong> non-inventory (recorded, no stock)` : ""}${live.some((r) => r.row.titleFrom) ? ` · ✎ <strong>${live.filter((r) => r.row.titleFrom).length}</strong> title${live.filter((r) => r.row.titleFrom).length === 1 ? "" : "s"} corrected` : ""}${nopl ? ` · <span class="warn">${nopl} without a platform</span>` : ""}${totals ? ` · <span class="tli-muted">${totals} totals row${totals === 1 ? "" : "s"} skipped</span>` : ""}`
      : (resolved.length ? "Every row is skipped." : "Choose a file to begin.");
    // Wait for the official-title check — importing now would keep the typos
    // (unless official titles are switched off).
    const waiting = useOfficial && fixInFlight;
    ($("tli-go") as HTMLButtonElement).disabled = !live.length || busy || waiting;
    $("tli-go").textContent = waiting ? "Checking titles…" : live.length ? `Import ${live.length} line${live.length === 1 ? "" : "s"}` : "Import";
  }

  $("tli-go").addEventListener("click", async () => {
    const live = resolved.filter((r) => !r.skip);
    if (!live.length || busy) return;
    busy = true;
    const btn = $("tli-go") as HTMLButtonElement; btn.disabled = true;
    overlay.querySelectorAll<HTMLElement>("select, input, button").forEach((el) => { if (el.id !== "tli-go") (el as any).disabled = true; });
    const progress = (m: string) => { $("tli-sum").textContent = m; };
    try {
      await o.onImport(live, { ...choices, fileName, fileKey }, progress);
      busy = false; close();
    } catch (e: any) {
      // The caller marks rows it already staged as skipped, so a retry only
      // sends what failed — re-render so the checkboxes show that.
      busy = false;
      if (rebuildAfterImport) { rebuildAfterImport = false; rebuild(); }
      showErr((e?.message || "Import failed") + " Rows confirmed as imported are unchecked.");
      overlay.querySelectorAll<HTMLElement>("select, input, button").forEach((el) => { (el as any).disabled = false; });
      renderTable();
    }
  });
}
