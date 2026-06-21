import type { APIRoute } from "astro";
import { createSupabaseAdminClient } from "../../../lib/supabase";
import { searchGame, igdbConfigured } from "../../../lib/igdb";

export const prerender = false;
const json = (d: unknown, s = 200) =>
  new Response(JSON.stringify(d), { status: s, headers: { "content-type": "application/json" } });

// Copy an external image into our public bucket so we own a stable URL.
async function intoStorage(admin: any, url: string): Promise<string | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const bytes = new Uint8Array(await res.arrayBuffer());
    const path = `products/igdb-${crypto.randomUUID()}.jpg`;
    const { error } = await admin.storage.from("product-images").upload(path, bytes, { contentType: "image/jpeg" });
    if (error) return null;
    return admin.storage.from("product-images").getPublicUrl(path).data.publicUrl;
  } catch {
    return null;
  }
}

// POST { title, platform?, productId? }
// - returns the enriched fields (cover URL, description, release year, trailer, alt-names)
// - if productId is given, also persists them to the product (used by auto-enrich on add)
export const POST: APIRoute = async ({ locals, request }) => {
  if (!locals.user) return json({ error: "unauthorized" }, 401);
  if (!igdbConfigured()) return json({ error: "IGDB is not configured" }, 400);

  const b = await request.json().catch(() => ({}));
  const title = String(b.title ?? "").trim();
  if (!title) return json({ error: "title required" }, 400);

  let meta;
  try {
    meta = await searchGame(title, b.platform);
  } catch (e: any) {
    return json({ error: e.message || "IGDB lookup failed" }, 502);
  }
  if (!meta) return json({ ok: true, found: false });

  const admin = createSupabaseAdminClient();
  const imageUrl = meta.coverUrl ? await intoStorage(admin, meta.coverUrl) : null;

  if (b.productId) {
    const patch: Record<string, unknown> = {};
    if (imageUrl) patch.image_url = imageUrl;
    if (meta.summary) patch.description = meta.summary;
    if (meta.releaseYear) patch.release_year = meta.releaseYear;
    if (meta.trailerUrl) patch.trailer_url = meta.trailerUrl;
    if (meta.altNames.length) patch.alternative_names = meta.altNames;
    if (Object.keys(patch).length) await admin.from("products").update(patch).eq("id", b.productId);
  }

  return json({
    ok: true,
    found: true,
    matchedName: meta.name,
    imageUrl,
    description: meta.summary,
    releaseYear: meta.releaseYear,
    trailerUrl: meta.trailerUrl,
    altNames: meta.altNames,
  });
};
