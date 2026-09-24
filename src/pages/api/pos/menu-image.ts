import type { APIRoute } from "astro";
import { createSupabaseAdminClient } from "../../../lib/supabase";
import { shrinkImage } from "../../../lib/imageShrink";
import { putImage } from "../../../lib/imageStore";

export const prerender = false;
const json = (d: unknown, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { "content-type": "application/json" } });
const MAX_BYTES = 6 * 1024 * 1024;

// Upload a menu-item photo into photo storage (R2 or Supabase, under menu/),
// return its public URL. Managers/owners only. The URL is stored on
// menu_items.image_url via the item-save action.
export const POST: APIRoute = async ({ locals, request }) => {
  if (!locals.user) return json({ error: "unauthorized" }, 401);
  if (!locals.can("menu.manage")) return json({ error: "You don't have permission to edit the menu" }, 403);

  const form = await request.formData();
  const file = form.get("file");
  if (!(file instanceof File) || file.size === 0) return json({ error: "No file provided" }, 400);
  if (!file.type.startsWith("image/")) return json({ error: "File must be an image" }, 400);
  if (file.size > MAX_BYTES) return json({ error: "Image too large (6MB max)" }, 400);

  const admin = createSupabaseAdminClient();
  const { bytes, contentType, shrunk } = await shrinkImage(new Uint8Array(await file.arrayBuffer()), file.type);
  const ext = shrunk ? "webp" : (file.name.split(".").pop() || "jpg").toLowerCase().replace(/[^a-z0-9]/g, "") || "jpg";
  const path = `menu/${crypto.randomUUID()}.${ext}`;
  try {
    return json({ ok: true, url: await putImage(admin, path, bytes, contentType) });
  } catch (e: any) {
    return json({ error: e.message ?? String(e) }, 500);
  }
};
