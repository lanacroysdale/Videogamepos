// LaunchBox box-art helpers. The game_metadata table (ingested by
// scripts/launchbox-ingest.mjs) stores image GUID filenames served from the
// LaunchBox CDN; the lookup_box_art RPC finds the best match by title/platform.

export const lbImageUrl = (filename: string) => `https://images.launchbox-app.com/${filename}`;

// Map our free-text product platforms to LaunchBox platform names.
const MAP: Record<string, string> = {
  "nintendo switch": "Nintendo Switch", switch: "Nintendo Switch", nsw: "Nintendo Switch",
  "super nintendo": "Super Nintendo Entertainment System", snes: "Super Nintendo Entertainment System",
  "super famicom": "Super Nintendo Entertainment System",
  "nintendo entertainment system": "Nintendo Entertainment System", nes: "Nintendo Entertainment System",
  famicom: "Nintendo Entertainment System",
  "nintendo 64": "Nintendo 64", n64: "Nintendo 64",
  gamecube: "Nintendo GameCube", "nintendo gamecube": "Nintendo GameCube",
  "nintendo wii": "Nintendo Wii", wii: "Nintendo Wii", "wii u": "Nintendo Wii U",
  "nintendo ds": "Nintendo DS", nds: "Nintendo DS", "nintendo 3ds": "Nintendo 3DS", "3ds": "Nintendo 3DS",
  "game boy": "Nintendo Game Boy", gameboy: "Nintendo Game Boy",
  "game boy color": "Nintendo Game Boy Color", gbc: "Nintendo Game Boy Color",
  "game boy advance": "Nintendo Game Boy Advance", gba: "Nintendo Game Boy Advance",
  playstation: "Sony Playstation", ps1: "Sony Playstation", psx: "Sony Playstation",
  "playstation 2": "Sony Playstation 2", ps2: "Sony Playstation 2",
  "playstation 3": "Sony Playstation 3", ps3: "Sony Playstation 3",
  "playstation 4": "Sony Playstation 4", ps4: "Sony Playstation 4",
  "playstation 5": "Sony Playstation 5", ps5: "Sony Playstation 5",
  psp: "Sony PSP", "playstation vita": "Sony Playstation Vita", "ps vita": "Sony Playstation Vita",
  xbox: "Microsoft Xbox", "xbox 360": "Microsoft Xbox 360", "xbox one": "Microsoft Xbox One",
  "sega genesis": "Sega Genesis", genesis: "Sega Genesis", "mega drive": "Sega Genesis",
  "sega dreamcast": "Sega Dreamcast", dreamcast: "Sega Dreamcast",
  "sega saturn": "Sega Saturn", saturn: "Sega Saturn",
  "sega game gear": "Sega Game Gear", "game gear": "Sega Game Gear",
  "sega master system": "Sega Master System",
};

export function lbPlatform(platform?: string | null): string | null {
  if (!platform) return null;
  return MAP[platform.toLowerCase().trim()] ?? null;
}
