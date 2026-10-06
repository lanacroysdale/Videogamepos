// eBay store importer — reads the store straight from eBay (no CSV), lets the
// employee filter it (Games / Merch / …, platform, region, Japan, search),
// pick listings, set the expo price rule + photo count, then hands the chosen
// rows to the caller, which stages them onto the entry draft exactly like the
// collection CSV import (matching, Finish → labels). Nothing is written here.

import { ensureImportCss } from "./importDialog";
import { prepareCatalog, matchRow, chooseProduct, newListingKey, type CatalogProduct, type ResolvedRow } from "./collectionImport";
import type { PlatformAlias, TaxoEntry } from "./smartSearch";
import { type Region, regionsOn, regionOf, regionByCode, regionBadgeHtml, displayTitle, regionSortKey } from "./regions";
import {
  buildEbayRows, expoPrice, EBAY_GROUPS, defaultCategoryFor,
  type EbayListing, type EbayDetails, type EbayImportRow, type EbayGroup, type PriceRule,
} from "./ebayImport";

export interface EbayImportChoices {
  inventoryTypeId: string;
  /** Photos per listing: 1 = the cover only. */
  galleryMax: number;
}
export interface EbayImportDialogOpts {
  catalog: CatalogProduct[];
  completeness: TaxoEntry[];
  grades: TaxoEntry[];
  platforms: PlatformAlias[];
  categories: { id: string; name: string }[];
  invTypes?: { id: string; name: string; icon?: string | null; key?: string }[];
  regions?: Region[];
  /** Find-or-create a category by name (for "＋ New category…"). */
  createCategory: (name: string) => Promise<{ id: string; name: string }>;
  /** Rows come with row.priceCents = the final price and categoryId = a real id. */
  onImport: (rows: (ResolvedRow & { row: EbayImportRow })[], choices: EbayImportChoices, progress: (msg: string) => void) => Promise<void>;
}

const CSS = `
.tle-card{max-width:1400px}
.tle-load{padding:2rem 1rem;text-align:center;color:var(--muted,#aaa)}
.tle-load progress{width:min(420px,90%);height:.6rem;margin-top:.8rem;accent-color:var(--cyan,#2ce6e0)}
.tle-chips{display:flex;gap:.35rem;flex-wrap:wrap}
.tle-chip{border:1px solid var(--border-strong,#555);background:none;color:inherit;padding:.25rem .6rem;font-size:.78rem;cursor:pointer}
.tle-chip.on{border-color:var(--cyan,#2ce6e0);color:var(--cyan,#2ce6e0);background:rgba(44,230,224,.08)}
.tle-chip b{font-family:var(--font-mono,monospace);font-weight:600;opacity:.75;margin-left:.25rem}
.tle-search{min-width:14rem}
.tle-thumb{width:44px;height:44px;object-fit:cover;display:block;border:1px solid var(--border,#333);background:#0002}
.tle-ti{width:100%;min-width:16rem;font-weight:600;font-size:.84rem;padding:.2rem .35rem}
.tle-src{font-size:.7rem;color:var(--muted-2,#999);margin-top:.15rem;white-space:normal}
.tle-src a{color:inherit}
.tle-jp{display:inline-block;font-size:.66rem;font-weight:800;padding:.02rem .3rem;border:1px solid rgba(255,73,208,.45);color:var(--magenta,#ff49d0);margin-left:.3rem;cursor:help}
.tle-price{width:5.2rem;text-align:right;font-family:var(--font-mono,monospace)}
.tle-table td.t{min-width:18rem}
.tle-card .tli-row label input[type=checkbox]{min-width:0;width:auto}
.tle-card .tli-row label.chk{align-self:flex-end;padding-bottom:.35rem}
.tle-sum-money{color:var(--muted,#aaa)}
`;

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[m] as string));
const money = (c: number) => (c / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });
const NEW_CAT = "__new__";
const ls = {
  get(k: string) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k: string, v: string) { try { localStorage.setItem(k, v); } catch { /* private mode / full */ } },
};

async function post(body: unknown): Promise<any> {
  const r = await fetch("/api/pos/ebay-import", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.ok) throw new Error(j.error || `eBay request failed (HTTP ${r.status})`);
  return j;
}

// Item specifics rarely change — cache them for half a day so reopening the
// importer (tonight, then tomorrow) doesn't re-read hundreds of listings.
const DETAILS_KEY = "tl-ebay-details-v1";
const DETAILS_TTL = 12 * 3600_000;
function cachedDetails(): Map<string, EbayDetails> {
  const out = new Map<string, EbayDetails>();
  try {
    const all = JSON.parse(ls.get(DETAILS_KEY) || "{}") as Record<string, { at: number; d: EbayDetails }>;
    for (const [id, v] of Object.entries(all)) if (v && Date.now() - v.at < DETAILS_TTL) out.set(id, v.d);
  } catch { /* corrupt → refetch */ }
  return out;
}
function saveDetails(m: Map<string, EbayDetails>) {
  const all: Record<string, { at: number; d: EbayDetails }> = {};
  try { Object.assign(all, JSON.parse(ls.get(DETAILS_KEY) || "{}")); } catch { /* start over */ }
  const now = Date.now();
  for (const [id, d] of m) all[id] = { at: (all[id]?.d === d ? all[id].at : 0) || now, d };
  for (const [id, v] of Object.entries(all)) if (!v || now - v.at > DETAILS_TTL) delete all[id];
  ls.set(DETAILS_KEY, JSON.stringify(all));
}

export function openEbayImportDialog(o: EbayImportDialogOpts) {
  ensureImportCss();
  if (!document.getElementById("tle-css")) {
    const st = document.createElement("style"); st.id = "tle-css"; st.textContent = CSS; document.head.appendChild(st);
  }
  const rOn = regionsOn(o.regions);
  const prepared = prepareCatalog(o.catalog, o.platforms, o.regions);
  const byId = new Map(o.catalog.map((p) => [p.id, p]));
  const categories = [...o.categories];
  const compLabel = (code: string) => o.completeness.find((c) => c.code === code)?.label || code || "—";
  const gradeLabel = (code: string) => { const g = o.grades.find((x) => x.code === code); return g ? g.label : code; };
  const regionName = (code: string) => { const g = regionByCode(code, o.regions); return g ? `${g.flag ? g.flag + " " : ""}${g.short}` : code; };
  const fallbackCat = categories.find((c) => /video game/i.test(c.name))?.id || categories[0]?.id || "";

  // ---- choices (remembered on this computer) ----
  const num = (k: string, d: number) => { const v = Number(ls.get(k)); return Number.isFinite(v) && ls.get(k) !== null ? v : d; };
  const price: PriceRule = {
    pct: num("tl-ebay-pct", 90), step: num("tl-ebay-step", 5), smallBelow: num("tl-ebay-small", 20), cap: ls.get("tl-ebay-cap") !== "0",
  };
  const ebayType = o.invTypes?.find((t) => t.key === "ebay" || /ebay/i.test(t.name));
  const choices: EbayImportChoices = {
    inventoryTypeId: ebayType?.id || o.invTypes?.find((t) => t.key === "retail")?.id || o.invTypes?.[0]?.id || "",
    galleryMax: num("tl-ebay-photos", 1),
  };
  let cleanTitles = ls.get("tl-ebay-clean") !== "0";
  let shortMerch = ls.get("tl-ebay-shortmerch") !== "0";
  const findComp = (re: RegExp) => o.completeness.find((c) => re.test(c.code + " " + c.label))?.code || "";
  let gameComp = findComp(/^CIB|complete/i) || o.completeness[0]?.code || "";
  let itemComp = findComp(/^L\b|loose/i) || gameComp;
  const defGrade = o.grades.find((g) => g.code === "3")?.code || o.grades[0]?.code || "";
  // Group → category for new listings. Japan items keep theirs: "🇯🇵 Japanese
  // Imports" is a virtual category (the Japan region), not a real one.
  const groupCat = new Map<EbayGroup, string>();
  for (const g of EBAY_GROUPS) groupCat.set(g.key, defaultCategoryFor(g.key, categories) || fallbackCat);
  const pendingNew = new Map<string, string>(); // "__new__:Name" → name (created on Import)

  // ---- state ----
  let listings: EbayListing[] = [];
  let details = new Map<string, EbayDetails>();
  let rows: (ResolvedRow & { row: EbayImportRow })[] = [];
  const keep = new Map<string, boolean>();        // ebay id → checked
  const picks = new Map<string, string>();         // ebay id → listing id ("" = new)
  const catPicks = new Map<string, string>();      // ebay id → category id (or __new__:Name)
  const regionPicks = new Map<string, string>();   // ebay id → region code
  const titleEdits = new Map<string, string>();    // ebay id → title
  const priceEdits = new Map<string, number>();    // ebay id → cents
  let group: EbayGroup | "" = "";
  let platformSel: string | null = null;
  let regionSel: string | null = null;
  let japanOnly = false;
  let showImported = false;
  let q = "";
  let busy = false;

  // ---- DOM ----
  const overlay = document.createElement("div");
  overlay.className = "tli-overlay";
  overlay.innerHTML = `
    <div class="tli-card tle-card" role="dialog" aria-modal="true">
      <div class="tli-head">
        <h3>🛒 Import from your eBay store → this entry</h3>
        <span class="tli-muted" id="tle-count"></span>
        <button class="btn btn-ghost btn-sm tli-x" type="button" id="tle-close">✕</button>
      </div>
      <div class="tli-body" id="tle-body">
        <div class="tle-load" id="tle-load"><div id="tle-load-msg">Reading your eBay store…</div><progress id="tle-prog" hidden></progress></div>
        <div id="tle-controls" hidden>
          <p class="tli-sec">Show</p>
          <div class="tle-chips" id="tle-groups"></div>
          <div class="tli-row" id="tle-filters" style="margin-top:.6rem;"></div>
          <p class="tli-sec" style="margin-top:.9rem;">Price, photos, type</p>
          <div class="tli-row" id="tle-defs"></div>
          <p class="tli-sec" style="margin-top:.9rem;">Categories for new listings</p>
          <div class="tli-row" id="tle-cats"></div>
        </div>
        <div id="tle-preview" hidden>
          <div class="tli-table-wrap" style="max-height:48vh;"><table class="tli-table tle-table" id="tle-table"></table></div>
        </div>
        <div class="tli-err" id="tle-err" hidden></div>
      </div>
      <div class="tli-foot">
        <span class="tli-sum" id="tle-sum"></span>
        <button class="btn btn-primary btn-sm tli-go" type="button" id="tle-go" disabled>Import</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  const $ = <T extends HTMLElement = HTMLElement>(id: string) => overlay.querySelector<T>("#" + id)!;
  let closed = false;
  const close = () => { if (busy) return; closed = true; overlay.remove(); document.removeEventListener("keydown", onKey); };
  const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
  document.addEventListener("keydown", onKey);
  $("tle-close").addEventListener("click", close);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
  const showErr = (m: string) => { const el = $("tle-err"); el.textContent = m; el.hidden = !m; };

  // ---- load: the store, then item specifics for listings not yet in the POS ----
  (async () => {
    try {
      const j = await post({ mode: "store-list" });
      listings = j.listings || [];
      if (closed) return;
      details = cachedDetails();
      const todo = listings.filter((l) => !l.imported && !details.has(l.id)).map((l) => l.id);
      const prog = $<HTMLProgressElement>("tle-prog");
      if (todo.length) { prog.hidden = false; prog.max = todo.length; prog.value = 0; }
      const fresh = new Map<string, EbayDetails>();
      let failed = 0;
      for (let i = 0; i < todo.length && !closed; i += 20) {
        $("tle-load-msg").textContent = `Reading item details from eBay… ${Math.min(i + 20, todo.length)} / ${todo.length}`;
        try {
          const dj = await post({ mode: "store-details", ids: todo.slice(i, i + 20) });
          for (const d of dj.details || []) {
            if (d.ok) { details.set(d.id, d); fresh.set(d.id, d); }
            else failed++;
          }
        } catch { failed += Math.min(20, todo.length - i); }
        prog.value = Math.min(i + 20, todo.length);
      }
      if (closed) return;
      if (fresh.size) saveDetails(details);
      // Out of stock since the store list was read → not importable.
      listings = listings.filter((l) => details.get(l.id)?.inStock !== false);
      $("tle-load").hidden = true;
      $("tle-controls").hidden = false;
      if (failed) showErr(`${failed} listing${failed === 1 ? "" : "s"} couldn't be read from eBay — they're marked ⚠ (platform / qty may be off). Close and reopen to try again.`);
      rebuild();
    } catch (e: any) {
      $("tle-load-msg").textContent = e?.message || "Couldn't read your eBay store.";
    }
  })();

  // ---- rows ----
  const rowCat = (r: EbayImportRow) => catPicks.get(r.ebay.id) ?? (groupCat.get(r.ebay.group) || fallbackCat);
  function rebuild() {
    const built = buildEbayRows(listings, details, {
      completeness: o.completeness, grades: o.grades, platforms: o.platforms, regions: o.regions,
      defaultGameCompleteness: gameComp, defaultItemCompleteness: itemComp, defaultGrade: defGrade, cleanTitles, shortMerch,
    });
    rows = built.map((row) => {
      const id = row.ebay.id;
      const t = titleEdits.get(id);
      if (t != null && t.trim()) row.title = t.trim();
      const rg = regionPicks.get(id);
      if (rg) row.region = rg;
      const match = matchRow(row, prepared, o.platforms, choices.inventoryTypeId, o.regions);
      const r = { row, match, product: match.product, variant: match.variant, skip: false, categoryId: "", nonInventory: false } as ResolvedRow & { row: EbayImportRow };
      if (picks.has(id)) chooseProduct(r, picks.get(id) ? byId.get(picks.get(id)!) || null : null, choices.inventoryTypeId);
      const imported = !!listings.find((l) => l.id === id)?.imported;
      if (!keep.has(id)) keep.set(id, !imported);
      r.skip = imported || !keep.get(id);
      return r;
    });
    renderControls();
    renderTable();
  }

  const isImported = (r: { row: EbayImportRow }) => !!listings.find((l) => l.id === r.row.ebay.id)?.imported;
  const matchesSearch = (r: { row: EbayImportRow }) => {
    if (!q) return true;
    const hay = `${r.row.title} ${r.row.ebay.title} ${r.row.platform} ${r.row.ebay.leaf}`.toLowerCase();
    return q.toLowerCase().split(/\s+/).filter(Boolean).every((w) => hay.includes(w));
  };
  // Filters in order: imported → group → platform → region → Japan → search.
  const base = () => rows.filter((r) => showImported || !isImported(r));
  const inGroup = () => base().filter((r) => !group || r.row.ebay.group === group);
  const onPlatform = () => inGroup().filter((r) => platformSel == null || (r.row.platform || "") === platformSel);
  const shownRows = () => onPlatform().filter((r) => (regionSel == null || r.row.region === regionSel) && (!japanOnly || r.row.ebay.japan) && matchesSearch(r));

  const sel = (id: string, label: string, opts: string, title = "") => `<label${title ? ` title="${esc(title)}"` : ""}>${label}<select id="${id}">${opts}</select></label>`;
  const catOptions = (selected: string, extra = "") => extra
    + categories.map((c) => `<option value="${esc(c.id)}"${c.id === selected ? " selected" : ""}>${esc(c.name)}</option>`).join("")
    + [...pendingNew.keys(), ...(selected.startsWith(NEW_CAT) && !pendingNew.has(selected) ? [selected] : [])]
      .map((k) => `<option value="${esc(k)}"${k === selected ? " selected" : ""}>${esc(k.slice(NEW_CAT.length + 1))} (new)</option>`).join("")
    + `<option value="${NEW_CAT}">＋ New category…</option>`;

  function renderControls() {
    // Group chips (counts after the "already imported" toggle only).
    const counts = new Map<string, number>();
    for (const r of base()) counts.set(r.row.ebay.group, (counts.get(r.row.ebay.group) || 0) + 1);
    $("tle-groups").innerHTML = `<button type="button" class="tle-chip${!group ? " on" : ""}" data-g="">All<b>${base().length}</b></button>`
      + EBAY_GROUPS.filter((g) => counts.get(g.key)).map((g) => `<button type="button" class="tle-chip${group === g.key ? " on" : ""}" data-g="${g.key}">${esc(g.label)}<b>${counts.get(g.key)}</b></button>`).join("");
    // Platform / region within the group.
    const pc = new Map<string, number>();
    for (const r of inGroup()) pc.set(r.row.platform || "", (pc.get(r.row.platform || "") || 0) + 1);
    if (platformSel != null && !pc.has(platformSel)) platformSel = null;
    const plats = [...pc.keys()].sort((a, b) => (a === "" ? 1 : b === "" ? -1 : a.localeCompare(b)));
    const rc = new Map<string, number>();
    for (const r of onPlatform()) rc.set(r.row.region, (rc.get(r.row.region) || 0) + 1);
    if (regionSel != null && !rc.has(regionSel)) regionSel = null;
    const jpN = onPlatform().filter((r) => r.row.ebay.japan).length;
    const importedN = rows.filter(isImported).length;
    $("tle-filters").innerHTML =
      sel("tle-plat", "Platform", `<option value="*">All platforms (${inGroup().length})</option>` + plats.map((p) => `<option value="${esc(p)}"${platformSel === p ? " selected" : ""}>${esc(p || "(no platform)")} (${pc.get(p)})</option>`).join(""))
      + (rOn && rc.size > 1 ? sel("tle-rgn", "Region", `<option value="*">All regions</option>` + [...rc.keys()].sort((a, b) => regionSortKey(a, o.regions) - regionSortKey(b, o.regions)).map((c) => `<option value="${esc(c)}"${regionSel === c ? " selected" : ""}>${esc(regionName(c))} (${rc.get(c)})</option>`).join("")) : "")
      + `<label>Search<input id="tle-q" class="tle-search" type="search" placeholder="title, platform, eBay category…" value="${esc(q)}" /></label>`
      + `<label class="chk" style="text-transform:none;letter-spacing:0;font-weight:600;"><input type="checkbox" id="tle-jp"${japanOnly ? " checked" : ""} /> 🇯🇵 Japan items only (${jpN})</label>`
      + (importedN ? `<label class="chk" style="text-transform:none;letter-spacing:0;font-weight:600;" title="Listings already in the POS can't be imported again"><input type="checkbox" id="tle-imp"${showImported ? " checked" : ""} /> Show ${importedN} already in the POS</label>` : "");
    $("tle-defs").innerHTML =
      `<label title="Percent of the eBay price — 90 = 10% off">Price % of eBay<input id="tle-pct" type="number" min="1" max="200" step="1" value="${price.pct}" style="width:5rem;" /></label>`
      + sel("tle-step", "Round to", [[0, "No rounding"], [1, "Nearest $1"], [5, "Nearest $5"], [10, "Nearest $10"]].map(([v, l]) => `<option value="${v}"${price.step === v ? " selected" : ""}>${l}</option>`).join(""))
      + `<label title="Cheap items round to the nearest $1 instead (0 = off)">…but under $<input id="tle-small" type="number" min="0" max="500" step="1" value="${price.smallBelow}" style="width:4.5rem;" /> → $1</label>`
      + `<label class="chk" style="text-transform:none;letter-spacing:0;font-weight:600;" title="If rounding would land above the eBay price, round down instead"><input type="checkbox" id="tle-cap"${price.cap ? " checked" : ""} /> Never above the eBay price</label>`
      + sel("tle-photos", "Photos", [[1, "1 (cover only)"], [3, "3"], [6, "6"], [12, "All (up to 12)"]].map(([v, l]) => `<option value="${v}"${choices.galleryMax === v ? " selected" : ""}>${l}</option>`).join(""), "Photos copied from each eBay listing onto its new listing")
      + (o.invTypes?.length ? sel("tle-type", "Inventory type", o.invTypes.map((t) => `<option value="${esc(t.id)}"${t.id === choices.inventoryTypeId ? " selected" : ""}>${esc((t.icon ? t.icon + " " : "") + t.name)}</option>`).join("")) : "")
      + `<label class="chk" style="text-transform:none;letter-spacing:0;font-weight:600;" title="Games take eBay's Game Name (plus any edition in the listing title); other items use the listing title less the seller's search words. Off = the eBay listing title as is. Either way the eBay listing title goes into the description."><input type="checkbox" id="tle-clean"${cleanTitles ? " checked" : ""} /> Titles from eBay's game data</label>`
      + (cleanTitles ? `<label class="chk" style="text-transform:none;letter-spacing:0;font-weight:600;" title="Merch / toys: game + character + type from eBay's item specifics (“Splatoon 3 Judd & Li'l Judd Alarm Clock”) — only when those words are in the listing title and it isn't a set; otherwise the trimmed listing title"><input type="checkbox" id="tle-short"${shortMerch ? " checked" : ""} /> Short merch titles</label>` : "");
    const groupsHere = EBAY_GROUPS.filter((g) => rows.some((r) => r.row.ebay.group === g.key && (showImported || !isImported(r))));
    $("tle-cats").innerHTML = groupsHere.map((g) => sel(`tle-gc-${g.key}`, g.label, catOptions(groupCat.get(g.key) || ""))).join("")
      + sel("tle-gcomp", "Game condition when eBay doesn't say", o.completeness.map((c) => `<option value="${esc(c.code)}"${c.code === gameComp ? " selected" : ""}>${esc(c.label)}</option>`).join(""))
      + sel("tle-icomp", "Other items", o.completeness.map((c) => `<option value="${esc(c.code)}"${c.code === itemComp ? " selected" : ""}>${esc(c.label)}</option>`).join(""))
      + `<span class="tli-note">Everything lands on this entry as a draft — nothing is in stock until you Finish it (which prints the labels). New listings get the eBay listing title + description as their description. Japan items keep their category and get the 🇯🇵 Japan region — they show under 🇯🇵 Japanese Imports (Inventory category filter, shop). Existing listings keep their own category, price and description; a copy matched onto one gets its own stock row there.</span>`;
  }

  // Category select → "＋ New category…" asks for a name (created on Import).
  const pickCategory = (v: string, prev: string): string => {
    if (v !== NEW_CAT) return v;
    const name = (prompt("New category name:", "") || "").replace(/\s+/g, " ").trim().slice(0, 40);
    if (!name) return prev;
    const hit = categories.find((c) => c.name.toLowerCase() === name.toLowerCase());
    if (hit) return hit.id;
    const key = `${NEW_CAT}:${name}`;
    pendingNew.set(key, name);
    return key;
  };

  overlay.addEventListener("click", (e) => {
    const chip = (e.target as HTMLElement).closest<HTMLElement>("[data-g]");
    if (chip && $("tle-groups").contains(chip)) { group = (chip.dataset.g || "") as EbayGroup | ""; platformSel = null; regionSel = null; renderControls(); renderTable(); }
  });
  overlay.addEventListener("change", (e) => {
    const t = e.target as HTMLInputElement & HTMLSelectElement;
    if (!t.id || busy) return;
    const rerender = () => { renderControls(); renderTable(); };
    switch (t.id) {
      case "tle-plat": platformSel = t.value === "*" ? null : t.value; regionSel = null; return rerender();
      case "tle-rgn": regionSel = t.value === "*" ? null : t.value; return rerender();
      case "tle-jp": japanOnly = t.checked; return rerender();
      case "tle-imp": showImported = t.checked; return rerender();
      case "tle-pct": price.pct = Math.max(1, Math.min(200, Math.round(+t.value) || 90)); ls.set("tl-ebay-pct", String(price.pct)); return rerender();
      case "tle-step": price.step = +t.value || 0; ls.set("tl-ebay-step", String(price.step)); return rerender();
      case "tle-small": price.smallBelow = Math.max(0, Math.round(+t.value) || 0); ls.set("tl-ebay-small", String(price.smallBelow)); return rerender();
      case "tle-cap": price.cap = t.checked; ls.set("tl-ebay-cap", t.checked ? "1" : "0"); return rerender();
      case "tle-photos": choices.galleryMax = +t.value || 1; ls.set("tl-ebay-photos", String(choices.galleryMax)); return;
      case "tle-type": choices.inventoryTypeId = t.value; return rebuild();
      case "tle-clean": cleanTitles = t.checked; ls.set("tl-ebay-clean", t.checked ? "1" : "0"); return rebuild();
      case "tle-short": shortMerch = t.checked; ls.set("tl-ebay-shortmerch", t.checked ? "1" : "0"); return rebuild();
      case "tle-gcomp": gameComp = t.value; return rebuild();
      case "tle-icomp": itemComp = t.value; return rebuild();
    }
    if (t.id.startsWith("tle-gc-")) { const g = t.id.slice(7) as EbayGroup; groupCat.set(g, pickCategory(t.value, groupCat.get(g) || "")); return rerender(); }
  });
  overlay.addEventListener("input", (e) => {
    const t = e.target as HTMLInputElement;
    if (t.id === "tle-q") {
      q = t.value;
      clearTimeout((t as any)._d);
      (t as any)._d = setTimeout(() => { renderTable(); }, 160);
    }
  });

  // ---- table ----
  const finalPrice = (r: { row: EbayImportRow }) => priceEdits.get(r.row.ebay.id) ?? expoPrice(r.row.ebay.priceCents, price);
  function followerRows(list: typeof rows): Map<string, number> {
    // A 2nd eBay listing of a game the import creates goes on that SAME new listing.
    const lead = new Map<string, number>(), out = new Map<string, number>();
    for (const r of list) {
      if (r.skip || r.product) continue;
      const k = newListingKey(r.row);
      if (lead.has(k)) out.set(r.row.ebay.id, lead.get(k)!); else lead.set(k, r.row.n);
    }
    return out;
  }
  function statusOf(r: ResolvedRow & { row: EbayImportRow }, followers: Map<string, number>) {
    if (isImported(r)) return { cls: "noninv", text: "in the POS" };
    if (followers.has(r.row.ebay.id)) return { cls: "cond", text: "+ same new listing" };
    if (r.product && r.variant) return { cls: "ok", text: "existing stock row" };
    if (r.product) {
      const same = r.product.variants.some((v) => (v.completenessCode || "") === (r.row.completenessCode || ""));
      return { cls: "cond", text: same ? "+ own stock row" : "+ condition" };
    }
    if (r.match.status === "review") return { cls: "rev", text: "review" };
    return { cls: "new", text: "new listing" };
  }
  let lastShown: typeof rows = [];
  function renderTable() {
    const shown = shownRows();
    lastShown = shown;
    $("tle-preview").hidden = false;
    // Only the rows this Import would send decide which one creates a new listing.
    const followers = followerRows(shown.filter((r) => !isImported(r)));
    const head = `<tr><th><input type="checkbox" id="tle-all" title="Select / unselect every row shown" aria-label="Select all rows shown" /></th><th></th><th>Title</th><th>Platform</th><th>Condition</th><th class="num">Qty</th><th class="num">eBay</th><th class="num">Price</th><th>Match</th><th>Category</th>${rOn ? "<th>Region</th>" : ""}</tr>`;
    const body = shown.map((r) => {
      const id = r.row.ebay.id;
      const imported = isImported(r);
      const st = statusOf(r, followers);
      const cands = r.match.candidates;
      const optTitle = (p: CatalogProduct) => esc(displayTitle(p.title, p.regionCode, o.regions));
      const opts = [`<option value=""${!r.product ? " selected" : ""}>＋ New listing</option>`]
        .concat(cands.map((c) => `<option value="${esc(c.product.id)}"${r.product?.id === c.product.id ? " selected" : ""}>${optTitle(c.product)} · ${esc(c.product.platform || "?")} (${Math.round(c.score * 100)}%)</option>`));
      if (r.product && !cands.some((c) => c.product.id === r.product!.id)) opts.push(`<option value="${esc(r.product.id)}" selected>${optTitle(r.product)} · ${esc(r.product.platform || "?")}</option>`);
      const cond = [compLabel(r.row.completenessCode), r.row.gradeCode ? gradeLabel(r.row.gradeCode) : ""].filter(Boolean).join(" · ");
      const warn = r.row.warnings.length ? ` <span class="warn" title="${esc(r.row.warnings.join("\n"))}">⚠</span>` : "";
      const jp = r.row.ebay.japan ? `<span class="tle-jp" title="Japan item (${esc(r.row.ebay.japanWhy)})">JP</span>` : "";
      const isNew = !r.product && !followers.has(id);
      const priceCell = imported ? "" : r.variant
        ? `<span class="tli-muted" title="This stock row keeps its price">${money(r.variant.priceCents)}</span>`
        : `<input class="tle-price" type="number" min="0" step="0.01" data-price value="${(finalPrice(r) / 100).toFixed(2)}" title="Price for the new stock row — edit to override" />`;
      const catCell = imported || r.product ? `<span class="tli-muted">${r.product ? "listing's own" : ""}</span>`
        : followers.has(id) ? `<span class="tli-muted">same as row ${followers.get(id)}</span>`
        : `<select data-cat>${catOptions(rowCat(r.row))}</select>`;
      const rgCell = !rOn ? "" : `<td>${isNew && !imported ? `<select data-region>${o.regions!.filter((g) => g.isActive || g.code === r.row.region).map((g) => `<option value="${esc(g.code)}"${g.code === r.row.region ? " selected" : ""}>${esc(regionName(g.code))}</option>`).join("")}</select>` : esc(regionName(r.row.region))}</td>`;
      return `<tr data-id="${esc(id)}" class="${r.skip ? "skip" : ""} ${st.cls === "rev" ? "review" : ""}">
        <td><input type="checkbox" data-keep ${r.skip ? "" : "checked"} ${imported ? "disabled" : ""} /></td>
        <td>${r.row.ebay.image ? `<img class="tle-thumb" src="${esc(r.row.ebay.image)}" alt="" loading="lazy" />` : ""}</td>
        <td class="t">${imported ? `<strong>${esc(listings.find((l) => l.id === id)?.imported?.title || r.row.title)}</strong>` : `<input class="tle-ti" data-title value="${esc(r.row.title)}" />`}${jp}${warn}
          <div class="tle-src" title="The eBay listing title goes into the description">eBay: <a href="${esc(r.row.ebay.url)}" target="_blank" rel="noopener">${esc(r.row.ebay.title)} ↗</a> · ${esc(r.row.ebay.leaf)} · 📷 ${r.row.ebay.imageCount}${!imported && r.row.title !== r.row.ebay.title ? ` · <button type="button" class="tli-link" data-ebaytitle>use eBay title</button>` : ""}</div></td>
        <td>${esc(r.row.platform || "—")}${r.row.platformRaw && !r.row.platformResolved ? ` <span class="warn" title="eBay says “${esc(r.row.platformRaw)}” — not a platform the POS knows">?</span>` : ""}</td>
        <td>${esc(cond)}<div class="tle-src">${esc(r.row.conditionRaw)}</div></td>
        <td class="num">${r.row.qty}</td>
        <td class="num">${money(r.row.ebay.priceCents)}</td>
        <td class="num">${priceCell}</td>
        <td>${imported ? "" : `<select data-pick>${opts.join("")}</select> `}<span class="tli-pill ${st.cls}">${st.text}</span></td>
        <td>${catCell}</td>
        ${rgCell}
      </tr>`;
    }).join("");
    $("tle-table").innerHTML = head + (body || `<tr><td colspan="11" class="tli-muted" style="padding:1rem;">Nothing matches these filters.</td></tr>`);
    syncAll();
    summary();
  }
  const selectable = () => lastShown.filter((r) => !isImported(r));
  function syncAll() {
    const all = overlay.querySelector<HTMLInputElement>("#tle-all");
    if (!all) return;
    const s = selectable();
    all.checked = s.length > 0 && s.every((r) => !r.skip);
    all.indeterminate = !all.checked && s.some((r) => !r.skip);
  }
  const rowOf = (el: Element) => { const id = el.closest<HTMLElement>("tr[data-id]")?.dataset.id; return id ? rows.find((r) => r.row.ebay.id === id) : undefined; };
  $("tle-table").addEventListener("change", (e) => {
    if (busy) return;
    const t = e.target as HTMLInputElement & HTMLSelectElement;
    if (t.id === "tle-all") { for (const r of selectable()) { r.skip = !t.checked; keep.set(r.row.ebay.id, t.checked); } renderTable(); return; }
    const r = rowOf(t);
    if (!r) return;
    const id = r.row.ebay.id;
    if (t.matches("[data-keep]")) {
      r.skip = !t.checked; keep.set(id, t.checked);
      t.closest("tr")!.classList.toggle("skip", r.skip);
      // A skipped first copy hands "creates the listing" to the next one.
      if (!r.product) renderTable(); else { syncAll(); summary(); }
    } else if (t.matches("[data-pick]")) {
      picks.set(id, t.value);
      chooseProduct(r, t.value ? byId.get(t.value) || null : null, choices.inventoryTypeId);
      renderTable();
    } else if (t.matches("[data-cat]")) {
      const v = pickCategory(t.value, rowCat(r.row));
      catPicks.set(id, v);
      if (v !== t.value) renderTable();
    } else if (t.matches("[data-region]")) {
      regionPicks.set(id, t.value); rebuild();
    } else if (t.matches("[data-price]")) {
      const c = Math.max(0, Math.round(parseFloat(t.value) * 100) || 0);
      priceEdits.set(id, c); summary();
    } else if (t.matches("[data-title]")) {
      const v = t.value.replace(/\s+/g, " ").trim();
      if (v) titleEdits.set(id, v); else titleEdits.delete(id);
      rebuild(); // another title may match another listing
    }
  });
  $("tle-table").addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest("[data-ebaytitle]");
    if (!b || busy) return;
    const r = rowOf(b);
    if (r) { titleEdits.set(r.row.ebay.id, r.row.ebay.title); rebuild(); }
  });

  function liveRows() { return lastShown.filter((r) => !r.skip && !isImported(r)); }
  function summary() {
    const live = liveRows();
    const followers = followerRows(lastShown.filter((r) => !isImported(r)));
    let nw = 0, ex = 0, rev = 0, units = 0, ebayTotal = 0, expoTotal = 0;
    for (const r of live) {
      const s = statusOf(r, followers).cls;
      if (s === "rev") rev++; else if (s === "new") nw++; else ex++;
      units += r.row.qty;
      ebayTotal += r.row.ebay.priceCents * r.row.qty;
      expoTotal += (r.variant ? r.variant.priceCents : finalPrice(r)) * r.row.qty;
    }
    const total = rows.filter((r) => !isImported(r)).length;
    $("tle-count").textContent = `${listings.length} in stock on eBay · ${total} not in the POS yet`;
    $("tle-sum").innerHTML = live.length
      ? `<strong>${live.length}</strong> listings · <strong>${units}</strong> units — <strong>${nw + rev}</strong> new listings${rev ? ` (<strong style="color:var(--magenta)">${rev}</strong> could match one you have — check Match)` : ""} · <strong>${ex}</strong> onto existing listings · <span class="tle-sum-money">eBay ${money(ebayTotal)} → expo <strong>${money(expoTotal)}</strong></span>`
      : "Nothing selected in this view.";
    const go = $<HTMLButtonElement>("tle-go");
    go.disabled = !live.length || busy;
    go.textContent = live.length ? `Import ${live.length} listing${live.length === 1 ? "" : "s"} → draft` : "Import";
  }

  $("tle-go").addEventListener("click", async () => {
    const live = liveRows();
    if (!live.length || busy) return;
    busy = true;
    const go = $<HTMLButtonElement>("tle-go"); go.disabled = true;
    overlay.querySelectorAll<HTMLElement>("select, input, button").forEach((el) => { if (el.id !== "tle-go") (el as any).disabled = true; });
    const progress = (m: string) => { $("tle-sum").textContent = m; };
    showErr("");
    try {
      // "＋ New category" picks are created now (find-or-create by name).
      const needed = new Set(live.filter((r) => !r.product).map((r) => rowCat(r.row)).filter((c) => c.startsWith(NEW_CAT)));
      const made = new Map<string, string>();
      for (const key of needed) {
        progress(`Creating category “${key.slice(NEW_CAT.length + 1)}”…`);
        const c = await o.createCategory(key.slice(NEW_CAT.length + 1));
        made.set(key, c.id);
        if (!categories.some((x) => x.id === c.id)) categories.push(c);
      }
      const realCat = (c: string) => made.get(c) || (c.startsWith(NEW_CAT) ? fallbackCat : c);
      for (const [k, id] of made) {
        pendingNew.delete(k);
        for (const [g, v] of groupCat) if (v === k) groupCat.set(g, id);
        for (const [rid, v] of catPicks) if (v === k) catPicks.set(rid, id);
      }
      const out = live.map((r) => ({ ...r, categoryId: realCat(rowCat(r.row)), row: { ...r.row, priceCents: r.variant ? r.variant.priceCents : finalPrice(r) } }));
      await o.onImport(out, { ...choices }, progress);
      busy = false; close();
    } catch (e: any) {
      busy = false;
      showErr((e?.message || "Import failed") + " Rows that made it onto the draft are now in the POS (shown as “in the POS” after you reopen).");
      overlay.querySelectorAll<HTMLElement>("select, input, button").forEach((el) => { (el as any).disabled = false; });
      renderControls(); renderTable();
    }
  });
}
