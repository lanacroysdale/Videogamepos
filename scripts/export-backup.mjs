// ============================================================================
// Full local backup of the Supabase database (and optionally product images).
// Writes every table to backups/<timestamp>/<table>.json + .csv so the data
// survives a database wipe or a full Supabase project deletion.
//
// Run with:  npm run db:export            (tables only)
//            npm run db:export -- --with-images   (also download product images)
//
// Requires PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in .env (same keys
// the app and seed script use). Read-only: makes no changes to the database.
// ============================================================================
import { createClient } from "@supabase/supabase-js";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const url = process.env.PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Missing PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env");
  process.exit(1);
}
const sb = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });

// Every application table (from supabase/migrations). Auth users are exported
// separately below; storage objects with --with-images.
const TABLES = [
  "categories", "completeness_levels", "condition_grades", "customers",
  "daily_task_completions", "daily_task_templates", "game_metadata",
  "inventory_entries", "inventory_entry_items", "leads",
  "menu_item_modifier_groups", "menu_item_sizes", "menu_items",
  "menu_modifier_groups", "menu_modifier_options", "menu_sections",
  "price_changes", "product_barcodes", "product_skus", "product_suppliers",
  "product_variants", "products", "profiles", "repairs", "shifts",
  "sop_files", "sops", "stock_movements", "store_departments",
  "store_inventory_types", "store_locations", "store_settings",
  "task_files", "tasks", "time_entries", "trade_margins",
  "transaction_items", "transactions",
];

const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const outDir = path.join(process.cwd(), "backups", stamp);

// Returns null for tables the live database doesn't have (schema behind the
// migrations folder) — nothing there to back up.
async function fetchAll(table) {
  const rows = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await sb.from(table).select("*").range(from, from + PAGE - 1);
    if (error) {
      if (/could not find the table/i.test(error.message)) return null;
      throw new Error(`${table}: ${error.message}`);
    }
    rows.push(...data);
    if (data.length < PAGE) break;
  }
  return rows;
}

function toCsv(rows) {
  if (!rows.length) return "";
  const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const cell = (v) => {
    if (v === null || v === undefined) return "";
    const s = typeof v === "object" ? JSON.stringify(v) : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.join(","), ...rows.map((r) => cols.map((c) => cell(r[c])).join(","))].join("\n") + "\n";
}

async function main() {
  await mkdir(outDir, { recursive: true });
  let total = 0;

  for (const table of TABLES) {
    const rows = await fetchAll(table);
    if (rows === null) { console.log(`– ${table.padEnd(28)} (not in this database, skipped)`); continue; }
    await writeFile(path.join(outDir, `${table}.json`), JSON.stringify(rows, null, 2));
    await writeFile(path.join(outDir, `${table}.csv`), toCsv(rows));
    total += rows.length;
    console.log(`✓ ${table.padEnd(28)} ${rows.length} rows`);
  }

  // Auth users (email/metadata only — password hashes are not exportable).
  const users = [];
  for (let page = 1; ; page++) {
    const { data, error } = await sb.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw error;
    users.push(...data.users.map((u) => ({
      id: u.id, email: u.email, created_at: u.created_at,
      last_sign_in_at: u.last_sign_in_at, user_metadata: u.user_metadata,
    })));
    if (data.users.length < 1000) break;
  }
  await writeFile(path.join(outDir, "auth_users.json"), JSON.stringify(users, null, 2));
  console.log(`✓ ${"auth_users".padEnd(28)} ${users.length} users`);

  if (process.argv.includes("--with-images")) {
    const imgDir = path.join(outDir, "product-images");
    await mkdir(imgDir, { recursive: true });
    let count = 0;
    async function walk(prefix) {
      const { data, error } = await sb.storage.from("product-images")
        .list(prefix, { limit: 1000 });
      if (error) throw new Error(`storage list ${prefix || "/"}: ${error.message}`);
      for (const item of data) {
        const p = prefix ? `${prefix}/${item.name}` : item.name;
        if (item.id === null) { await walk(p); continue; } // folder
        const { data: blob, error: dlErr } = await sb.storage.from("product-images").download(p);
        if (dlErr) throw new Error(`download ${p}: ${dlErr.message}`);
        const file = path.join(imgDir, p);
        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(file, Buffer.from(await blob.arrayBuffer()));
        count++;
      }
    }
    await walk("");
    console.log(`✓ ${"product-images".padEnd(28)} ${count} files`);
  }

  console.log(`\nBackup complete → ${outDir}  (${total} table rows)`);
  console.log("Keep this folder somewhere safe — it is gitignored and only exists locally.");
}

main().catch((e) => { console.error(e); process.exit(1); });
