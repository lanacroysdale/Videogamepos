import type { APIRoute } from "astro";
import { lbPlatform, lbImageUrl } from "../../../lib/launchbox";
import { resolveStaticPlatform } from "../../../lib/smartSearch";

export const prerender = false;
const json = (d: unknown, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { "content-type": "application/json" } });

// POST { q, platform? } → { games: [{ name, platform, lbPlatform, cover, sim }] }
// Official game titles from our local LaunchBox copy, for "From the game
// database" in the entry search — so a game the store has never stocked can be
// added under its real name. Fuzzy via search_games (migration
// 20260930000002); before that migration, an any-order word match.
export const POST: APIRoute = async ({ locals, request }) => {
  if (!locals.user) return json({ error: "unauthorized" }, 401);
  const b = await request.json().catch(() => ({}));
  const q = String(b.q ?? "").trim().slice(0, 100);
  if (q.length < 3) return json({ ok: true, games: [] });
  const lb = b.platform ? lbPlatform(String(b.platform)) : null;
  const sb = locals.supabase;
  let rows: any[] = [];
  const { data, error } = await sb.rpc("search_games", { p_query: q, p_platform: lb, p_limit: 8 });
  if (!error) rows = data ?? [];
  else {
    // Fallback: every word (any order) must appear in the normalized name.
    const words = q.toLowerCase().replace(/[^a-z0-9]+/g, " ").split(" ").filter((w) => w.length >= 2 && !["and", "the", "of"].includes(w)).slice(0, 6);
    if (!words.length) return json({ ok: true, games: [] });
    let query = sb.from("game_metadata").select("name, platform, box_front, box_3d");
    for (const w of words) query = query.ilike("name_norm", `%${w}%`);
    if (lb) query = query.eq("platform", lb);
    const { data: d2 } = await query.limit(40);
    rows = (d2 ?? []).sort((a: any, b2: any) => a.name.length - b2.name.length).slice(0, 8);
  }
  const games = rows.map((r: any) => ({
    name: r.name,
    lbPlatform: r.platform,
    // Our own platform name, so the new listing lines up with the rest of the catalog.
    platform: resolveStaticPlatform(r.platform) ?? r.platform,
    cover: r.box_front ? lbImageUrl(r.box_front) : r.box_3d ? lbImageUrl(r.box_3d) : "",
    sim: typeof r.sim === "number" ? r.sim : null,
  }));
  return json({ ok: true, games });
};
