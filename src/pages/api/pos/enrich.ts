import type { APIRoute } from "astro";
import { createSupabaseAdminClient } from "../../../lib/supabase";
import { searchGame, igdbConfigured } from "../../../lib/igdb";
import { lbPlatform, lbImageUrl } from "../../../lib/launchbox";
import { copyImageToStorage } from "../../../lib/storage";

export const prerender = false;
const json = (d: unknown, s = 200) =>
  new Response(JSON.stringify(d), { status: s, headers: { "content-type": "application/json" } });

const intoStorage = (admin: any, url: string) => copyImageToStorage(admin, url, "cover");

// POST { title, platform?, productId? }
// Cover image prefers the LaunchBox retail box-front; falls back to the IGDB
// cover. IGDB also supplies description / trailer / release year / alt-names.
// With productId it persists, filling ONLY empty fields (additive resync-safe).
export const POST: APIRoute = async ({ locals, request }) => {
  if (!locals.user) return json({ error: "unauthorized" }, 401);

  const b = await request.json().catch(() => ({}));
  const title = String(b.title ?? "").trim();
  if (!title) return json({ error: "title required" }, 400);

  const admin = createSupabaseAdminClient();

  // 1. IGDB metadata (description, trailer, release year, alt-names, fallback cover).
  let meta: Awaited<ReturnType<typeof searchGame>> = null;
  if (igdbConfigured()) {
    try { meta = await searchGame(title, b.platform); } catch { meta = null; }
  }

  // 2. LaunchBox retail box-front — preferred cover source.
  let coverUrl: string | null = meta?.coverUrl ?? null;
  let coverSource: string | null = meta?.coverUrl ? "igdb" : null;
  try {
    const { data: lb } = await admin.rpc("lookup_box_art", { p_title: title, p_platform: lbPlatform(b.platform) });
    const best = Array.isArray(lb) ? lb[0] : lb;
    if (best?.box_front && (best.sim ?? 0) >= 0.4) { coverUrl = lbImageUrl(best.box_front); coverSource = "launchbox"; }
  } catch { /* game_metadata not ingested yet → keep IGDB cover */ }

  if (!meta && !coverUrl) return json({ ok: true, found: false });

  // 3. Persist target — fill ONLY empty fields.
  let cur: any = null;
  if (b.productId) {
    ({ data: cur } = await admin
      .from("products")
      .select("image_url, description, trailer_url, alternative_names, release_year")
      .eq("id", b.productId)
      .maybeSingle());
  }

  const needImage = !b.productId || !cur?.image_url;
  const imageUrl = coverUrl && needImage ? await intoStorage(admin, coverUrl) : null;

  if (b.productId) {
    const patch: Record<string, unknown> = {};
    if (imageUrl && !cur?.image_url) patch.image_url = imageUrl;
    if (meta?.summary && !cur?.description) patch.description = meta.summary;
    if (meta?.releaseYear && !cur?.release_year) patch.release_year = meta.releaseYear;
    if (meta?.trailerUrl && !cur?.trailer_url) patch.trailer_url = meta.trailerUrl;
    if (meta?.altNames?.length && !(cur?.alternative_names?.length)) patch.alternative_names = meta.altNames;
    if (Object.keys(patch).length) await admin.from("products").update(patch).eq("id", b.productId);
  }

  return json({
    ok: true,
    found: true,
    coverSource,
    matchedName: meta?.name ?? null,
    imageUrl,
    description: meta?.summary ?? null,
    releaseYear: meta?.releaseYear ?? null,
    trailerUrl: meta?.trailerUrl ?? null,
    altNames: meta?.altNames ?? [],
  });
};
