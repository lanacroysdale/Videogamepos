import type { APIRoute } from "astro";
import { createSupabaseAdminClient } from "../../../lib/supabase";
import { shrinkImage } from "../../../lib/imageShrink";
import {
  SUPABASE_BUCKET, listSupabase, r2Configured, r2List, r2Put, r2Delete,
  supabasePublicPrefix, r2PublicPrefix, StorageCapError,
  r2UsedBytes, r2CapEnabled, forgetR2CapSetting, R2_FREE_BYTES, R2_CAP_BYTES,
} from "../../../lib/imageStore";

export const prerender = false;
const json = (d: unknown, s = 200) =>
  new Response(JSON.stringify(d), { status: s, headers: { "content-type": "application/json" } });

// Owner maintenance for photo storage (Settings → Danger zone). Every action
// works in short, resumable batches so each request fits the serverless time
// limit; the page keeps calling until `done`.
//
//   { action: "move-to-r2", phase: "copy" | "relink" | "cleanup", after? }
//   { action: "delete-ebay", confirm: "DELETE" }
//   { action: "set-r2-cap", enabled: boolean }

const BUDGET_MS = 6000;
// Photo folders that move to R2. Custom label fonts (fonts/) stay in Supabase.
const PHOTO_PREFIXES = ["products", "menu"];
const EBAY_COVER = "products/ebay-";
const GALLERY = "products/gallery/";

type Admin = ReturnType<typeof createSupabaseAdminClient>;

async function supabasePhotos(admin: Admin) {
  const lists = await Promise.all(PHOTO_PREFIXES.map((p) => listSupabase(admin, p)));
  return lists.flat().sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

async function r2Keys(): Promise<Set<string>> {
  const lists = await Promise.all(PHOTO_PREFIXES.map((p) => r2List(`${p}/`)));
  return new Set(lists.flat().map((o) => o.key));
}

// Phase 1: copy every Supabase photo that isn't in R2 yet (shrinking on the way).
async function copyPhase(admin: Admin, after: string) {
  const [files, inR2] = await Promise.all([supabasePhotos(admin), r2Keys()]);
  const todo = files.filter((f) => f.path > after && !inR2.has(f.path));
  const deadline = Date.now() + BUDGET_MS;
  let copied = 0, failed = 0, cursor = after;
  const CONC = 4;
  for (let i = 0; i < todo.length && Date.now() < deadline; i += CONC) {
    const batch = todo.slice(i, i + CONC);
    await Promise.all(batch.map(async (f) => {
      try {
        const { data: blob, error } = await admin.storage.from(SUPABASE_BUCKET).download(f.path);
        if (error || !blob) throw new Error(error?.message);
        const orig = new Uint8Array(await blob.arrayBuffer());
        const { bytes, contentType } = await shrinkImage(orig, f.mimetype || blob.type || "image/jpeg");
        await r2Put(f.path, bytes, contentType);
        copied++;
      } catch (e) {
        if (e instanceof StorageCapError) throw e; // stop the move; the page shows why
        failed++;
      }
    }));
    cursor = batch[batch.length - 1].path;
  }
  const remaining = todo.filter((f) => f.path > cursor).length;
  return { copied, failed, remaining, done: remaining === 0, after: cursor, total: files.length };
}

// Old link → new link, only for photos that really are in R2 now.
function relinker(inR2: Set<string>) {
  const from = supabasePublicPrefix(), to = r2PublicPrefix();
  return (url: string | null | undefined): string | null => {
    if (!url || !url.startsWith(from)) return null;
    const path = decodeURIComponent(url.slice(from.length).split("?")[0]);
    return inR2.has(path) ? to + path : null;
  };
}

// Rows in `table` whose image_url is an old Supabase link to a photo that's in
// R2 now, with the new link. Paged, since PostgREST caps each read at 1000.
async function pendingLinks(admin: Admin, table: string, fix: ReturnType<typeof relinker>) {
  const out: { id: string; url: string }[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await admin.from(table).select("id, image_url")
      .like("image_url", `${supabasePublicPrefix()}%`).order("id").range(from, from + 999);
    if (error) {
      if (/could not find the table/i.test(error.message)) return out;
      throw new Error(`${table}: ${error.message}`);
    }
    for (const r of data ?? []) {
      const url = fix((r as any).image_url);
      if (url) out.push({ id: (r as any).id, url });
    }
    if ((data?.length ?? 0) < 1000) return out;
  }
}
const LINK_TABLES = ["products", "menu_items"];

// Phase 2: point saved links at R2. First proves the public URL actually
// serves a copied photo, so a misconfigured domain can't break every image.
async function relinkPhase(admin: Admin) {
  const inR2 = await r2Keys();
  const sample = [...inR2][0];
  if (sample) {
    const res = await fetch(r2PublicPrefix() + sample, { method: "HEAD" }).catch(() => null);
    if (!res?.ok) {
      throw new Error(
        `R2 public URL isn't serving photos yet (${res ? res.status : "no response"} for ${r2PublicPrefix()}${sample}). ` +
        `Check R2_PUBLIC_URL and that public access is on for the bucket.`);
    }
  }
  const fix = relinker(inR2);
  const deadline = Date.now() + BUDGET_MS;
  let updated = 0, remaining = 0;

  for (const table of LINK_TABLES) {
    const rows = await pendingLinks(admin, table, fix);
    const CONC = 10;
    let i = 0;
    for (; i < rows.length && Date.now() < deadline; i += CONC) {
      await Promise.all(rows.slice(i, i + CONC).map(async (r) => {
        const { error: uErr } = await admin.from(table).update({ image_url: r.url }).eq("id", r.id);
        if (uErr) throw new Error(`${table}: ${uErr.message}`);
        updated++;
      }));
    }
    remaining += Math.max(0, rows.length - i);
  }

  // Store settings (logo, label-template images): swap any photo links inside the JSON.
  const { data: st } = await admin.from("store_settings").select("settings").eq("id", 1).maybeSingle();
  if (st?.settings) {
    const before = JSON.stringify(st.settings);
    const after = before.replace(/"(https?:[^"]+)"/g, (m, url) => {
      const u = fix(url);
      if (u) updated++;
      return u ? JSON.stringify(u) : m;
    });
    if (after !== before) {
      const { error } = await admin.from("store_settings").update({ settings: JSON.parse(after) }).eq("id", 1);
      if (error) throw new Error(`store_settings: ${error.message}`);
    }
  }
  return { updated, remaining, done: remaining === 0 };
}

// Phase 3: delete the Supabase copies of photos that are safely in R2.
async function cleanupPhase(admin: Admin) {
  const [files, inR2] = await Promise.all([supabasePhotos(admin), r2Keys()]);
  // Never delete a Supabase photo that a saved link still points at.
  const fix = relinker(inR2);
  for (const table of LINK_TABLES) {
    if ((await pendingLinks(admin, table, fix)).length) {
      throw new Error("Some links still point at Supabase — run the move again so it re-links them first.");
    }
  }
  const doomed = files.filter((f) => inR2.has(f.path)).map((f) => f.path);
  const deadline = Date.now() + BUDGET_MS;
  let removed = 0, freed = 0;
  const size = new Map(files.map((f) => [f.path, f.size]));
  for (let i = 0; i < doomed.length && Date.now() < deadline; i += 100) {
    const batch = doomed.slice(i, i + 100);
    const { error } = await admin.storage.from(SUPABASE_BUCKET).remove(batch);
    if (error) throw new Error(`storage remove: ${error.message}`);
    removed += batch.length;
    freed += batch.reduce((a, p) => a + (size.get(p) ?? 0), 0);
  }
  const remaining = doomed.length - removed;
  return { removed, freed, remaining, done: remaining === 0 };
}

// Delete every eBay-imported photo (covers named products/ebay-* and the
// per-product galleries, which only the eBay import creates) from both
// stores, and clear the product links that pointed at those covers.
async function deleteEbayBatch(admin: Admin) {
  const { count, error: cErr } = await admin.from("products")
    .update({ image_url: null }, { count: "exact" })
    .like("image_url", `%/${EBAY_COVER}%`);
  if (cErr) throw new Error(`products: ${cErr.message}`);

  const isEbay = (p: string) => p.startsWith(EBAY_COVER) || p.startsWith(GALLERY);
  const deadline = Date.now() + BUDGET_MS;
  let removed = 0;

  const sb = (await listSupabase(admin, "products")).map((f) => f.path).filter(isEbay);
  let sbLeft = sb.length;
  for (let i = 0; i < sb.length && Date.now() < deadline; i += 100) {
    const batch = sb.slice(i, i + 100);
    const { error } = await admin.storage.from(SUPABASE_BUCKET).remove(batch);
    if (error) throw new Error(`storage remove: ${error.message}`);
    removed += batch.length; sbLeft -= batch.length;
  }

  let r2Left = 0;
  if (r2Configured()) {
    const keys = (await r2List("products/")).map((o) => o.key).filter(isEbay);
    r2Left = keys.length;
    for (let i = 0; i < keys.length && Date.now() < deadline; i += 40) {
      const batch = keys.slice(i, i + 40);
      await r2Delete(batch);
      removed += batch.length; r2Left -= batch.length;
    }
  }
  const remaining = sbLeft + r2Left;
  return { removed, linksCleared: count ?? 0, remaining, done: remaining === 0 };
}

// GET → whether R2 is set up (the page uses it to enable the move button).
export const GET: APIRoute = async ({ locals }) => {
  if (!locals.user) return json({ error: "unauthorized" }, 401);
  if (!locals.can("maintenance.manage")) return json({ error: "You don't have permission for the danger zone" }, 403);
  if (!r2Configured()) return json({ r2: false });
  const [capOn, used] = await Promise.all([r2CapEnabled(true), r2UsedBytes(true).catch(() => null)]);
  return json({ r2: true, capOn, used, freeBytes: R2_FREE_BYTES, capBytes: R2_CAP_BYTES });
};

export const POST: APIRoute = async ({ locals, request }) => {
  if (!locals.user) return json({ error: "unauthorized" }, 401);
  if (!locals.can("maintenance.manage")) return json({ error: "You don't have permission for the danger zone" }, 403);

  const b = await request.json().catch(() => ({}));
  const admin = createSupabaseAdminClient();
  try {
    if (b.action === "move-to-r2") {
      if (!r2Configured()) {
        return json({ error: "R2 isn't set up yet — add the R2_* environment variables in Vercel and redeploy." }, 400);
      }
      const after = typeof b.after === "string" ? b.after : "";
      if (b.phase === "copy") return json({ ok: true, ...(await copyPhase(admin, after)) });
      if (b.phase === "relink") return json({ ok: true, ...(await relinkPhase(admin)) });
      if (b.phase === "cleanup") return json({ ok: true, ...(await cleanupPhase(admin)) });
      return json({ error: "Unknown phase" }, 400);
    }
    if (b.action === "set-r2-cap") {
      const { data: cur } = await admin.from("store_settings").select("settings").eq("id", 1).maybeSingle();
      const { error } = await admin.from("store_settings")
        .update({ settings: { ...(cur?.settings ?? {}), r2CapEnabled: !!b.enabled } })
        .eq("id", 1);
      if (error) throw new Error(error.message);
      forgetR2CapSetting();
      return json({ ok: true, capOn: !!b.enabled });
    }
    if (b.action === "delete-ebay") {
      if (b.confirm !== "DELETE") return json({ error: "Type DELETE to confirm." }, 400);
      return json({ ok: true, ...(await deleteEbayBatch(admin)) });
    }
    return json({ error: "Unknown action" }, 400);
  } catch (e: any) {
    return json({ error: e.message ?? String(e) }, 500);
  }
};
