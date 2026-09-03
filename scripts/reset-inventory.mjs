// ============================================================================
// Wipe INVENTORY data for a fresh start, leaving everything else intact:
// employees/logins, SOPs, tasks, time clock, bar menu, customers, and sales
// history all survive. Sales line items keep their name/price snapshot but are
// unlinked from the deleted variants (transaction_items.variant_id → null).
//
// Dry run (default — prints row counts, changes nothing):
//   npm run db:reset-inventory
// Actually delete:
//   npm run db:reset-inventory -- --yes
//
// Run npm run db:export FIRST — this script refuses to delete unless a
// backups/ folder from the last 24h exists.
// ============================================================================
import { createClient } from "@supabase/supabase-js";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";

const url = process.env.PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Missing PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env");
  process.exit(1);
}
const sb = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });

// Child tables first so foreign keys never block a delete.
const INVENTORY_TABLES = [
  "inventory_entry_items",
  "inventory_entries",
  "stock_movements",
  "price_changes",
  "product_barcodes",
  "product_skus",
  "product_suppliers",
  "game_metadata",
  "product_variants",
  "products",
];

const NIL = "00000000-0000-0000-0000-000000000000";
const doIt = process.argv.includes("--yes");

async function recentBackupExists() {
  try {
    const dir = path.join(process.cwd(), "backups");
    for (const name of await readdir(dir)) {
      const s = await stat(path.join(dir, name));
      if (s.isDirectory() && Date.now() - s.mtimeMs < 24 * 60 * 60 * 1000) return name;
    }
  } catch { /* no backups dir */ }
  return null;
}

async function main() {
  console.log(`Database: ${url}\n`);
  let total = 0;
  const present = [];
  for (const t of INVENTORY_TABLES) {
    const { count, error } = await sb.from(t).select("*", { count: "exact", head: true });
    if (error) {
      if (/could not find the table/i.test(error.message)) { console.log(`  ${t.padEnd(24)} (not in this database, skipped)`); continue; }
      throw new Error(`${t}: ${error.message}`);
    }
    present.push(t);
    total += count ?? 0;
    console.log(`  ${t.padEnd(24)} ${count} rows`);
  }

  if (!doIt) {
    console.log(`\nDRY RUN — nothing deleted. ${total} rows across ${INVENTORY_TABLES.length} tables would be removed.`);
    console.log("Re-run with --yes to delete (export a backup first: npm run db:export).");
    return;
  }

  const backup = await recentBackupExists();
  if (!backup) {
    console.error("\nRefusing to delete: no backup from the last 24h found in backups/.");
    console.error("Run `npm run db:export` first.");
    process.exit(1);
  }
  console.log(`\nUsing backup safety check: backups/${backup}\n`);

  // Sales history keeps its name/price snapshots; just unlink the variants.
  const { error: unlinkErr } = await sb.from("transaction_items")
    .update({ variant_id: null }).not("variant_id", "is", null);
  if (unlinkErr) throw new Error(`unlink transaction_items: ${unlinkErr.message}`);
  console.log("✓ transaction_items unlinked from variants");

  for (const t of present) {
    const { error } = await sb.from(t).delete().neq("id", NIL);
    if (error) throw new Error(`delete ${t}: ${error.message}`);
    console.log(`✓ cleared ${t}`);
  }

  console.log(`\nDone — inventory wiped (${total} rows). Categories, locations, inventory`);
  console.log("types, employees, SOPs, tasks, menu, and sales history were left intact.");
}

main().catch((e) => { console.error(e); process.exit(1); });
