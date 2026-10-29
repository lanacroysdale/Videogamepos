#!/usr/bin/env node
// Move every photo / logo / font from the Supabase "product-images" bucket to
// Cloudflare R2, then point the database at the R2 copies.
//
//   npm run images:to-r2 -- --dry-run          bucket size, what's already in R2, CORS check
//   npm run images:to-r2                       copy to R2 + rewrite the URLs
//   npm run images:to-r2 -- --delete-supabase  …then delete the Supabase copies
//                                              that R2 has byte-for-byte
//
// The order that keeps every photo working:
//   1. Cloudflare: bucket, its img. custom domain, CORS (see .env.example).
//      R2_* vars in the local .env only.
//   2. --dry-run, then a plain run. The live app still uploads to Supabase
//      meanwhile; those old addresses keep working.
//   3. Add the R2_* vars in Vercel and redeploy (new uploads → R2).
//   4. Run it again: copies whatever was uploaded between 2 and 3.
//   5. Reload every open POS tab. Later (a day is plenty), --delete-supabase.
//
// Safe to re-run: files R2 already has are skipped, URLs already rewritten
// don't match again. A file R2 has under the same name but with different
// bytes is reported and left alone on both sides (never deleted). Needs
// PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY and the R2_* vars in .env.
import { createClient } from "@supabase/supabase-js";
import { r2, r2Configured } from "../src/lib/r2.ts";
import { POS_HOST } from "../src/consts.ts";

const DRY = process.argv.includes("--dry-run");
const DELETE = process.argv.includes("--delete-supabase");
const BUCKET = "product-images";
// The POS page that loads label logos / fonts cross-origin (CORS check).
const ORIGIN = process.env.POS_ORIGIN?.trim() || `https://${POS_HOST}`;

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

// Supabase's eTag and R2's are both the MD5 for a single-part upload; when
// either isn't (a multipart "…-N"), the size alone decides.
const md5 = (etag) => (/^"?([0-9a-f]{32})"?$/i.exec(etag || "") || [])[1]?.toLowerCase();
const sameFile = (f, h) => !!h && h.size === f.size && (!md5(f.etag) || !md5(h.etag) || md5(f.etag) === md5(h.etag));

async function listAll(prefix = "") {
  const out = [];
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await sb.storage.from(BUCKET).list(prefix, { limit: 1000, offset, sortBy: { column: "name", order: "asc" } });
    if (error) throw new Error(`list ${prefix || "/"}: ${error.message}`);
    for (const item of data) {
      if (item.name.startsWith(".")) continue; // .emptyFolderPlaceholder
      const p = prefix ? `${prefix}/${item.name}` : item.name;
      if (item.id === null) out.push(...(await listAll(p)));
      else out.push({ path: p, size: item.metadata?.size ?? 0, type: item.metadata?.mimetype || "", etag: item.metadata?.eTag || "" });
    }
    if (data.length < 1000) return out;
  }
}

async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) await fn(items[i++]); }));
}

// Copies what R2 doesn't have yet. `conflicts` = same name in R2, other bytes.
async function copyFiles(files) {
  const r = { copied: 0, skipped: 0, failed: 0, conflicts: [] };
  let done = 0;
  await pool(files, 6, async (f) => {
    try {
      const h = await bucket.head(f.path);
      if (h && sameFile(f, h)) { r.skipped++; return; }
      if (h) { r.conflicts.push(f.path); return; }
      const { data: blob, error } = await sb.storage.from(BUCKET).download(f.path);
      if (error) throw new Error(error.message);
      const bytes = new Uint8Array(await blob.arrayBuffer());
      if (bytes.length !== f.size) throw new Error(`downloaded ${bytes.length} bytes, expected ${f.size}`);
      await bucket.put(f.path, bytes, f.type || blob.type || "application/octet-stream", cacheFor(f.path));
      r.copied++;
    } catch (e) {
      r.failed++;
      console.error(`  ✗ ${f.path}: ${e.message}`);
    } finally {
      if (++done % 200 === 0) console.log(`  … ${done}/${files.length}`);
    }
  });
  return r;
}

const report = (label, r) => {
  console.log(`${label}: copied ${r.copied}, already there ${r.skipped}, failed ${r.failed}, conflicts ${r.conflicts.length}`);
  for (const p of r.conflicts.slice(0, 20)) console.log(`  ≠ ${p} (R2 has a different file under this name — both kept)`);
  if (r.conflicts.length > 20) console.log(`  … and ${r.conflicts.length - 20} more`);
};

// Label logos and fonts are fetched by the POS page from another origin, so
// the R2 domain must send Access-Control-Allow-Origin — even for a copy that
// was cached by a plain <img> load first (Cloudflare's cache ignores Origin).
async function corsOk(path) {
  const u = bucket.publicUrl(path);
  try {
    await fetch(u).then((r) => r.arrayBuffer()); // fill the cache the way an <img> would
    const res = await fetch(u, { headers: { Origin: ORIGIN } });
    await res.arrayBuffer();
    const acao = res.headers.get("access-control-allow-origin");
    if (res.ok && (acao === "*" || acao === ORIGIN)) return { ok: true };
    return { ok: false, why: res.ok ? `no Access-Control-Allow-Origin for ${ORIGIN}` : `HTTP ${res.status}` };
  } catch (e) { return { ok: false, why: e.message }; }
}

// products.image_url, menu_items.image_url, and the label templates' logo/font
// URLs in store_settings.settings. (OLD has no LIKE wildcards: a project ref
// is letters only, and the bucket name is fixed.)
async function rewriteUrls() {
  const counts = {};
  for (const table of ["products", "menu_items"]) {
    let n = 0;
    for (;;) {
      if (DRY) {
        const { count, error } = await sb.from(table).select("id", { count: "exact", head: true }).like("image_url", `${OLD}%`);
        if (error) { if (/does not exist|schema cache/i.test(error.message)) break; throw new Error(`${table}: ${error.message}`); }
        n = count ?? 0;
        break;
      }
      const { data, error } = await sb.from(table).select("id, image_url").like("image_url", `${OLD}%`).limit(500);
      if (error) { if (/does not exist|schema cache/i.test(error.message)) break; throw new Error(`${table}: ${error.message}`); }
      const rows = data.filter((row) => row.image_url.startsWith(OLD));
      if (!rows.length) break;
      let changed = 0;
      await pool(rows, 8, async (row) => {
        // Only if it still holds the old address (an edit meanwhile wins).
        const { data: hit, error: upErr } = await sb.from(table).update({ image_url: NEW + row.image_url.slice(OLD.length) })
          .eq("id", row.id).eq("image_url", row.image_url).select("id");
        if (upErr) throw new Error(`${table} ${row.id}: ${upErr.message}`);
        changed += hit?.length ?? 0;
      });
      n += changed;
      // A LIKE match that isn't really ours, or a round that changed nothing → stop, don't spin.
      if (rows.length < data.length || !changed) break;
    }
    counts[table] = n;
  }
  const { data: s, error } = await sb.from("store_settings").select("id, settings").eq("id", 1).maybeSingle();
  if (error) throw new Error(`store_settings: ${error.message}`);
  const before = JSON.stringify(s?.settings ?? null);
  const after = before.split(OLD).join(NEW);
  counts.store_settings = before.split(OLD).length - 1;
  if (!DRY && before !== after) {
    const { error: upErr } = await sb.from("store_settings").update({ settings: JSON.parse(after) }).eq("id", 1);
    if (upErr) throw new Error(`store_settings: ${upErr.message}`);
  }
  return counts;
}

async function main() {
  console.log(`Supabase ${BUCKET} → R2 bucket "${cfg.bucket}" (${NEW})${DRY ? "  [dry run]" : ""}\n`);
  const files = await listAll();
  console.log(`Supabase bucket: ${files.length} files, ${mb(files.reduce((a, f) => a + f.size, 0))}`);

  if (DRY) {
    let inR2 = 0, conflicts = 0, sample = "";
    await pool(files, 8, async (f) => {
      const h = await bucket.head(f.path);
      if (h && sameFile(f, h)) { inR2++; sample ||= f.path; } else if (h) conflicts++;
    });
    console.log(`Already in R2:   ${inR2}${conflicts ? `  (${conflicts} under the same name with different bytes)` : ""}`);
    if (sample) { const c = await corsOk(sample); console.log(`CORS for ${ORIGIN}: ${c.ok ? "ok" : "MISSING — " + c.why}`); }
    else console.log("CORS: checked after the first copy");
  } else {
    const r = await copyFiles(files);
    report("Copy", r);
    if (r.failed) { console.error("\nSome files didn't copy — re-run to retry them. No URLs were changed."); process.exit(1); }
    const sample = files.find((f) => !r.conflicts.includes(f.path))?.path;
    const c = sample ? await corsOk(sample) : { ok: true };
    if (!c.ok) {
      console.error(`\nThe R2 domain doesn't allow ${ORIGIN} (${c.why}). Label logos and fonts would stop printing,`);
      console.error("so no URLs were changed. Add the CORS rule from .env.example, then re-run (copies are kept).");
      process.exit(1);
    }
  }

  const counts = await rewriteUrls();
  console.log(`${DRY ? "URLs to rewrite" : "URLs rewritten"}: ${Object.entries(counts).map(([t, n]) => `${t} ${n}`).join(", ")}`);

  if (!DRY) {
    // Anything uploaded while the copy ran: its row may just have been
    // rewritten to R2, so it has to be there too.
    const seen = new Set(files.map((f) => f.path));
    const late = (await listAll()).filter((f) => !seen.has(f.path));
    if (late.length) {
      const r = await copyFiles(late);
      report(`Uploaded during the run (${late.length})`, r);
      if (r.failed) { console.error("\nRe-run to copy the rest before deleting anything."); process.exit(1); }
      files.push(...late);
    }
  }

  if (DELETE && !DRY) {
    const gone = [];
    let kept = 0;
    await pool(files, 8, async (f) => { if (sameFile(f, await bucket.head(f.path))) gone.push(f.path); else kept++; });
    for (let i = 0; i < gone.length; i += 100) {
      const { error } = await sb.storage.from(BUCKET).remove(gone.slice(i, i + 100));
      if (error) throw new Error(`remove: ${error.message}`);
    }
    console.log(`Deleted ${gone.length} Supabase copies; kept ${kept} that R2 doesn't have byte-for-byte.`);
  } else if (DELETE) {
    console.log("(--delete-supabase ignored on a dry run)");
  }
  console.log("\nDone.");
}

main().catch((e) => { console.error(e); process.exit(1); });
