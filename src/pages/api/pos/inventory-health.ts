import type { APIRoute } from "astro";
import { fetchAll } from "../../../lib/fetchAll";

export const prerender = false;
const json = (d: unknown, s = 200) =>
  new Response(JSON.stringify(d), { status: s, headers: { "content-type": "application/json" } });

// Database-side filters, so only the ids of listings that need attention come
// back. (This used to download every listing's description and photo URL, from
// every open POS tab, every 30 seconds. That was most of the Supabase egress
// that got the project restricted in Oct 2026.) `eq.` with nothing after it
// matches "", which the old JS check (!p.image_url) counted as missing too.
const MISSING = "image_url.is.null,image_url.eq.,description.is.null,description.eq.";
const MISSING_NULLS = "image_url.is.null,description.is.null";
const NO_CONDITION = "completeness_code.is.null,completeness_code.eq.";

// Newest schema first; the later rows cover DBs without the soft-delete /
// draft-entry columns (migration 20260930000001 added pending_entry_id).
const LEVELS = [
  { deleted: true, pending: true, missing: MISSING },
  { deleted: true, pending: false, missing: MISSING },
  { deleted: false, pending: false, missing: MISSING },
  { deleted: false, pending: false, missing: MISSING_NULLS },
];

// Count of listings that still need attention (missing image, description, or a
// variant condition) — powers the Inventory nav badge.
export const GET: APIRoute = async ({ locals }) => {
  if (!locals.user) return json({ error: "unauthorized" }, 401);
  const sb = locals.supabase;

  for (const lv of LEVELS) {
    // Paged — one request stops at 1,000 rows.
    const bare = await fetchAll((from, to) => {
      let q = sb.from("products").select("id").or(lv.missing);
      if (lv.deleted) q = q.is("deleted_at", null);
      if (lv.pending) q = q.is("pending_entry_id", null);
      return q.order("id").range(from, to);
    });
    if (bare.error) continue;
    // A draft's not-yet-finished stock rows don't count (same as the grid).
    const noCond = await fetchAll((from, to) => {
      let q = sb.from("product_variants").select("id, product_id, product:products!inner(id)").or(NO_CONDITION);
      if (lv.deleted) q = q.is("product.deleted_at", null);
      if (lv.pending) q = q.is("pending_entry_id", null).is("product.pending_entry_id", null);
      return q.order("id").range(from, to);
    });
    if (noCond.error) continue;
    const ids = new Set<string>([...bare.data.map((p: any) => p.id), ...noCond.data.map((v: any) => v.product_id)]);
    return json({ ok: true, count: ids.size });
  }
  return json({ ok: true, count: 0 });
};
