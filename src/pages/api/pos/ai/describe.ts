import type { APIRoute } from "astro";
import { aiConfigured, aiSettings, callClaude } from "../../../../lib/ai";

export const prerender = false;
const json = (d: unknown, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { "content-type": "application/json" } });

// Generate an on-brand SEO product description. Internal/staff only.
export const POST: APIRoute = async ({ locals, request }) => {
  if (!locals.user) return json({ error: "unauthorized" }, 401);
  if (!aiConfigured()) return json({ error: "AI isn't set up yet — add ANTHROPIC_API_KEY to .env / Vercel to enable it.", needsKey: true }, 400);

  const b = await request.json().catch(() => ({} as any));
  const sb = locals.supabase;

  const ctx: Record<string, string> = {
    Title: String(b.title ?? "").trim(),
    Platform: String(b.platform ?? "").trim(),
  };

  // Ground on the product's real data when we have an id.
  if (b.productId) {
    const { data: p } = await sb
      .from("products")
      .select("title, platform, franchise, genre, brand, release_year, alternative_names, category:categories(name), product_variants(condition, completeness)")
      .eq("id", b.productId)
      .maybeSingle();
    if (p) {
      const v = ((p as any).product_variants ?? [])[0] ?? {};
      Object.assign(ctx, {
        Title: p.title || ctx.Title,
        Platform: p.platform || ctx.Platform,
        Category: (p as any).category?.name ?? "",
        Franchise: p.franchise ?? "",
        Genre: p.genre ?? "",
        Publisher: (p as any).brand ?? "",
        "Release year": (p as any).release_year ? String((p as any).release_year) : "",
        Condition: [v.completeness, v.condition].filter(Boolean).join(" / "),
        "Also known as": ((p as any).alternative_names ?? []).join(", "),
      });
    }
  }

  if (!ctx.Title) return json({ error: "No product title to describe." }, 400);

  const { descriptionPrompt, model } = aiSettings(
    (await sb.from("store_settings").select("settings").eq("id", 1).maybeSingle()).data?.settings,
  );
  const facts = Object.entries(ctx).filter(([, v]) => v && v.trim()).map(([k, v]) => `${k}: ${v}`).join("\n");
  const user = `Write a product description for this item using ONLY these facts (do not invent anything):\n\n${facts}`;

  try {
    const description = await callClaude({ system: descriptionPrompt, user, model, maxTokens: 600 });
    return json({ ok: true, description });
  } catch (e: any) {
    return json({ error: e.message || "AI request failed" }, 500);
  }
};
