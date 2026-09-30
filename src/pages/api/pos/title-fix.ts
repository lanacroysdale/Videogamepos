import type { APIRoute } from "astro";
import { lbPlatform } from "../../../lib/launchbox";

export const prerender = false;
const json = (d: unknown, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { "content-type": "application/json" } });

// POST { items: [{ title, platform }] } → { results: [{ name, sim } | null] }
// The closest official game title on that platform from our local copy of the
// LaunchBox games database (game_metadata, trigram similarity). The CALLER
// decides whether a candidate is a safe correction (officialTitleFor). Items on
// platforms LaunchBox doesn't cover (or unmapped ones) get null — never a
// guess across platforms.
export const POST: APIRoute = async ({ locals, request }) => {
  if (!locals.user) return json({ error: "unauthorized" }, 401);
  const b = await request.json().catch(() => ({}));
  const items: { title?: string; platform?: string }[] = Array.isArray(b.items) ? b.items.slice(0, 200) : [];
  const sb = locals.supabase;
  const results: ({ name: string; sim: number } | null)[] = new Array(items.length).fill(null);
  const CONC = 8;
  for (let i = 0; i < items.length; i += CONC) {
    await Promise.all(items.slice(i, i + CONC).map(async (it, k) => {
      const lb = lbPlatform(it.platform);
      // Bracketed qualifiers ([Collector's Edition], [JP]) aren't part of the game's name.
      const title = String(it.title ?? "").replace(/\[[^\]]*\]|\([^)]*\)/g, " ").replace(/\s+/g, " ").trim();
      if (!lb || title.length < 2) return;
      const { data, error } = await sb.rpc("lookup_box_art", { p_title: title, p_platform: lb });
      const best = Array.isArray(data) ? data[0] : data;
      if (!error && best?.name) results[i + k] = { name: String(best.name), sim: Number(best.sim) || 0 };
    }));
  }
  return json({ ok: true, results });
};
