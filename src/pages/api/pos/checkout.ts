import type { APIRoute } from "astro";
import { regionMapByVariant, typeMapByVariant } from "../../../lib/inventoryTypes";

export const prerender = false;

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

interface IncomingItem {
  custom?: boolean; // ＋ Custom item: sold at checkout, not in inventory
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
      "id, human_id, total_cents, created_at, note, customer:customers(first_name, last_name), transaction_items(variant_id, category_id, kind, description, qty, unit_price_cents, discount_cents, department)",
    )
    .eq("type", "sale")
    .eq("status", "open")
    .eq("is_tab", false) // keep bar tabs out of the retail held-sales tray
    .order("created_at", { ascending: false });
  if (error) return json({ error: error.message }, 500);
  return json({ held: data ?? [] });
};

// Delete a held (open) sale. Completed sales are ledger records and can't be
// deleted here — they must be voided/refunded via Returns.
export const DELETE: APIRoute = async ({ locals, request }) => {
  if (!locals.user) return json({ error: "unauthorized" }, 401);
  const { id } = await request.json().catch(() => ({}));
  if (!id) return json({ error: "id required" }, 400);
  const { data: txn } = await locals.supabase.from("transactions").select("status, is_tab").eq("id", id).maybeSingle();
  if (!txn) return json({ error: "Sale not found." }, 404);
  if (txn.is_tab) return json({ error: "That's a bar tab — void it from the Tabs screen." }, 409);
  if (txn.status !== "open") return json({ error: "Only held (open) sales can be deleted." }, 409);
  await locals.supabase.from("transaction_items").delete().eq("transaction_id", id);
  const { error } = await locals.supabase.from("transactions").delete().eq("id", id).eq("status", "open").eq("is_tab", false);
  if (error) return json({ error: error.message }, 500);
  return json({ ok: true });
};

export const POST: APIRoute = async ({ locals, request }) => {
  if (!locals.user) return json({ error: "unauthorized" }, 401);

  const body = await request.json().catch(() => null);
  if (!body || !Array.isArray(body.items) || body.items.length === 0) {
    return json({ error: "Cart is empty." }, 400);
  }
  const status = body.status === "open" ? "open" : "completed";

  // Re-derive everything server-side; never trust client totals.
  const incoming = body.items as IncomingItem[];
  const items = incoming.map((it) => ({
    variant_id: it.variantId ?? null,
    category_id: it.categoryId ?? null,
    kind: it.kind === "service" ? "service" : "sale",
    description: String(it.description ?? "Item").trim().slice(0, 200),
    qty: Math.max(1, parseInt(String(it.qty)) || 1),
    unit_price_cents: Math.max(0, Math.round(Number(it.unitPriceCents)) || 0),
    discount_cents: Math.max(0, Math.round(Number(it.discountCents)) || 0),
  }));
  // Lines typed at the register (＋ Custom item, service tiles, add-ons) have
  // no listing behind them, so check them here — before anything is written:
  // a bad one would otherwise fail AFTER the sale row exists (a sale with no
  // lines). Any line: sane qty / price (int4 totals).
  for (const it of items) {
    if (!it.description) return json({ error: "Every item needs a description." }, 400);
    if (it.qty > 9999 || it.unit_price_cents > 10_000_000) return json({ error: `“${it.description}” — that price or quantity looks wrong.` }, 400);
    if (!it.variant_id && it.unit_price_cents <= 0) return json({ error: `“${it.description}” needs a price.` }, 400);
  }
  const catIds = [...new Set(items.map((it) => it.category_id).filter(Boolean) as string[])];
  if (catIds.length) {
    const okIds = catIds.filter((id) => /^[0-9a-f-]{36}$/i.test(id));
    const { data: cats } = okIds.length ? await locals.supabase.from("categories").select("id").in("id", okIds) : { data: [] as any[] };
    const known = new Set((cats ?? []).map((c: any) => c.id));
    if (catIds.some((id) => !known.has(id))) return json({ error: "One of the categories no longer exists — reload the page and try again." }, 400);
  }

  // Inventory-type pass — LIVE read (never the page's cached flags, so the expo
  // block toggle bites immediately): refuse blocked pools, then stamp each
  // variant line with its type key (+ retail department) for reporting.
  // `typesReady` is false pre-migration — the inventory_type key must then be
  // OMITTED entirely (PostgREST rejects unknown insert keys → would 500 sales).
  const { ready: typesReady, map: typeMap } = await typeMapByVariant(locals.supabase, items.filter((it) => it.variant_id).map((it) => it.variant_id as string));
  const blockedLines = items.filter((it) => it.variant_id && typeMap.get(it.variant_id as string)?.block_at_checkout);
  if (blockedLines.length) {
    const names = [...new Set(blockedLines.map((it) => it.description))].join(", ");
    return json({ error: `Not for sale: ${names} — blocked inventory type. A manager can unblock it in Settings → Inventory types.` }, 409);
  }
  // Region snapshot (the listing's region_code at sale time) — same guard:
  // pre-migration the region key is OMITTED, never sent empty.
  const { ready: regionsReady, map: regionMap } = await regionMapByVariant(locals.supabase, items.filter((it) => it.variant_id).map((it) => it.variant_id as string));
  const stamped = items.map((it, i) => ({
    ...it,
    // Custom items are retail goods too (Reports → Retail, not "Other").
    department: it.variant_id || (incoming[i].custom && !incoming[i].variantId) ? "retail" : null,
    ...(typesReady ? { inventory_type: it.variant_id ? (typeMap.get(it.variant_id as string)?.key ?? null) : null } : {}),
    ...(regionsReady ? { region: it.variant_id ? (regionMap.get(it.variant_id as string) ?? null) : null } : {}),
  }));

  const cartDiscount = Math.max(0, Math.round(Number(body.cartDiscountCents)) || 0);
  const subtotal = items.reduce((s, it) => s + it.unit_price_cents * it.qty, 0);
  const itemDiscounts = items.reduce((s, it) => s + it.discount_cents, 0);
  let totalDiscount = Math.min(subtotal, itemDiscounts + cartDiscount);
  let total = Math.max(0, subtotal - totalDiscount);
  // Cash the customer handed over (may exceed the total → change is given).
  const tendered = status === "completed" ? Math.max(0, Math.round(Number(body.cashCents)) || 0) : 0;
  let cash = Math.min(total, tendered); // amount applied to the sale
  let card = status === "completed" ? total - cash : 0; // remainder on card
  let change = tendered > total ? tendered - total : 0;
  // "Mark paid" (managers): the cash + card actually collected, typed in —
  // e.g. one sale for a whole expo day. That IS the total; anything under the
  // items' price is recorded as the sale's discount. More than the items is
  // refused (an item is missing, or a typo).
  if (status === "completed" && body.manualPayment) {
    if (!locals.can("data.elevated")) return json({ error: "Only a manager can mark a sale paid with typed-in amounts." }, 403);
    const mc = Math.round(Number(body.manualPayment.cashCents)), md = Math.round(Number(body.manualPayment.cardCents));
    if (!Number.isFinite(mc) || !Number.isFinite(md) || mc < 0 || md < 0 || mc + md <= 0) return json({ error: "Type the cash and/or card amount that was paid." }, 400);
    if (mc + md > subtotal) return json({ error: `Paid (${(mc + md) / 100}) is more than the items in this sale (${subtotal / 100}) — an item is missing, or check the amounts.` }, 400);
    cash = mc; card = md; change = 0;
    total = mc + md;
    totalDiscount = subtotal - total;
  }

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
    // Never a moment where the saved sale has no lines: the new lines go in
    // FIRST, then the old ones are removed by id, then the sale row is
    // updated. If anything fails part-way, the last good save stays as it was.
    const { data: cur } = await locals.supabase.from("transactions").select("id, status, is_tab").eq("id", resumeId).maybeSingle();
    if (!cur || cur.status !== "open" || cur.is_tab) return json({ error: "That held sale is no longer available (completed, deleted, or a bar tab)." }, 409);
    const { data: oldRows, error: oErr } = await locals.supabase.from("transaction_items").select("id").eq("transaction_id", resumeId);
    if (oErr) return json({ error: oErr.message }, 500);
    const { error: iErr } = await locals.supabase
      .from("transaction_items")
      .insert(stamped.map((it) => ({ ...it, transaction_id: resumeId })));
    if (iErr) return json({ error: `Couldn't save the items (the last save is unchanged): ${iErr.message}` }, 500);
    const oldIds = (oldRows ?? []).map((r: any) => r.id);
    for (let i = 0; i < oldIds.length; i += 100) {
      const { error: dErr } = await locals.supabase.from("transaction_items").delete().in("id", oldIds.slice(i, i + 100));
      if (dErr) return json({ error: `Saved, but the old copy of the items couldn't be cleared — don't complete it yet; reload and check: ${dErr.message}` }, 500);
    }
    const { data, error } = await locals.supabase
      .from("transactions")
      .update(fields)
      .eq("id", resumeId)
      .eq("status", "open") // only an open (held) sale can be resumed
      .eq("is_tab", false) // never let held-sale resume touch a bar tab
      .select()
      .single();
    if (error || !data) return json({ error: error?.message || "That held sale is no longer available." }, 409);
    txn = data;
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
      .insert(stamped.map((it) => ({ ...it, transaction_id: txn.id })));
    if (iErr) {
      // Don't leave a sale with no lines behind.
      await locals.supabase.from("transactions").delete().eq("id", txn.id).eq("status", status);
      return json({ error: `Couldn't save the items: ${iErr.message}` }, 500);
    }
  }

  // Take the sold copies out of stock (inventory lines only). A whole expo
  // day can be hundreds of listings, so counts are read in batches (one huge
  // id list can fail — the old code then wrote 0 for EVERY item) and written
  // a few at a time in parallel (stays well inside the function time limit).
  // Each write only lands on the count it read (a sale elsewhere meanwhile →
  // re-read once); a count that can't be read is never guessed — those items
  // are reported back so stock can be fixed by hand.
  const stockMissed: string[] = [];
  if (status === "completed") {
    const sold = new Map<string, { qty: number; desc: string }>();
    for (const it of items) {
      if (!it.variant_id) continue;
      const m = sold.get(it.variant_id) ?? { qty: 0, desc: it.description };
      m.qty += it.qty;
      sold.set(it.variant_id, m);
    }
    const ids = [...sold.keys()];
    const counts = new Map<string, number>();
    for (let i = 0; i < ids.length; i += 80) {
      const { data: vars, error } = await locals.supabase.from("product_variants").select("id, quantity").in("id", ids.slice(i, i + 80));
      if (!error) for (const v of (vars ?? []) as any[]) counts.set(v.id, v.quantity ?? 0);
    }
    const takeOut = async (id: string) => {
      const n = sold.get(id)!.qty;
      let cur = counts.get(id);
      for (let attempt = 0; attempt < 2 && cur != null; attempt++) {
        const { data, error } = await locals.supabase.from("product_variants").update({ quantity: Math.max(0, cur - n) }).eq("id", id).eq("quantity", cur).select("id");
        if (!error && data && data.length) return;
        const { data: again } = await locals.supabase.from("product_variants").select("quantity").eq("id", id).maybeSingle();
        cur = again ? (again.quantity ?? 0) : undefined;
      }
      stockMissed.push(sold.get(id)!.desc);
    };
    for (let i = 0; i < ids.length; i += 10) await Promise.all(ids.slice(i, i + 10).map(takeOut));
  }

  return json({ ok: true, id: txn.id, humanId: txn.human_id, total, change, status, ...(stockMissed.length ? { stockMissed } : {}) });
};
