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
  buildRows, prepareCatalog, matchRow, chooseProduct, centsColumns, isSummaryRow, newListingKey,
  type CatalogProduct, type ImportRow, type ResolvedRow,
} from "./collectionImport";
import type { PlatformAlias, TaxoEntry } from "./smartSearch";

export interface ImportChoices {
  categoryId: string;
  inventoryTypeId: string;
  gradeCode: string;
  completenessCode: string;
  pricePct: number;
  /** The imported file's name. */
  fileName?: string;
  /** name|size|lastModified — with each row's contents, forms its import key. */
  fileKey?: string;
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

export function openImportDialog(o: ImportDialogOpts) {
  if (!document.getElementById("tli-css")) {
    const st = document.createElement("style"); st.id = "tli-css"; st.textContent = CSS; document.head.appendChild(st);
  }
  const prepared = prepareCatalog(o.catalog, o.platforms);
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
  const catPicks = new Map<number, string>(); // employee's per-row category picks (by source line)
  // Employee's per-row listing picks + skips (by source line). Persistent so a
  // folder switch or a re-match doesn't drop rows that aren't on screen.
  const picks = new Map<number, { productId: string; skip: boolean }>();
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
    folderSel = null;
    // A new file: row numbers mean different games now.
    resolved = []; picks.clear(); catPicks.clear();
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
    const shown = COLUMN_DEFS.filter((d) => o.mode === "entry" || !["cost"].includes(d.key));
    $("tli-map").innerHTML = shown.map((d) => `<label class="${d.required ? "req" : ""}">${esc(d.label)}${d.required ? " *" : ""}<select data-col="${d.key}">${opts(map[d.key])}</select></label>`).join("")
      + `<label class="chk" style="text-transform:none;letter-spacing:0;font-weight:600;"><input type="checkbox" id="tli-hdr" ${hasHeader ? "checked" : ""}/> First row is a header</label>`;
    $("tli-map").querySelectorAll<HTMLSelectElement>("select[data-col]").forEach((s) => s.addEventListener("change", () => {
      const k = s.dataset.col as ColumnKey;
      if (s.value === "") { delete map[k]; cleared.add(k); } else { map[k] = +s.value; cleared.delete(k); }
      try { localStorage.setItem("tl-import-map:" + headerSignature(header), JSON.stringify({ ...map, __cleared: [...cleared] })); } catch {}
      showErr(map.title == null ? "Couldn't find a Title column — pick it under Columns." : "");
      if (k === "folder") { folderSel = null; renderDefaults(); }
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
      folderSel = null;
      resolved = []; picks.clear(); catPicks.clear(); // row numbers shift by one
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
    html += sel("tli-cat", "Category", o.categories.map((c) => `<option value="${c.id}"${c.id === choices.categoryId ? " selected" : ""}>${esc(c.name)}</option>`).join(""));
    if (o.mode === "entry" && o.invTypes?.length) {
      html += sel("tli-type", "Inventory type", o.invTypes.map((t) => `<option value="${t.id}"${t.id === choices.inventoryTypeId ? " selected" : ""}>${esc((t.icon ? t.icon + " " : "") + t.name)}</option>`).join(""));
    }
    html += sel("tli-comp", "Condition when blank", o.completeness.map((c) => `<option value="${c.code}"${c.code === choices.completenessCode ? " selected" : ""}>${esc(c.label)}</option>`).join(""));
    html += sel("tli-grade", "Grade when blank", o.grades.map((g) => `<option value="${g.code}"${g.code === choices.gradeCode ? " selected" : ""}>${esc(gradeLabel(g.code))}</option>`).join(""));
    if (o.mode === "entry") html += `<label>Price = sheet value ×<input id="tli-pct" type="number" min="1" max="500" step="1" value="${choices.pricePct}" style="width:5.5rem;" /></label>`;
    $("tli-def").innerHTML = html + `<span class="tli-note">Existing listings keep their own price; these only shape <em>new</em> ones.${o.mode === "entry" && o.invTypes?.length ? " A copy of a different inventory type gets its own stock row on the same listing." : ""}</span>`;
    overlay.querySelector<HTMLSelectElement>("#tli-folder")?.addEventListener("change", (e) => { const v = (e.target as HTMLSelectElement).value; folderSel = v === "*" ? null : v; rebuild(); });
    $<HTMLSelectElement>("tli-cat").addEventListener("change", (e) => { choices.categoryId = (e.target as HTMLSelectElement).value; choices.completenessCode = catDefaultComp(); const c = overlay.querySelector<HTMLSelectElement>("#tli-comp"); if (c) c.value = choices.completenessCode; rebuild(); });
    overlay.querySelector<HTMLSelectElement>("#tli-type")?.addEventListener("change", (e) => { choices.inventoryTypeId = (e.target as HTMLSelectElement).value; rebuild(); });
    $<HTMLSelectElement>("tli-comp").addEventListener("change", (e) => { choices.completenessCode = (e.target as HTMLSelectElement).value; rebuild(); });
    $<HTMLSelectElement>("tli-grade").addEventListener("change", (e) => { choices.gradeCode = (e.target as HTMLSelectElement).value; rebuild(); });
    overlay.querySelector<HTMLInputElement>("#tli-pct")?.addEventListener("change", (e) => { choices.pricePct = Math.max(1, Math.min(500, Math.round(+(e.target as HTMLInputElement).value) || 100)); renderTable(); });
  }

  // ---- rows + matching ----
  function rebuild() {
    if (map.title == null) { resolved = []; renderTable(); return; }
    // Changing a default re-matches everything — keep the employee's picks and
    // skips (keyed by source line) instead of silently resetting them. Fold in
    // the rows on screen first (incl. rows the caller marked staged/skipped).
    for (const r of resolved) {
      if (r.product?.id !== r.match.product?.id || r.skip) picks.set(r.row.n, { productId: r.product?.id ?? "", skip: r.skip });
      else picks.delete(r.row.n);
    }
    const rows: ImportRow[] = buildRows(records, map, {
      completeness: o.completeness, grades: o.grades, platforms: o.platforms,
      defaultCompleteness: choices.completenessCode, defaultGrade: choices.gradeCode,
      cents: centsColumns(header, map), folder: map.folder != null ? folderSel : null,
    });
    resolved = rows.map((row) => {
      const match = matchRow(row, prepared, o.platforms, typeFilter());
      const hint = row.kind ? kindCat[row.kind] : "";
      if (row.kind === "console" && !hint) row.warnings.push("Looks like a console/handheld — pick its category (no Consoles category found)");
      const r: ResolvedRow = { row, match, product: match.product, variant: match.variant, skip: false, categoryId: catPicks.get(row.n) ?? hint };
      const k = picks.get(row.n);
      if (k) { chooseProduct(r, k.productId ? byId.get(k.productId) || null : null, typeFilter()); r.skip = k.skip; }
      return r;
    });
    renderTable();
  }

  const newPrice = (r: ResolvedRow) => r.row.priceCents == null ? null : Math.round(r.row.priceCents * choices.pricePct / 100);

  // A brand-new game's 2nd+ condition (Loose after CIB) lands on the SAME new
  // listing as its first row — the caller groups them the same way.
  // follower → the source line of the row that creates the listing.
  function followerRows(): Map<ResolvedRow, number> {
    const lead = new Map<string, number>(), out = new Map<ResolvedRow, number>();
    for (const r of resolved) {
      if (r.skip || r.product) continue;
      const k = newListingKey(r.row);
      if (lead.has(k)) out.set(r, lead.get(k)!); else lead.set(k, r.row.n);
    }
    return out;
  }
  function statusOf(r: ResolvedRow, followers: Map<ResolvedRow, number>): { cls: string; text: string } {
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
      const opts = [`<option value=""${!r.product ? " selected" : ""}>＋ New listing</option>`]
        .concat(cands.map((c) => `<option value="${c.product.id}"${r.product?.id === c.product.id ? " selected" : ""}>${esc(c.product.title)} · ${esc(c.product.platform || "?")} (${Math.round(c.score * 100)}%)</option>`));
      if (r.product && !cands.some((c) => c.product.id === r.product!.id)) opts.push(`<option value="${r.product.id}" selected>${esc(r.product.title)} · ${esc(r.product.platform || "?")}</option>`);
      const cond = [compLabel(r.row.completenessCode), r.row.gradeCode ? gradeLabel(r.row.gradeCode) : ""].filter(Boolean).join(" · ");
      const warn = r.row.warnings.length ? ` <span class="warn" title="${esc(r.row.warnings.join("\n"))}">⚠</span>` : "";
      const price = entry ? (r.variant ? `<span class="tli-muted" title="Existing listing keeps its price">${money(r.variant.priceCents)}</span>` : newPrice(r) == null ? `<span class="warn" title="No value in the sheet — set the price on the entry screen">—</span>` : money(newPrice(r)!)) : "";
      return `<tr data-i="${i}" class="${r.skip ? "skip" : ""} ${st.cls === "rev" ? "review" : ""}">
        <td><input type="checkbox" data-keep ${r.skip ? "" : "checked"} title="Uncheck to skip this row" /></td>
        <td class="tli-muted">${r.row.n}</td>
        <td class="t">${esc(r.row.title)}${warn}</td>
        <td>${esc(r.row.platform || "—")}${r.row.platformRaw && !r.row.platformResolved ? ` <span class="warn" title="Platform not recognized">?</span>` : ""}</td>
        <td>${esc(cond)}</td>
        <td class="num">${r.row.qty}</td>
        <td class="num">${r.row.priceCents == null ? "—" : money(r.row.priceCents)}</td>
        ${pcCol ? `<td class="num tli-muted">${r.row.pcValueCents == null ? "—" : money(r.row.pcValueCents)}</td>` : ""}
        ${entry ? `<td class="num">${r.row.costCents == null ? "—" : money(r.row.costCents)}</td>` : ""}
        <td><select data-pick>${opts.join("")}</select> <span class="tli-pill ${st.cls}">${st.text}</span>${followers.has(r) ? ` <span class="tli-muted" title="This condition is added to the listing row ${followers.get(r)} creates — set the category there">category: row ${followers.get(r)}</span>` : !r.product ? ` <select data-cat title="Category for this new listing">${catOpts(r.categoryId || choices.categoryId)}</select>` : ""}</td>
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
      tr.querySelector<HTMLSelectElement>("[data-pick]")!.addEventListener("change", (e) => {
        const id = (e.target as HTMLSelectElement).value;
        chooseProduct(r, id ? byId.get(id) || null : null, typeFilter());
        renderTable();
      });
      tr.querySelector<HTMLSelectElement>("[data-cat]")?.addEventListener("change", (e) => {
        r.categoryId = (e.target as HTMLSelectElement).value;
        catPicks.set(r.row.n, r.categoryId);
      });
    });
    summary();
  }
  $<HTMLInputElement>("tli-only-review").addEventListener("change", renderTable);

  function summary() {
    const live = resolved.filter((r) => !r.skip);
    const n = { ex: 0, cond: 0, nw: 0, rev: 0, units: 0 };
    const followers = followerRows();
    for (const r of live) {
      n.units += r.row.qty;
      const s = statusOf(r, followers).cls;
      if (s === "ok") n.ex++; else if (s === "cond") n.cond++; else if (s === "rev") n.rev++; else n.nw++;
    }
    const nopl = live.filter((r) => !r.row.platform).length;
    const totals = map.title == null ? 0 : records.filter((rec) => isSummaryRow(String(rec[map.title!] ?? ""), map.platform == null ? "" : String(rec[map.platform] ?? ""))).length;
    $("tli-sum").innerHTML = live.length
      ? `<strong>${live.length}</strong> lines · <strong>${n.units}</strong> units — <strong>${n.ex}</strong> existing · <strong>${n.cond}</strong> new conditions · <strong>${n.nw + n.rev}</strong> new listings${n.rev ? ` (<strong style="color:var(--magenta)">${n.rev}</strong> need review)` : ""}${nopl ? ` · <span class="warn">${nopl} without a platform</span>` : ""}${totals ? ` · <span class="tli-muted">${totals} totals row${totals === 1 ? "" : "s"} skipped</span>` : ""}`
      : (resolved.length ? "Every row is skipped." : "Choose a file to begin.");
    ($("tli-go") as HTMLButtonElement).disabled = !live.length || busy;
    $("tli-go").textContent = live.length ? `Import ${live.length} line${live.length === 1 ? "" : "s"}` : "Import";
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
      showErr((e?.message || "Import failed") + " Rows confirmed as imported are unchecked.");
      overlay.querySelectorAll<HTMLElement>("select, input, button").forEach((el) => { (el as any).disabled = false; });
      renderTable();
    }
  });
}
