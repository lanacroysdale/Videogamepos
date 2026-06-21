// ============================================================================
// Best-effort UPC backfill from eBay.
//
//   node --env-file=.env scripts/ebay-upc-backfill.mjs
//
// For every variant with no UPC barcode, search eBay for the product and pull a
// UPC from a matching listing's item specifics (title-match guarded). Drives the
// /api/pos/ebay-import endpoint (CRON_SECRET-authed) so it reuses tested logic.
// Free + automatic, but eBay UPCs are seller-entered — review afterward, and
// switch to PriceCharting when you have a token for authoritative UPCs.
// Requires `npm run dev` running.
// ============================================================================
const BASE = process.env.IMPORT_BASE || "http://localhost:4321";
const SECRET = process.env.CRON_SECRET;
if (!SECRET) { console.error("CRON_SECRET missing from .env"); process.exit(1); }
const HEADERS = { "content-type": "application/json", authorization: `Bearer ${SECRET}` };
const post = async (body) => {
  const r = await fetch(`${BASE}/api/pos/ebay-import`, { method: "POST", headers: HEADERS, body: JSON.stringify(body) });
  return (await r.json().catch(() => ({})));
};

console.log("Finding variants without a UPC…");
const listed = await post({ mode: "upc-list" });
if (!listed.ok) { console.error("upc-list failed:", listed.error); process.exit(1); }
const todo = listed.todo;
console.log(`${listed.totalVariants} variants total · ${todo.length} missing a UPC`);

let done = 0, found = 0, none = 0, skipped = 0;
let idx = 0;
const CONC = 4;
async function worker() {
  while (idx < todo.length) {
    const v = todo[idx++];
    try {
      const r = await post({ mode: "upc-item", variantId: v.variantId, title: v.title, platform: v.platform });
      if (r.found) { found++; if (found <= 25) console.log(`  ✓ ${v.title.slice(0, 40)} → ${r.upc}`); }
      else if (r.skipped) skipped++;
      else none++;
    } catch { none++; }
    done++;
    if (done % 20 === 0 || done === todo.length) console.log(`  …${done}/${todo.length} (found ${found}, none ${none})`);
  }
}
await Promise.all(Array.from({ length: CONC }, worker));
console.log(`\n✅ UPC backfill done — ${found} added, ${none} no match, ${skipped} already had one (of ${todo.length}).`);
