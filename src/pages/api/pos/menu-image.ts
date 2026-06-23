import type { APIRoute } from "astro";
import { createSupabaseAdminClient } from "../../../lib/supabase";

export const prerender = false;
const json = (d: unknown, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { "content-type": "application/json" } });
const MAX_BYTES = 6 * 1024 * 1024;

// Upload a menu-item photo into the public product-images bucket (under menu/),
// return its public URL. Managers/owners only. The URL is stored on
// menu_items.image_url via the item-save action.
export const POST: APIRoute = async ({ locals, request }) => {
  if (!locals.user) return json({ error: "unauthorized" }, 401);
  if (!["owner", "manager"].includes(locals.profile?.role ?? "")) return json({ error: "Managers only" }, 403);

  const form = await request.formData();
  const file = form.get("file");
  if (!(file instanceof File) || file.size === 0) return json({ error: "No file provided" }, 400);
  if (!file.type.startsWith("image/")) return json({ error: "File must be an image" }, 400);
  if (file.size > MAX_BYTES) return json({ error: "Image too large (6MB max)" }, 400);

  const admin = createSupabaseAdminClient();
  const ext = (file.name.split(".").pop() || "jpg").toLowerCase().replace(/[^a-z0-9]/g, "") || "jpg";
  const path = `menu/${crypto.randomUUID()}.${ext}`;
  const bytes = new Uint8Array(await file.arrayBuffer());
  const { error } = await admin.storage.from("product-images").upload(path, bytes, { contentType: file.type, upsert: false });
  if (error) return json({ error: error.message }, 500);
  return json({ ok: true, url: admin.storage.from("product-images").getPublicUrl(path).data.publicUrl });
};
