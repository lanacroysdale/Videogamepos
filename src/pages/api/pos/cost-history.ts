import type { APIRoute } from "astro";
import { createSupabaseAdminClient } from "../../../lib/supabase";

export const prerender = false;
const json = (d: unknown, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { "content-type": "application/json" } });

// Per-variant trade-in purchase events (what we paid), for the running-average
// cost on the inventory edit screen. Manager-only — cost/margin info. Uses the
// admin client so the average reflects ALL employees' trade-ins, not just the
// caller's (RLS would otherwise scope a cashier to their own).
export const POST: APIRoute = async ({ locals, request }) => {
  if (!locals.user) return json({ error: "unauthorized" }, 401);
  if (!["owner", "manager"].includes(locals.profile?.role ?? "")) return json({ error: "Managers only" }, 403);

  const b = await request.json().catch(() => ({} as any));
  if (!b.productId) return json({ error: "productId required" }, 400);

  const admin = createSupabaseAdminClient();
  const { data: vs } = await admin.from("product_variants").select("id").eq("product_id", b.productId);
  const ids = (vs ?? []).map((v: any) => v.id);
  if (!ids.length) return json({ ok: true, events: {} });

  const { data, error } = await admin
    .from("transaction_items")
    .select("variant_id, qty, unit_price_cents, transactions!inner(status, completed_at, created_at)")
    .eq("kind", "trade_in")
    .in("variant_id", ids)
    .eq("transactions.status", "completed");
  if (error) return json({ error: error.message }, 500);

  const events: Record<string, { q: number; c: number; d: string }[]> = {};
  for (const it of data ?? []) {
    const t: any = (it as any).transactions;
    (events[(it as any).variant_id] ||= []).push({
      q: (it as any).qty,
      c: (it as any).unit_price_cents,
      d: t?.completed_at || t?.created_at,
    });
  }
  return json({ ok: true, events });
};
