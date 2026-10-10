import type { APIRoute } from "astro";

export const prerender = false;
const json = (d: unknown, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { "content-type": "application/json" } });

// Sales history (Sales page). Reads run under the employee's own RLS: a
// cashier sees the sales they rang, managers see everyone's.
//   GET ?id=<uuid>                 → one sale with every line
//   GET ?q=&status=&days=&before= → a page of sales (newest first)
//   POST { action: "rename", id, note }                   → name the sale
//   POST { action: "payment", id, cashCents, cardCents }  → fix the cash /
//        card split of a completed sale (managers; must add up to its total)
const SALE_COLS = "id, human_id, type, status, note, created_at, completed_at, subtotal_cents, discount_cents, total_cents, cash_cents, card_cents, store_credit_cents, customer:customers(id, first_name, last_name), employee:profiles!transactions_employee_id_fkey(full_name)";

export const GET: APIRoute = async ({ locals, url }) => {
  if (!locals.user) return json({ error: "unauthorized" }, 401);
  const sb = locals.supabase;
  const id = url.searchParams.get("id");
  if (id) {
    const { data: sale, error } = await sb.from("transactions").select(SALE_COLS).eq("id", id).maybeSingle();
    if (error) return json({ error: error.message }, 500);
    if (!sale) return json({ error: "Sale not found (or not yours to see)." }, 404);
    const lines: any[] = [];
    for (let off = 0; ; off += 1000) {
      const { data: page, error: lErr } = await sb
        .from("transaction_items")
        .select("id, variant_id, kind, description, qty, unit_price_cents, discount_cents, department, inventory_type, region, category:categories(name), variant:product_variants(sku, completeness_code, grade_code, product:products(platform))")
        .eq("transaction_id", id)
        .order("created_at")
        .order("id")
        .range(off, off + 999);
      if (lErr) return json({ error: lErr.message }, 500);
      lines.push(...(page ?? []));
      if (!page || page.length < 1000) break;
    }
    return json({ ok: true, sale, lines, canEditPayment: locals.can("data.elevated") });
  }

  const q = (url.searchParams.get("q") ?? "").replace(/[,()*%\\]/g, " ").trim();
  const status = url.searchParams.get("status") === "open" ? "open" : "completed";
  const days = Math.max(0, Math.min(3650, parseInt(url.searchParams.get("days") ?? "") || 0));
  const before = url.searchParams.get("before");
  let query = sb.from("transactions").select(SALE_COLS).eq("type", "sale").eq("status", status).eq("is_tab", false);
  const dateCol = status === "open" ? "created_at" : "completed_at";
  if (days) query = query.gte(dateCol, new Date(Date.now() - days * 86400000).toISOString());
  if (before) query = query.lt(dateCol, before);
  if (q) {
    const n = parseInt(q.replace(/^#/, ""));
    query = /^#?\d+$/.test(q) && Number.isFinite(n) ? query.eq("human_id", n) : query.ilike("note", `%${q}%`);
  }
  const { data, error } = await query.order(dateCol, { ascending: false }).limit(50);
  if (error) return json({ error: error.message }, 500);
  // Units per sale for the list (one light query).
  const ids = (data ?? []).map((t: any) => t.id);
  const units = new Map<string, number>();
  for (let i = 0; i < ids.length; i += 50) {
    const { data: its } = await sb.from("transaction_items").select("transaction_id, qty, kind").in("transaction_id", ids.slice(i, i + 50));
    for (const it of (its ?? []) as any[]) if (it.kind === "sale" || it.kind === "service") units.set(it.transaction_id, (units.get(it.transaction_id) ?? 0) + (it.qty || 0));
  }
  return json({ ok: true, sales: (data ?? []).map((t: any) => ({ ...t, units: units.get(t.id) ?? 0 })) });
};

export const POST: APIRoute = async ({ locals, request }) => {
  if (!locals.user) return json({ error: "unauthorized" }, 401);
  const b = await request.json().catch(() => ({}));
  const sb = locals.supabase;
  if (!b.id || typeof b.id !== "string") return json({ error: "Which sale?" }, 400);

  if (b.action === "rename") {
    const note = String(b.note ?? "").trim().slice(0, 120) || null;
    const { data, error } = await sb.from("transactions").update({ note }).eq("id", b.id).eq("type", "sale").select("id, note").maybeSingle();
    if (error) return json({ error: error.message }, 500);
    if (!data) return json({ error: "Sale not found (or not yours to change)." }, 404);
    return json({ ok: true, note: data.note });
  }

  if (b.action === "payment") {
    if (!locals.can("data.elevated")) return json({ error: "Only a manager can change how a sale was paid." }, 403);
    const cash = Math.round(Number(b.cashCents)), card = Math.round(Number(b.cardCents));
    if (!Number.isFinite(cash) || !Number.isFinite(card) || cash < 0 || card < 0) return json({ error: "Type the cash and card amounts." }, 400);
    const { data: t, error: tErr } = await sb.from("transactions").select("id, status, total_cents, store_credit_cents").eq("id", b.id).maybeSingle();
    if (tErr) return json({ error: tErr.message }, 500);
    if (!t) return json({ error: "Sale not found." }, 404);
    if (t.status !== "completed") return json({ error: "Only a completed sale has a payment to fix." }, 409);
    const due = (t.total_cents ?? 0) - (t.store_credit_cents ?? 0);
    if (cash + card !== due) return json({ error: `Cash + card must add up to ${(due / 100).toFixed(2)} (the sale's total${t.store_credit_cents ? " minus store credit" : ""}).` }, 400);
    // Only the split changes — and only if nobody changed it meanwhile.
    const { data, error } = await sb.from("transactions").update({ cash_cents: cash, card_cents: card }).eq("id", b.id).eq("status", "completed").eq("total_cents", t.total_cents).select("id, cash_cents, card_cents").maybeSingle();
    if (error) return json({ error: error.message }, 500);
    if (!data) return json({ error: "The sale changed meanwhile — reload it." }, 409);
    return json({ ok: true, cashCents: data.cash_cents, cardCents: data.card_cents });
  }

  return json({ error: "Unknown action" }, 400);
};
