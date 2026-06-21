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

// List held (open) sales for the resume tray — newest first, with their items.
export const GET: APIRoute = async ({ locals }) => {
  if (!locals.user) return json({ error: "unauthorized" }, 401);
  const { data, error } = await locals.supabase
    .from("transactions")
    .select(
      "id, human_id, total_cents, created_at, note, customer:customers(first_name, last_name), transaction_items(variant_id, category_id, kind, description, qty, unit_price_cents, discount_cents)",
    )
    .eq("type", "sale")
    .eq("status", "open")
    .order("created_at", { ascending: false });
  if (error) return json({ error: error.message }, 500);
  return json({ held: data ?? [] });
};

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

  // Resuming a held sale updates that same transaction in place (so completing
  // or re-holding never creates a duplicate); otherwise we insert a new one.
  const resumeId = body.resumeId ?? null;
  const fields = {
    customer_id: body.customerId ?? null,
    status,
    subtotal_cents: subtotal,
    discount_cents: totalDiscount,
    total_cents: total,
    cash_cents: cash,
    card_cents: card,
    completed_at: status === "completed" ? new Date().toISOString() : null,
  };

  let txn: any;
  if (resumeId) {
    const { data, error } = await locals.supabase
      .from("transactions")
      .update(fields)
      .eq("id", resumeId)
      .eq("status", "open") // only an open (held) sale can be resumed
      .select()
      .single();
    if (error || !data) return json({ error: error?.message || "That held sale is no longer available." }, 409);
    txn = data;
    await locals.supabase.from("transaction_items").delete().eq("transaction_id", resumeId);
    const { error: iErr } = await locals.supabase
      .from("transaction_items")
      .insert(items.map((it) => ({ ...it, transaction_id: resumeId })));
    if (iErr) return json({ error: iErr.message }, 500);
  } else {
    const { data, error } = await locals.supabase
      .from("transactions")
      .insert({ ...fields, employee_id: locals.user.id, type: "sale" })
      .select()
      .single();
    if (error) return json({ error: error.message }, 500);
    txn = data;
    const { error: iErr } = await locals.supabase
      .from("transaction_items")
      .insert(items.map((it) => ({ ...it, transaction_id: txn.id })));
    if (iErr) return json({ error: iErr.message }, 500);
  }

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
