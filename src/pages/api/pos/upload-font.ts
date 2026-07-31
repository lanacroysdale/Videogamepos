import type { APIRoute } from "astro";
import { createSupabaseAdminClient } from "../../../lib/supabase";

export const prerender = false;
const json = (d: unknown, s = 200) =>
  new Response(JSON.stringify(d), { status: s, headers: { "content-type": "application/json" } });

// Custom label-font upload (managers). Stored in the public product-images
// bucket under fonts/ so the label renderer can @font-face it by URL.
const EXT_OK = new Set(["woff2", "woff", "ttf", "otf"]);
const MAX_BYTES = 3 * 1024 * 1024;

export const POST: APIRoute = async ({ locals, request }) => {
  if (!locals.user) return json({ error: "unauthorized" }, 401);
  if (!["owner", "manager"].includes(locals.profile?.role ?? "")) return json({ error: "Managers only" }, 403);

  const form = await request.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File) || file.size === 0) return json({ error: "No font file received." }, 400);
  if (file.size > MAX_BYTES) return json({ error: "Font too large (3MB max)." }, 400);
  const ext = (file.name.split(".").pop() || "").toLowerCase();
  if (!EXT_OK.has(ext)) return json({ error: "Use a .woff2, .woff, .ttf or .otf font file." }, 400);

  const admin = createSupabaseAdminClient();
  const path = `fonts/${crypto.randomUUID()}.${ext}`;
  const { error } = await admin.storage.from("product-images").upload(path, await file.arrayBuffer(), {
    contentType: ext === "ttf" ? "font/ttf" : ext === "otf" ? "font/otf" : `font/${ext}`,
    cacheControl: "31536000",
    upsert: false,
  });
  if (error) return json({ error: error.message }, 500);
  const { data } = admin.storage.from("product-images").getPublicUrl(path);
  return json({ ok: true, url: data.publicUrl });
};
