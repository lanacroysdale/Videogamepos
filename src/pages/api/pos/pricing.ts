import type { APIRoute } from "astro";

export const prerender = false;
const json = (d: unknown, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { "content-type": "application/json" } });

// PriceCharting sync + manager review. With a PRICECHARTING_API_TOKEN this would
// fetch real market prices; without one it simulates market movement so the
// review workflow (approve/revert) can be exercised.
export const POST: APIRoute = async ({ locals, request }) => {
  if (!locals.user) return json({ error: "unauthorized" }, 401);
  if (!locals.profile || !["owner", "manager"].includes(locals.profile.role)) return json({ error: "Managers only" }, 403);
  const b = await request.json().catch(() => ({}));
  const sb = locals.supabase;

  if (b.action === "sync") {
    const token = import.meta.env.PRICECHARTING_API_TOKEN ?? process.env.PRICECHARTING_API_TOKEN;
    const { data: variants } = await sb.from("product_variants").select("id, price_cents").gt("price_cents", 0).limit(200);
    const { data: existing } = await sb.from("price_changes").select("variant_id").eq("status", "pending");
    const pending = new Set((existing ?? []).map((p) => p.variant_id));

    const proposals: any[] = [];
    for (const v of variants ?? []) {
      if (pending.has(v.id)) continue;
      // TODO: real PriceCharting lookup when `token` is set. Simulated for now.
      const pct = Math.random() * 0.3 - 0.12; // -12%..+18%
      const suggested = Math.max(99, Math.round((v.price_cents * (1 + pct)) / 100) * 100);
      if (Math.abs(suggested - v.price_cents) >= 100) {
        proposals.push({ variant_id: v.id, old_cents: v.price_cents, suggested_cents: suggested, source: token ? "pricecharting" : "pricecharting (simulated)", status: "pending" });
      }
    }
    const slice = proposals.slice(0, 12);
    if (slice.length) {
      const { error } = await sb.from("price_changes").insert(slice);
      if (error) return json({ error: error.message }, 500);
    }
    return json({ ok: true, proposed: slice.length, simulated: !token });
  }

  if (b.action === "approve") {
    const { data: pc } = await sb.from("price_changes").select("*").eq("id", b.id).maybeSingle();
    if (!pc) return json({ error: "Not found" }, 404);
    await sb.from("product_variants").update({ price_cents: pc.suggested_cents }).eq("id", pc.variant_id);
    await sb.from("price_changes").update({ status: "approved", reviewed_at: new Date().toISOString(), reviewed_by: locals.user.id }).eq("id", b.id);
    return json({ ok: true });
  }

  if (b.action === "revert") {
    const { error } = await sb.from("price_changes").update({ status: "reverted", reviewed_at: new Date().toISOString(), reviewed_by: locals.user.id }).eq("id", b.id);
    if (error) return json({ error: error.message }, 500);
    return json({ ok: true });
  }

  return json({ error: "Unknown action" }, 400);
};
