import type { APIRoute } from "astro";
import { createSupabaseAdminClient } from "../../../lib/supabase";
import { shrinkImage } from "../../../lib/imageShrink";
import { listSupabase, r2Configured, r2List, r2Delete, type StoredFile } from "../../../lib/imageStore";

export const prerender = false;
const json = (d: unknown, s = 200) =>
  new Response(JSON.stringify(d), { status: s, headers: { "content-type": "application/json" } });

// Every application table, for the downloadable backup.
const ALL_TABLES = [
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

// Inventory-only wipe set, children before parents so FKs never block.
// Deliberately excludes categories, locations, inventory types (store config)
// and customers/transactions (sales history).
const INVENTORY_TABLES = [
  "inventory_entry_items", "inventory_entries", "stock_movements",
  "price_changes", "product_barcodes", "product_skus", "product_suppliers",
  "game_metadata", "product_variants", "products",
];

const NIL = "00000000-0000-0000-0000-000000000000";

// A live database can lag the migration folder (tables added after its last
// schema push). Missing tables hold nothing to back up or wipe — skip them.
const isMissingTable = (msg: string) => /could not find the table/i.test(msg);

// Returns null when the table doesn't exist in this database.
async function fetchAll(admin: ReturnType<typeof createSupabaseAdminClient>, table: string) {
  const rows: unknown[] = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await admin.from(table).select("*").range(from, from + PAGE - 1);
    if (error) {
      if (isMissingTable(error.message)) return null;
      throw new Error(`${table}: ${error.message}`);
    }
    rows.push(...data);
    if (data.length < PAGE) break;
  }
  return rows;
}

// GET → download a full JSON backup of every table. Owners only. Also stamps
// settings.lastBackupAt, which the reset below requires to be <24h old.
export const GET: APIRoute = async ({ locals }) => {
  if (!locals.user) return json({ error: "unauthorized" }, 401);
  if (!locals.can("maintenance.manage")) return json({ error: "You don't have permission for the danger zone" }, 403);

  const admin = createSupabaseAdminClient();
  try {
    const tables: Record<string, unknown[]> = {};
    const skippedTables: string[] = [];
    for (const t of ALL_TABLES) {
      const rows = await fetchAll(admin, t);
      if (rows === null) skippedTables.push(t);
      else tables[t] = rows;
    }

    const { data: cur } = await admin.from("store_settings").select("settings").eq("id", 1).maybeSingle();
    await admin.from("store_settings")
      .update({ settings: { ...(cur?.settings ?? {}), lastBackupAt: new Date().toISOString() } })
      .eq("id", 1);

    const stamp = new Date().toISOString().slice(0, 19).replace(/[:]/g, "-");
    const body = JSON.stringify({ exportedAt: new Date().toISOString(), skippedTables, tables }, null, 1);
    return new Response(body, {
      headers: {
        "content-type": "application/json",
        "content-disposition": `attachment; filename="timelag-backup-${stamp}.json"`,
        "cache-control": "no-store",
      },
    });
  } catch (e: any) {
    return json({ error: e.message ?? String(e) }, 500);
  }
};

type Admin = ReturnType<typeof createSupabaseAdminClient>;

// Photos uploaded before resizing existed: anything that isn't already a
// web-sized WebP. Fonts, GIFs, SVGs etc. are left alone.
const needsShrink = (f: StoredFile) =>
  /^image\/(jpe?g|png|webp|avif|heic|heif|tiff)$/i.test(f.mimetype) &&
  (f.mimetype !== "image/webp" || f.size > 400_000);

// POST { action: "shrink-images", after?: string } → re-encode existing photos
// in place (same path, so every saved URL keeps working; served as WebP).
// Works in short batches so each request fits the serverless time limit; the
// client calls again with the returned `after` cursor until `done`.
async function shrinkBatch(admin: Admin, after: string) {
  const all = await listSupabase(admin);
  const todo = all.filter((f) => f.path > after && needsShrink(f));
  const deadline = Date.now() + 6000;
  let processed = 0, saved = 0, failed = 0;
  let cursor = after;
  const CONC = 4;
  for (let i = 0; i < todo.length && Date.now() < deadline; i += CONC) {
    const batch = todo.slice(i, i + CONC);
    await Promise.all(batch.map(async (f) => {
      try {
        const { data: blob, error } = await admin.storage.from("product-images").download(f.path);
        if (error || !blob) throw new Error(error?.message);
        const orig = new Uint8Array(await blob.arrayBuffer());
        const { bytes, contentType, shrunk } = await shrinkImage(orig, f.mimetype);
        if (shrunk) {
          const { error: upErr } = await admin.storage.from("product-images")
            .upload(f.path, bytes, { contentType, upsert: true });
          if (upErr) throw new Error(upErr.message);
          saved += orig.byteLength - bytes.byteLength;
        }
        processed++;
      } catch {
        failed++;
      }
    }));
    cursor = batch[batch.length - 1].path;
  }
  const remaining = all.filter((f) => f.path > cursor && needsShrink(f)).length;
  const bucketBytes = all.reduce((a, f) => a + f.size, 0) - saved;
  return { ok: true, processed, failed, saved, remaining, done: remaining === 0, after: cursor, bucketBytes };
}

// POST { confirm: "WIPE", deletePhotos?: boolean } → wipe inventory tables.
// Owners only, requires the typed confirmation AND a backup within 24h.
// Sales history keeps its name/price snapshots; line items are unlinked from
// the deleted variants first (that FK has no cascade).
export const POST: APIRoute = async ({ locals, request }) => {
  if (!locals.user) return json({ error: "unauthorized" }, 401);
  if (!locals.can("maintenance.manage")) return json({ error: "You don't have permission for the danger zone" }, 403);

  const b = await request.json().catch(() => ({}));
  if (b.action === "shrink-images") {
    try {
      return json(await shrinkBatch(createSupabaseAdminClient(), typeof b.after === "string" ? b.after : ""));
    } catch (e: any) {
      return json({ error: e.message ?? String(e) }, 500);
    }
  }
  if (b.confirm !== "WIPE") return json({ error: 'Type WIPE to confirm.' }, 400);

  const admin = createSupabaseAdminClient();
  try {
    const { data: cur } = await admin.from("store_settings").select("settings").eq("id", 1).maybeSingle();
    const last = Date.parse(cur?.settings?.lastBackupAt ?? "");
    if (!last || Date.now() - last > 24 * 60 * 60 * 1000) {
      return json({ error: "No backup in the last 24 hours — download a backup first." }, 428);
    }

    const counts: Record<string, number> = {};
    const present: string[] = [];
    for (const t of INVENTORY_TABLES) {
      const { count, error } = await admin.from(t).select("*", { count: "exact", head: true });
      if (error) {
        if (isMissingTable(error.message)) continue;
        throw new Error(`count ${t}: ${error.message}`);
      }
      present.push(t);
      counts[t] = count ?? 0;
    }

    const { error: unlinkErr } = await admin.from("transaction_items")
      .update({ variant_id: null }).not("variant_id", "is", null);
    if (unlinkErr) throw new Error(`unlink transaction_items: ${unlinkErr.message}`);

    for (const t of present) {
      const { error } = await admin.from(t).delete().neq("id", NIL);
      if (error) throw new Error(`delete ${t}: ${error.message}`);
    }

    let photosDeleted = 0;
    if (b.deletePhotos) {
      const walk = async (prefix: string) => {
        const { data, error } = await admin.storage.from("product-images").list(prefix, { limit: 1000 });
        if (error) throw new Error(`storage list: ${error.message}`);
        const files: string[] = [];
        for (const item of data ?? []) {
          const p = prefix ? `${prefix}/${item.name}` : item.name;
          if (item.id === null) await walk(p);
          else files.push(p);
        }
        for (let i = 0; i < files.length; i += 100) {
          const batch = files.slice(i, i + 100);
          const { error: rmErr } = await admin.storage.from("product-images").remove(batch);
          if (rmErr) throw new Error(`storage remove: ${rmErr.message}`);
          photosDeleted += batch.length;
        }
      };
      await walk("");
      if (r2Configured()) {
        const keys = (await r2List("")).map((o) => o.key);
        await r2Delete(keys);
        photosDeleted += keys.length;
      }
    }

    await admin.from("store_settings")
      .update({ settings: { ...(cur?.settings ?? {}), lastInventoryResetAt: new Date().toISOString() } })
      .eq("id", 1);

    const total = Object.values(counts).reduce((a, n) => a + n, 0);
    return json({ ok: true, total, counts, photosDeleted });
  } catch (e: any) {
    return json({ error: e.message ?? String(e) }, 500);
  }
};
