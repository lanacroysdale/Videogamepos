import type { APIRoute } from "astro";
import { createSupabaseAdminClient } from "../../../lib/supabase";
import { searchGame, igdbConfigured } from "../../../lib/igdb";
import { lbPlatform, lbImageUrl } from "../../../lib/launchbox";
import { copyImageToStorage } from "../../../lib/storage";
import { sameGameName, sameBoxRelease } from "../../../lib/upcMatch";
import { withoutTrailingPlatform } from "../../../lib/smartSearch";

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

  // Only the SAME game's art and details — a near-miss name is often another
  // game ("My Friend Pedro" ≠ "My Friend Peppa Pig", "Advance Wars 2" ≠
  // "Advance Wars", a ROM hack ≠ "Pokémon FireRed"). Unsure → leave it empty.
  const platform = String(b.platform ?? "");
  const same = (name: string) => sameGameName(title, name, platform);

  // 1. IGDB metadata (description, trailer, release year, alt-names, fallback cover).
  let meta: Awaited<ReturnType<typeof searchGame>> = null;
  if (igdbConfigured()) {
    try { meta = await searchGame(title, b.platform, same); } catch { meta = null; }
  }

  // 2. LaunchBox retail box art — preferred cover source. Defaults to the 3D
  //    box render (the angled "stock" look) when available; pass { flat:true }
  //    to use the flat front instead. Falls back to front when no 3D exists.
  let coverUrl: string | null = meta?.coverUrl ?? null;
  let coverSource: string | null = meta?.coverUrl ? "igdb" : null;
  try {
    // The closest few names on that platform, not just the closest one: the
    // nearest can be a hack or a sequel while the real game is next in line.
    const lbp = lbPlatform(b.platform);
    const q = withoutTrailingPlatform(title.replace(/\[[^\]]*\]|\([^)]*\)/g, " ").replace(/\s+/g, " ").trim(), platform);
    let cands: any[] = [];
    const { data: found, error: sErr } = await admin.rpc("search_games", { p_query: q, p_platform: lbp, p_limit: 10 });
    if (!sErr && Array.isArray(found)) cands = found;
    if (!cands.length) {
      const { data: lb } = await admin.rpc("lookup_box_art", { p_title: q, p_platform: lbp });
      cands = Array.isArray(lb) ? lb : lb ? [lb] : [];
    }
    const art = cands.filter((c: any) => (c.box_front || c.box_3d) && (c.sim ?? 0) >= 0.4);
    // That exact release's box first ("… [Classic NES Series]"), else the game's.
    const best = art.find((c: any) => sameBoxRelease(title, String(c.name ?? ""), platform)) || art.find((c: any) => same(String(c.name ?? "")));
    if (best) {
      const threeD = b.flat ? null : best.box_3d;
      const file = threeD || best.box_front;
      if (file) { coverUrl = lbImageUrl(file); coverSource = threeD ? "launchbox-3d" : "launchbox"; }
    }
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

  // With { force:true } we re-pull the cover even if one already exists (used to
  // refresh game covers to the 3D art); otherwise fill-empty-only (resync-safe).
  const needImage = !b.productId || !cur?.image_url || b.force;
  const imageUrl = coverUrl && needImage ? await intoStorage(admin, coverUrl) : null;

  if (b.productId) {
    const patch: Record<string, unknown> = {};
    if (imageUrl && (b.force || !cur?.image_url)) patch.image_url = imageUrl;
    // appendDescription (Sell Similar): the listing's description is the eBay
    // title — the game's summary goes under it instead of being skipped.
    if (meta?.summary && !cur?.description) patch.description = meta.summary;
    else if (meta?.summary && b.appendDescription && cur?.description && !String(cur.description).includes(meta.summary.slice(0, 60)))
      patch.description = `${cur.description}\n\n${meta.summary}`;
    if (meta?.releaseYear && !cur?.release_year) patch.release_year = meta.releaseYear;
    if (meta?.trailerUrl && !cur?.trailer_url) patch.trailer_url = meta.trailerUrl;
    // Merge (not fill-if-empty): an import may already have saved the sheet's
    // own spelling as a search name; IGDB's aliases join it.
    if (meta?.altNames?.length) {
      const have: string[] = Array.isArray(cur?.alternative_names) ? cur.alternative_names : [];
      const merged = [...new Set([...have, ...meta.altNames])];
      if (merged.length !== have.length) patch.alternative_names = merged;
    }
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
