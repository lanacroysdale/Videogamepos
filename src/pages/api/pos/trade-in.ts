import type { APIRoute } from "astro";

export const prerender = false;

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

interface TradeItem {
  description?: string;
  categoryId?: string | null;
  resaleCents?: number;
  payoutCents?: number;
}

export const POST: APIRoute = async ({ locals, request }) => {
  if (!locals.user) return json({ error: "unauthorized" }, 401);

  const body = await request.json().catch(() => null);
  if (!body || !Array.isArray(body.items) || body.items.length === 0) {
    return json({ error: "No items to buy." }, 400);
  }

  const items = (body.items as TradeItem[]).map((it) => ({
    variant_id: null,
    category_id: it.categoryId ?? null,
    kind: "trade_in" as const,
    description: String(it.description ?? "Trade-in item").slice(0, 200),
    qty: 1,
    unit_price_cents: Math.max(0, Math.round(Number(it.payoutCents)) || 0),
    discount_cents: 0,
  }));
  const payout = items.reduce((s, it) => s + it.unit_price_cents, 0);
  const note = body.payoutType === "credit" ? "Trade-in (store credit)" : "Trade-in (cash)";

  const { data: txn, error } = await locals.supabase
    .from("transactions")
    .insert({
      customer_id: body.customerId ?? null,
      employee_id: locals.user.id,
      type: "trade_in",
      status: "open", // saved as a draft for review/approval, like a buy ticket
      subtotal_cents: payout,
      total_cents: payout,
      note,
    })
    .select()
    .single();
  if (error) return json({ error: error.message }, 500);

  const { error: iErr } = await locals.supabase
    .from("transaction_items")
    .insert(items.map((it) => ({ ...it, transaction_id: txn.id })));
  if (iErr) return json({ error: iErr.message }, 500);

  return json({ ok: true, id: txn.id, humanId: txn.human_id, payout });
};
