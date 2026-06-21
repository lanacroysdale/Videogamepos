import type { APIRoute } from "astro";

export const prerender = false;
const json = (d: unknown, s = 200) =>
  new Response(JSON.stringify(d), { status: s, headers: { "content-type": "application/json" } });

// Count of listings that still need attention (missing image, description, or a
// variant condition) — powers the Inventory nav badge.
export const GET: APIRoute = async ({ locals }) => {
  if (!locals.user) return json({ error: "unauthorized" }, 401);
  const { data: products } = await locals.supabase
    .from("products")
    .select("id, image_url, description, product_variants(completeness_code)");

  let count = 0;
  for (const p of products ?? []) {
    const noImage = !p.image_url;
    const noDesc = !p.description;
    const noCond = (p.product_variants ?? []).some((v: any) => !v.completeness_code);
    if (noImage || noDesc || noCond) count++;
  }
  return json({ ok: true, count });
};
