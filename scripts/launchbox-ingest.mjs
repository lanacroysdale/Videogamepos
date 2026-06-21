// ============================================================================
// Ingest LaunchBox retail box-art references into the game_metadata table.
//
//   1. curl -s -o /tmp/lbmeta.zip https://gamesdb.launchbox-app.com/Metadata.zip
//   2. unzip -o /tmp/lbmeta.zip Metadata.xml -d /tmp
//   3. node --env-file=.env scripts/launchbox-ingest.mjs [/tmp/Metadata.xml]
//
// Streams the ~470MB XML (low memory), keeps only console/handheld platforms +
// the best Box-Front / Box-3D image per game, then upserts in batches. Safe to
// re-run (upsert on database_id). Re-run periodically to refresh.
// ============================================================================
import { createClient } from "@supabase/supabase-js";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

const url = process.env.PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Missing PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env");
  process.exit(1);
}
const sb = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
const XML_PATH = process.argv[2] || "/tmp/Metadata.xml";

// Consumer console + handheld platforms a game store actually sells.
const INCLUDE = new Set([
  "Nintendo Switch", "Nintendo Switch 2", "Super Nintendo Entertainment System",
  "Nintendo Entertainment System", "Nintendo Famicom Disk System", "Nintendo 64",
  "Nintendo 64DD", "Nintendo GameCube", "Nintendo Wii", "Nintendo Wii U",
  "Nintendo DS", "Nintendo 3DS", "Nintendo Game Boy", "Nintendo Game Boy Color",
  "Nintendo Game Boy Advance", "Nintendo Virtual Boy", "Nintendo Pokemon Mini",
  "Nintendo Satellaview", "Nintendo Game & Watch",
  "Sony Playstation", "Sony Playstation 2", "Sony Playstation 3", "Sony Playstation 4",
  "Sony Playstation 5", "Sony Playstation Vita", "Sony PSP", "Sony PSP Minis",
  "Microsoft Xbox", "Microsoft Xbox 360", "Microsoft Xbox One", "Microsoft Xbox Series X/S",
  "Sega Genesis", "Sega CD", "Sega 32X", "Sega CD 32X", "Sega Saturn", "Sega Dreamcast",
  "Sega Game Gear", "Sega Master System", "Sega SG-1000", "Sega SC-3000", "Sega Pico",
  "Atari 2600", "Atari 5200", "Atari 7800", "Atari Jaguar", "Atari Jaguar CD", "Atari Lynx",
  "NEC TurboGrafx-16", "NEC TurboGrafx-CD", "PC Engine SuperGrafx",
  "SNK Neo Geo AES", "SNK Neo Geo CD", "SNK Neo Geo Pocket", "SNK Neo Geo Pocket Color",
  "3DO Interactive Multiplayer", "WonderSwan", "WonderSwan Color",
]);

const decode = (s) =>
  s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#0?39;/g, "'");
const normName = (s) => decode(s).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const regionRank = (r) => (r === "North America" ? 4 : r === "United States" ? 3 : !r || r === "World" ? 2 : 1);

const games = new Map();      // id -> { name, platform }
const boxFront = new Map();   // id -> { filename, rank }
const box3d = new Map();

let cur = null, g = {};
const rl = createInterface({ input: createReadStream(XML_PATH), crlfDelay: Infinity });
for await (const line of rl) {
  const t = line.trim();
  if (t === "<Game>") { cur = "g"; g = {}; continue; }
  if (t === "<GameImage>") { cur = "i"; g = {}; continue; }
  if (t === "<GameAlternateName>") { cur = "a"; g = {}; continue; }
  if (t === "</Game>") {
    const plat = g.Platform ? decode(g.Platform) : "";
    if (g.DatabaseID && plat && INCLUDE.has(plat)) games.set(g.DatabaseID, { name: g.Name || "", platform: plat });
    cur = null; continue;
  }
  if (t === "</GameImage>") {
    if (g.DatabaseID && g.FileName && (g.Type === "Box - Front" || g.Type === "Box - 3D")) {
      const map = g.Type === "Box - Front" ? boxFront : box3d;
      const rank = regionRank(g.Region);
      const ex = map.get(g.DatabaseID);
      if (!ex || rank > ex.rank) map.set(g.DatabaseID, { filename: g.FileName, rank });
    }
    cur = null; continue;
  }
  if (t === "</GameAlternateName>") { cur = null; continue; }
  if (cur && t.charCodeAt(0) === 60) {
    const m = t.match(/^<([A-Za-z0-9]+)>(.*)<\/\1>$/);
    if (m) g[m[1]] = m[2];
  }
}

const rows = [];
for (const [id, gg] of games) {
  const bf = boxFront.get(id), b3 = box3d.get(id);
  if (!bf && !b3) continue;
  rows.push({
    database_id: Number(id),
    name: decode(gg.name),
    name_norm: normName(gg.name),
    platform: gg.platform,
    box_front: bf?.filename ?? null,
    box_3d: b3?.filename ?? null,
  });
}
console.log(`Parsed ${games.size} console games; ${rows.length} have box art. Upserting…`);
for (let i = 0; i < rows.length; i += 1000) {
  const batch = rows.slice(i, i + 1000);
  let ok = false, lastErr = "";
  for (let attempt = 0; attempt < 6 && !ok; attempt++) {
    try {
      const { error } = await sb.from("game_metadata").upsert(batch, { onConflict: "database_id" });
      if (!error) ok = true;
      else lastErr = error.message;
    } catch (e) {
      lastErr = String(e?.message || e);
    }
    if (!ok) await new Promise((r) => setTimeout(r, 2000)); // transient network — back off + retry
  }
  if (!ok) { console.error(`upsert failed at ${i} after retries: ${lastErr}`); process.exit(1); }
  if (i % 10000 === 0) console.log(`  ${i}/${rows.length}`);
}
console.log(`✅ Ingested ${rows.length} games with box art.`);
