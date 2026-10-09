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
      "id, human_id, total_cents, discount_cents, created_at, note, customer:customers(first_name, last_name), transaction_items(id, variant_id, category_id, kind, description, qty, unit_price_cents, discount_cents, department)",
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
  const items = incoming.map((it) => {
    const qty = Math.max(1, parseInt(String(it.qty)) || 1);
    const unit = Math.max(0, Math.round(Number(it.unitPriceCents)) || 0);
    return {
      variant_id: it.variantId ?? null,
      category_id: it.categoryId ?? null,
      kind: it.kind === "service" ? "service" : "sale",
      description: String(it.description ?? "Item").trim().slice(0, 200),
      qty,
      unit_price_cents: unit,
      // Never more than the line (a qty lowered after typing a discount).
      discount_cents: Math.min(qty * unit, Math.max(0, Math.round(Number(it.discountCents)) || 0)),
    };
  });
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

  // On completion the lines are made to add up to what was paid: the sale-
  // level discount (cart discount, Mark paid's shortfall) is spread over the
  // lines; if Mark paid is MORE than the lines' net (their own discounts were
  // bigger than the real haggle) those discounts are given back. Reports
  // (net sales, by hour / category / department) and Returns read the lines.
  // Held sales keep their lines as typed (the register loads them back).
  const lines = stamped.map((it) => ({ ...it }));
  if (status === "completed") {
    const gross = lines.map((it) => it.unit_price_cents * it.qty);
    const netNow = lines.reduce((a, it, i) => a + gross[i] - it.discount_cents, 0);
    let delta = netNow - total; // > 0: more discount needed; < 0: give some back
    if (delta > 0) {
      const base = netNow;
      lines.forEach((it, i) => {
        const room = gross[i] - it.discount_cents;
        const share = base ? Math.min(room, Math.floor((delta * room) / base)) : 0;
        it.discount_cents += share;
      });
      delta = lines.reduce((a, it, i) => a + gross[i] - it.discount_cents, 0) - total;
      for (const it of [...lines].sort((a, b) => (b.unit_price_cents * b.qty - b.discount_cents) - (a.unit_price_cents * a.qty - a.discount_cents))) {
        if (delta <= 0) break;
        const add = Math.min(it.unit_price_cents * it.qty - it.discount_cents, delta);
        it.discount_cents += add; delta -= add;
      }
    } else if (delta < 0) {
      let give = -delta;
      const discTotal = lines.reduce((a, it) => a + it.discount_cents, 0);
      lines.forEach((it) => {
        const back = discTotal ? Math.min(it.discount_cents, Math.floor((give * it.discount_cents) / discTotal)) : 0;
        it.discount_cents -= back;
      });
      give = total - lines.reduce((a, it, i) => a + gross[i] - it.discount_cents, 0);
      for (const it of [...lines].sort((a, b) => b.discount_cents - a.discount_cents)) {
        if (give <= 0) break;
        const back = Math.min(it.discount_cents, give);
        it.discount_cents -= back; give -= back;
      }
    }
    totalDiscount = lines.reduce((a, it) => a + it.discount_cents, 0);
  }

  // Resuming a held sale updates that same transaction in place (so completing
  // or re-holding never creates a duplicate); otherwise we insert a new one.
  const resumeId = body.resumeId ?? null;
  const isUuid = (x: unknown) => typeof x === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(x);
  const clientRef = isUuid(body.clientRef) ? body.clientRef : null;
  // The line ids this register last loaded / saved: if the sale changed on
  // another screen since, nothing is overwritten.
  const expected = Array.isArray(body.expectedLineIds) && body.expectedLineIds.every(isUuid) ? (body.expectedLineIds as string[]) : null;
  // This attempt's id, and the register's earlier attempts that got no answer
  // (so a retry isn't mistaken for "changed on another screen").
  const saveRef = isUuid(body.saveRef) ? body.saveRef : null;
  const prevRefs = Array.isArray(body.prevSaveRefs) ? (body.prevSaveRefs as unknown[]).filter(isUuid).slice(-20) as string[] : null;
  // The login that opened this screen (a different one can't see that
  // login's sales — not "deleted").
  const otherLogin = typeof body.pageUserId === "string" && body.pageUserId && body.pageUserId !== locals.user.id;
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
  // A save that didn't go through: say what the sale is now, so the register
  // never offers to save a completed sale again as a new one.
  const gone = (state0: string, humanId?: number | null, id?: string | null) => {
    const state = (state0 === "missing" || state0 === "hidden") && otherLogin ? "wrong_user" : state0;
    return json({
      error: state === "completed" ? `Sale${humanId ? ` #${humanId}` : ""} is already completed — nothing was changed.`
        : state === "changed" ? `Sale${humanId ? ` #${humanId}` : ""} was changed on another screen since this one loaded it — nothing was saved here.`
        : state === "tab" ? "That's a bar tab — use the Tabs screen."
        : state === "wrong_user" ? "This screen was opened by a different login, and that sale isn't visible to the one signed in now. Log in as that person (or a manager) in a new tab, then save again here. Nothing was saved."
        : state === "hidden" ? "That sale belongs to another login — nothing was saved. Log in as that person (or a manager) in a new tab, then save again here."
        : "That held sale no longer exists (deleted).",
      state, humanId: humanId ?? null, id: id ?? null,
    }, 409);
  };

  // Preferred: one database transaction (migration 20261009000001) — header,
  // lines and stock land together or not at all, and a retry is safe.
  const rpc = await locals.supabase.rpc("save_sale", {
    p_id: isUuid(resumeId) ? resumeId : null,
    p_client_ref: clientRef,
    p_status: status,
    p_fields: { ...fields, customer_id: fields.customer_id ?? "" },
    p_items: lines,
    p_expected: resumeId ? expected : null,
    p_save_ref: saveRef,
    p_prev_refs: prevRefs,
  });
  // Only "the function isn't installed yet" falls back — any other error is
  // reported (a broken atomic save must not quietly use the old path).
  const noRpc = rpc.error && (rpc.error.code === "PGRST202" || /could not find the function/i.test(rpc.error.message || ""));
  if (!noRpc) {
    if (rpc.error) {
      if (rpc.error.code === "23503") return json({ error: "An item in this cart is no longer in inventory (deleted) — remove it and try again. Nothing was saved.", state: "item_gone" }, 409);
      return json({ error: rpc.error.message }, 500);
    }
    const r: any = rpc.data;
    if (!r?.ok) return gone(r?.state || "missing", r?.human_id, r?.id);
    return json({ ok: true, id: r.id, humanId: r.human_id, lineIds: r.line_ids ?? [], total, change, status });
  }

  // ---- Fallback until the migration is applied: step by step, ordered so a
  // failure part-way never loses the last good save. ----
  // A listing deleted since the cart was rung up would fail the line insert
  // after the sale row exists — refuse first.
  const varIds = [...new Set(lines.map((it) => it.variant_id).filter(Boolean) as string[])];
  if (varIds.length) {
    const found = new Set<string>();
    for (let i = 0; i < varIds.length; i += 80) {
      const { data: vs, error: vErr } = await locals.supabase.from("product_variants").select("id").in("id", varIds.slice(i, i + 80));
      if (vErr) return json({ error: `Couldn't check the items: ${vErr.message}. Nothing was saved.` }, 500);
      for (const v of (vs ?? []) as any[]) found.add(v.id);
    }
    if (varIds.some((v) => !found.has(v))) return json({ error: "An item in this cart is no longer in inventory (deleted) — remove it and try again. Nothing was saved.", state: "item_gone" }, 409);
  }

  // What the sale holds right now (after a partial save, so the register's
  // "press Save again" isn't refused as changed by its own lines).
  const currentLineIds = async (id: string) => {
    const out: string[] = [];
    for (let off = 0; ; off += 1000) {
      const { data: page } = await locals.supabase.from("transaction_items").select("id").eq("transaction_id", id).order("id").range(off, off + 999);
      out.push(...((page ?? []) as any[]).map((r) => r.id));
      if (!page || page.length < 1000) break;
    }
    return out;
  };
  let txn: any;
  let lineIds: string[] = [];
  if (resumeId) {
    // New lines go in FIRST, then the old ones are removed by id, then the
    // sale row is updated — if anything fails part-way the last good save
    // stays.
    const { data: cur, error: cErr } = await locals.supabase.from("transactions").select("id, status, is_tab, human_id").eq("id", resumeId).maybeSingle();
    if (cErr) return json({ error: `Couldn't read the sale: ${cErr.message}. Nothing was saved.` }, 500);
    if (!cur) return gone("missing");
    if (cur.is_tab) return gone("tab", cur.human_id, cur.id);
    if (cur.status !== "open") return gone(cur.status, cur.human_id, cur.id);
    const oldIds: string[] = [];
    for (let off = 0; ; off += 1000) {
      const { data: page, error: oErr } = await locals.supabase.from("transaction_items").select("id").eq("transaction_id", resumeId).order("id").range(off, off + 999);
      if (oErr) return json({ error: `Couldn't read the sale's items: ${oErr.message}. Nothing was saved.` }, 500);
      oldIds.push(...((page ?? []) as any[]).map((r) => r.id));
      if (!page || page.length < 1000) break;
    }
    if (expected && [...oldIds].sort().join() !== [...expected].sort().join()) return gone("changed", cur.human_id);
    const { data: ins, error: iErr } = await locals.supabase
      .from("transaction_items")
      .insert(lines.map((it) => ({ ...it, transaction_id: resumeId })))
      .select("id");
    if (iErr) return json({ error: `Couldn't save the items (the last save is unchanged): ${iErr.message}` }, 500);
    lineIds = ((ins ?? []) as any[]).map((r) => r.id);
    for (let i = 0; i < oldIds.length; i += 100) {
      let { error: dErr } = await locals.supabase.from("transaction_items").delete().in("id", oldIds.slice(i, i + 100));
      if (dErr) ({ error: dErr } = await locals.supabase.from("transaction_items").delete().in("id", oldIds.slice(i, i + 100)));
      if (dErr) return json({ error: `Not fully saved — press 💾 Save again here (your screen is right; don't reopen it from Held sales until it saves): ${dErr.message}`, state: "retry", lineIds: await currentLineIds(resumeId) }, 500);
    }
    const { data, error } = await locals.supabase
      .from("transactions")
      .update(fields)
      .eq("id", resumeId)
      .eq("status", "open") // only an open (held) sale can be resumed
      .eq("is_tab", false) // never let held-sale resume touch a bar tab
      .select()
      .maybeSingle();
    if (error) return json({ error: `Not fully saved — press 💾 Save again here: ${error.message}`, state: "retry", lineIds: await currentLineIds(resumeId) }, 500);
    if (!data) return gone("completed", cur.human_id);
    txn = data;
  } else {
    const { data, error } = await locals.supabase
      .from("transactions")
      .insert({ ...fields, employee_id: locals.user.id, type: "sale" })
      .select()
      .single();
    if (error) return json({ error: error.message }, 500);
    txn = data;
    const { data: ins, error: iErr } = await locals.supabase
      .from("transaction_items")
      .insert(lines.map((it) => ({ ...it, transaction_id: txn.id })))
      .select("id");
    if (iErr) {
      // Don't leave a sale with no lines behind: remove it — or, where this
      // employee may not delete sales, void it so it counts for nothing.
      const { data: del } = await locals.supabase.from("transactions").delete().eq("id", txn.id).select("id");
      if (!del?.length) await locals.supabase.from("transactions").update({ status: "void", subtotal_cents: 0, discount_cents: 0, total_cents: 0, cash_cents: 0, card_cents: 0, completed_at: null }).eq("id", txn.id);
      return json({ error: `Couldn't save the items — nothing was saved: ${iErr.message}` }, 500);
    }
    lineIds = ((ins ?? []) as any[]).map((r) => r.id);
  }

  // Take the sold copies out of stock (inventory lines only): counts read in
  // batches, written 10 at a time, each write only on the count it read (a
  // sale elsewhere meanwhile → re-read once); a count that can't be read is
  // never guessed — reported back to fix by hand.
  const stockMissed: string[] = [];
  if (status === "completed") {
    const sold = new Map<string, { qty: number; desc: string }>();
    for (const it of lines) {
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

  return json({ ok: true, id: txn.id, humanId: txn.human_id, lineIds, total, change, status, ...(stockMissed.length ? { stockMissed } : {}) });
};
