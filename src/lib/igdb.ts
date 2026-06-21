// Server-only IGDB enrichment (auth via Twitch client-credentials).
// Pulls cover art, summary, release year, a trailer, and alternate names for a
// game by title (+ optional platform). Never import where it reaches the browser.

const CLIENT_ID = import.meta.env.IGDB_CLIENT_ID ?? process.env.IGDB_CLIENT_ID;
const CLIENT_SECRET = import.meta.env.IGDB_CLIENT_SECRET ?? process.env.IGDB_CLIENT_SECRET;

export function igdbConfigured(): boolean {
  return !!(CLIENT_ID && CLIENT_SECRET);
}

let cachedToken: { token: string; expires: number } | null = null;

async function getToken(): Promise<string> {
  if (cachedToken && cachedToken.expires > Date.now() + 60_000) return cachedToken.token;
  const res = await fetch(
    `https://id.twitch.tv/oauth2/token?client_id=${CLIENT_ID}&client_secret=${CLIENT_SECRET}&grant_type=client_credentials`,
    { method: "POST" },
  );
  if (!res.ok) throw new Error("IGDB auth failed (" + res.status + ")");
  const j = await res.json();
  cachedToken = { token: j.access_token, expires: Date.now() + j.expires_in * 1000 };
  return j.access_token;
}

export interface GameMeta {
  name: string;
  summary: string | null;
  releaseYear: number | null;
  coverUrl: string | null;
  trailerUrl: string | null;
  altNames: string[];
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

export async function searchGame(title: string, _platform?: string): Promise<GameMeta | null> {
  if (!igdbConfigured()) return null;
  const token = await getToken();
  const safe = title.replace(/"/g, "");
  // No category filter (IGDB deprecated `category`). The sort below promotes the
  // exact-name main game over DLC / bundles / mods that may rank higher.
  const body = `search "${safe}"; fields name, summary, first_release_date, cover.image_id, videos.video_id, alternative_names.name, total_rating_count; limit 12;`;
  const res = await fetch("https://api.igdb.com/v4/games", {
    method: "POST",
    headers: { "Client-ID": CLIENT_ID!, Authorization: `Bearer ${token}`, "Content-Type": "text/plain" },
    body,
  });
  if (!res.ok) throw new Error("IGDB query failed (" + res.status + ")");
  const games: any[] = await res.json();
  if (!Array.isArray(games) || !games.length) return null;

  const target = norm(title);
  games.sort((a, b) => {
    const am = norm(a.name) === target ? 0 : norm(a.name).includes(target) || target.includes(norm(a.name)) ? 1 : 2;
    const bm = norm(b.name) === target ? 0 : norm(b.name).includes(target) || target.includes(norm(b.name)) ? 1 : 2;
    if (am !== bm) return am - bm;
    const ac = a.cover ? 0 : 1, bc = b.cover ? 0 : 1;
    if (ac !== bc) return ac - bc;
    return (b.total_rating_count ?? 0) - (a.total_rating_count ?? 0);
  });

  const g = games[0];
  const videoId = (g.videos ?? []).map((v: any) => v.video_id).find(Boolean);
  return {
    name: g.name,
    summary: g.summary ?? null,
    releaseYear: g.first_release_date ? new Date(g.first_release_date * 1000).getUTCFullYear() : null,
    coverUrl: g.cover?.image_id
      ? `https://images.igdb.com/igdb/image/upload/t_cover_big_2x/${g.cover.image_id}.jpg`
      : null,
    trailerUrl: videoId ? `https://www.youtube.com/watch?v=${videoId}` : null,
    altNames: (g.alternative_names ?? []).map((a: any) => a.name).filter(Boolean),
  };
}
