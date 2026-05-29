import type { APIRoute } from "astro";

export const prerender = false;

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

interface IncomingItem {
  variantId?: string | null;
  categoryId?: string | null;
  kind?: string;
  description?: string;
  qty?: number;
  unitPriceCents?: number;
  discountCents?: number;
}

export const POST: APIRoute = async ({ locals, request }) => {
  if (!locals.user) return json({ error: "unauthorized" }, 401);

  const body = await request.json().catch(() => null);
  if (!body || !Array.isArray(body.items) || body.items.length === 0) {
    return json({ error: "Cart is empty." }, 400);
  }
  const status = body.status === "open" ? "open" : "completed";

  // Re-derive everything server-side; never trust client totals.
  const items = (body.items as IncomingItem[]).map((it) => ({
    variant_id: it.variantId ?? null,
    category_id: it.categoryId ?? null,
    kind: it.kind === "service" ? "service" : "sale",
    description: String(it.description ?? "Item").slice(0, 200),
    qty: Math.max(1, parseInt(String(it.qty)) || 1),
    unit_price_cents: Math.max(0, Math.round(Number(it.unitPriceCents)) || 0),
    discount_cents: Math.max(0, Math.round(Number(it.discountCents)) || 0),
  }));

  const cartDiscount = Math.max(0, Math.round(Number(body.cartDiscountCents)) || 0);
  const subtotal = items.reduce((s, it) => s + it.unit_price_cents * it.qty, 0);
  const itemDiscounts = items.reduce((s, it) => s + it.discount_cents, 0);
  const totalDiscount = Math.min(subtotal, itemDiscounts + cartDiscount);
  const total = Math.max(0, subtotal - totalDiscount);
  // Cash the customer handed over (may exceed the total → change is given).
  const tendered = status === "completed" ? Math.max(0, Math.round(Number(body.cashCents)) || 0) : 0;
  const cash = Math.min(total, tendered); // amount applied to the sale
  const card = status === "completed" ? total - cash : 0; // remainder on card
  const change = tendered > total ? tendered - total : 0;

  const { data: txn, error } = await locals.supabase
    .from("transactions")
    .insert({
      customer_id: body.customerId ?? null,
      employee_id: locals.user.id,
      type: "sale",
      status,
      subtotal_cents: subtotal,
      discount_cents: totalDiscount,
      total_cents: total,
      cash_cents: cash,
      card_cents: card,
      completed_at: status === "completed" ? new Date().toISOString() : null,
    })
    .select()
    .single();
  if (error) return json({ error: error.message }, 500);

  const { error: iErr } = await locals.supabase
    .from("transaction_items")
    .insert(items.map((it) => ({ ...it, transaction_id: txn.id })));
  if (iErr) return json({ error: iErr.message }, 500);

  // Decrement stock for completed sales (inventory variants only).
  if (status === "completed") {
    const variantItems = items.filter((it) => it.variant_id);
    if (variantItems.length) {
      const ids = variantItems.map((it) => it.variant_id as string);
      const { data: vars } = await locals.supabase.from("product_variants").select("id, quantity").in("id", ids);
      const qtyMap = new Map((vars ?? []).map((v) => [v.id, v.quantity]));
      for (const it of variantItems) {
        const cur = qtyMap.get(it.variant_id as string) ?? 0;
        await locals.supabase
          .from("product_variants")
          .update({ quantity: Math.max(0, cur - it.qty) })
          .eq("id", it.variant_id as string);
      }
    }
  }

  return json({ ok: true, id: txn.id, humanId: txn.human_id, total, change, status });
};
