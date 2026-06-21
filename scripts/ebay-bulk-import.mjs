// ============================================================================
// Bulk-import the whole eBay store into the POS, server-side.
//
//   node --env-file=.env scripts/ebay-bulk-import.mjs
//
// Drives the /api/pos/ebay-import endpoint (so it reuses the exact, tested
// import logic — gallery copy, category mapping, descriptions, tags) and
// authenticates with CRON_SECRET. Two phases: enumerate the store, then import
// each not-yet-imported listing a few at a time. Safe to re-run — it resumes
// (already-imported listings are skipped). Requires `npm run dev` running.
// ============================================================================
const BASE = process.env.IMPORT_BASE || "http://localhost:4321";
const SECRET = process.env.CRON_SECRET;
if (!SECRET) { console.error("CRON_SECRET missing from .env"); process.exit(1); }
const HEADERS = { "content-type": "application/json", authorization: `Bearer ${SECRET}` };

const post = async (body) => {
  const r = await fetch(`${BASE}/api/pos/ebay-import`, { method: "POST", headers: HEADERS, body: JSON.stringify(body) });
  return { status: r.status, json: await r.json().catch(() => ({})) };
};

console.log("Scanning the whole eBay store (all categories)…");
const listed = await post({ mode: "bulk-list" });
if (!listed.json.ok) { console.error("bulk-list failed:", listed.status, listed.json.error); process.exit(1); }
const todo = listed.json.items;
console.log(`Store total ${listed.json.total} · already imported ${listed.json.alreadyImported} · importing ${todo.length}`);

let done = 0, created = 0, skipped = 0, failed = 0;
let idx = 0;
const CONC = 4;
async function worker() {
  while (idx < todo.length) {
    const it = todo[idx++];
    try {
      const r = await post({ mode: "bulk-item", legacyItemId: it.legacyItemId });
      if (r.json.ok && r.json.created) created++;
      else if (r.json.ok && r.json.skipped) skipped++;
      else { failed++; if (failed <= 12) console.error("  fail", it.legacyItemId, "·", r.json.error || r.status); }
    } catch (e) { failed++; if (failed <= 12) console.error("  err", it.legacyItemId, "·", String(e?.message || e)); }
    done++;
    if (done % 10 === 0 || done === todo.length) console.log(`  ${done}/${todo.length} — created ${created}, skipped ${skipped}, failed ${failed}`);
  }
}
await Promise.all(Array.from({ length: CONC }, worker));
console.log(`\n✅ Import complete — ${created} created, ${skipped} skipped, ${failed} failed (store total ${listed.json.total}).`);
