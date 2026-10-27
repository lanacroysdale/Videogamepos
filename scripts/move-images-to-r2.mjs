#!/usr/bin/env node
// Move every photo / logo / font from the Supabase "product-images" bucket to
// Cloudflare R2, then point the database at the R2 copies.
//
//   npm run images:to-r2 -- --dry-run          what would move, and how big the bucket is
//   npm run images:to-r2                       copy to R2 + rewrite the URLs
//   npm run images:to-r2 -- --delete-supabase  …then delete the Supabase copies
//                                              (only ones confirmed in R2) to free
//                                              the 1 GB free-plan storage
//
// Safe to re-run: files already in R2 are skipped, and URLs already rewritten
// don't match again. Needs PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY and
// the R2_* vars (see .env.example) in .env.
import { createClient } from "@supabase/supabase-js";
import { r2, r2Configured } from "../src/lib/r2.ts";

const DRY = process.argv.includes("--dry-run");
const DELETE = process.argv.includes("--delete-supabase");
const BUCKET = "product-images";

const url = process.env.PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
const cfg = {
  accountId: process.env.R2_ACCOUNT_ID?.trim(),
  accessKeyId: process.env.R2_ACCESS_KEY_ID?.trim(),
  secretAccessKey: process.env.R2_SECRET_ACCESS_KEY?.trim(),
  bucket: process.env.R2_BUCKET?.trim(),
  publicUrl: process.env.R2_PUBLIC_URL?.trim(),
};
if (!url || !key) { console.error("Missing PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env"); process.exit(1); }
if (!r2Configured(cfg)) { console.error("Missing R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY / R2_BUCKET / R2_PUBLIC_URL in .env"); process.exit(1); }

const sb = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
const bucket = r2(cfg);
const OLD = `${url.replace(/\/+$/, "")}/storage/v1/object/public/${BUCKET}/`;
const NEW = `${cfg.publicUrl.replace(/\/+$/, "")}/`;
const mb = (n) => (n / 1024 / 1024).toFixed(1) + " MB";

// Same cache rule as src/lib/imageBucket.ts: uuid-named files never change.
const cacheFor = (path) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(path.split("/").pop().replace(/^[a-z]+-/, ""))
    ? "public, max-age=31536000, immutable" : "public, max-age=3600";

async function listAll(prefix = "") {
  const out = [];
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await sb.storage.from(BUCKET).list(prefix, { limit: 1000, offset, sortBy: { column: "name", order: "asc" } });
    if (error) throw new Error(`list ${prefix || "/"}: ${error.message}`);
    for (const item of data) {
      if (item.name.startsWith(".")) continue; // .emptyFolderPlaceholder
      const p = prefix ? `${prefix}/${item.name}` : item.name;
      if (item.id === null) out.push(...(await listAll(p)));
      else out.push({ path: p, size: item.metadata?.size ?? 0, type: item.metadata?.mimetype || "" });
    }
    if (data.length < 1000) return out;
  }
}

async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) await fn(items[i++]); }));
}

async function copyFiles(files) {
  let copied = 0, skipped = 0, failed = 0, done = 0;
  await pool(files, 6, async (f) => {
    try {
      if (await bucket.exists(f.path)) { skipped++; return; }
      const { data: blob, error } = await sb.storage.from(BUCKET).download(f.path);
      if (error) throw new Error(error.message);
      await bucket.put(f.path, new Uint8Array(await blob.arrayBuffer()), f.type || blob.type || "application/octet-stream", cacheFor(f.path));
      copied++;
    } catch (e) {
      failed++;
      console.error(`  ✗ ${f.path}: ${e.message}`);
    } finally {
      if (++done % 200 === 0) console.log(`  … ${done}/${files.length}`);
    }
  });
  return { copied, skipped, failed };
}

// products.image_url, menu_items.image_url, and the label templates' logo/font
// URLs in store_settings.settings.
async function rewriteUrls() {
  const counts = {};
  for (const table of ["products", "menu_items"]) {
    let n = 0;
    for (;;) {
      const { data, error } = await sb.from(table).select("id, image_url").like("image_url", `${OLD}%`).limit(500);
      if (error) { if (/does not exist|schema cache/i.test(error.message)) break; throw new Error(`${table}: ${error.message}`); }
      if (!data.length) break;
      if (DRY) { const { count } = await sb.from(table).select("id", { count: "exact", head: true }).like("image_url", `${OLD}%`); n = count ?? data.length; break; }
      await pool(data, 8, async (row) => {
        const { error: upErr } = await sb.from(table).update({ image_url: NEW + row.image_url.slice(OLD.length) }).eq("id", row.id);
        if (upErr) throw new Error(`${table} ${row.id}: ${upErr.message}`);
      });
      n += data.length;
    }
    counts[table] = n;
  }
  const { data: s, error } = await sb.from("store_settings").select("id, settings").eq("id", 1).maybeSingle();
  if (error) throw new Error(`store_settings: ${error.message}`);
  const before = JSON.stringify(s?.settings ?? null);
  const after = before.split(OLD).join(NEW);
  counts.store_settings = before === after ? 0 : before.split(OLD).length - 1;
  if (!DRY && before !== after) {
    const { error: upErr } = await sb.from("store_settings").update({ settings: JSON.parse(after) }).eq("id", 1);
    if (upErr) throw new Error(`store_settings: ${upErr.message}`);
  }
  return counts;
}

async function main() {
  console.log(`Supabase ${BUCKET} → R2 bucket "${cfg.bucket}" (${NEW})${DRY ? "  [dry run]" : ""}\n`);
  const files = await listAll();
  const total = files.reduce((a, f) => a + f.size, 0);
  console.log(`Supabase bucket: ${files.length} files, ${mb(total)}`);

  if (DRY) {
    let inR2 = 0;
    await pool(files, 8, async (f) => { if (await bucket.exists(f.path)) inR2++; });
    console.log(`Already in R2:   ${inR2}`);
  } else {
    const r = await copyFiles(files);
    console.log(`Copied ${r.copied}, already there ${r.skipped}, failed ${r.failed}`);
    if (r.failed) { console.error("\nSome files didn't copy — re-run to retry them. URLs not rewritten yet."); process.exit(1); }
  }

  const counts = await rewriteUrls();
  console.log(`${DRY ? "URLs to rewrite" : "URLs rewritten"}: ${Object.entries(counts).map(([t, n]) => `${t} ${n}`).join(", ")}`);

  if (DELETE && !DRY) {
    let removed = 0;
    const gone = [];
    await pool(files, 8, async (f) => { if (await bucket.exists(f.path)) gone.push(f.path); });
    for (let i = 0; i < gone.length; i += 100) {
      const { error } = await sb.storage.from(BUCKET).remove(gone.slice(i, i + 100));
      if (error) throw new Error(`remove: ${error.message}`);
      removed += gone.slice(i, i + 100).length;
    }
    console.log(`Deleted ${removed} Supabase copies (${files.length - removed} left).`);
  } else if (DELETE) {
    console.log("(--delete-supabase ignored on a dry run)");
  }
  console.log("\nDone.");
}

main().catch((e) => { console.error(e); process.exit(1); });
