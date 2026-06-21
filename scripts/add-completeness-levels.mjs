// ============================================================================
// Add/refresh store completeness levels in the cloud DB (service-role DML).
//   node --env-file=.env scripts/add-completeness-levels.mjs
// Idempotent — upserts on `code`. Mirrors supabase/migrations/*certified_open_box.
// ============================================================================
import { createClient } from "@supabase/supabase-js";

const url = process.env.PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Missing PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env");
  process.exit(1);
}
const sb = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });

const rows = [
  {
    code: "COB",
    label: "Certified Open Box",
    aliases: ["cob", "certified open box", "open box", "openbox", "open-box"],
    sort_order: 5,
    badge_label: "Open Box",
    banner_on_thumbnail: false,
    use_as_filter: true,
    is_active: true,
  },
];

const { data, error } = await sb.from("completeness_levels").upsert(rows, { onConflict: "code" }).select();
if (error) {
  console.error("Upsert failed:", error.message);
  process.exit(1);
}
console.log("Upserted:", data.map((r) => `${r.code} → ${r.label}`).join(", "));

const { data: all } = await sb
  .from("completeness_levels")
  .select("code,label,sort_order,is_active")
  .order("sort_order");
console.log("\nAll completeness levels now:");
for (const r of all ?? []) console.log(`  ${r.sort_order}. ${r.code.padEnd(4)} ${r.label}${r.is_active ? "" : " (inactive)"}`);
