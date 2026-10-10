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
//   POST { action: "undo", id } → reopen a sale completed TODAY (before
//        midnight, store time) as a held sale; its items go back into stock
//        (managers; undo_sale, migration 20261009000001)
// The store's day ends at midnight in its own timezone (store setting
// "timezone", else Portland — the app's existing default).
async function storeTz(sb: any): Promise<string> {
  const { data } = await sb.from("store_settings").select("settings").eq("id", 1).maybeSingle();
  const tz = String((data as any)?.settings?.timezone ?? "");
  try { if (tz) { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return tz; } } catch { /* bad value */ }
  return "America/Los_Angeles";
}
const dayIn = (d: Date, tz: string) => new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);

const SALE_COLS = "id, human_id, type, status, note, created_at, completed_at, subtotal_cents, discount_cents, total_cents, cash_cents, card_cents, store_credit_cents, customer:customers(id, first_name, last_name), employee:profiles!transactions_employee_id_fkey(full_name)";

export const GET: APIRoute = async ({ locals, url }) => {
  if (!locals.user) return json({ error: "unauthorized" }, 401);
  const sb = locals.supabase;
  const id = url.searchParams.get("id");
  if (id) {
    const { data: sale, error } = await sb.from("transactions").select(SALE_COLS).eq("id", id).maybeSingle();
    if (error) return json({ error: error.message }, 500);
    if (!sale) return json({ error: "Sale not found (or not yours to see)." }, 404);
    // Lines in the order they were rung up (line_no, migration
    // 20261009000001; until it's applied, when they were saved).
    const lines: any[] = [];
    let byLineNo = true;
    for (let off = 0; ; off += 1000) {
      let q = sb
        .from("transaction_items")
        .select("id, variant_id, kind, description, qty, unit_price_cents, discount_cents, department, inventory_type, region, category:categories(name), variant:product_variants(sku, completeness_code, grade_code, product:products(platform))")
        .eq("transaction_id", id);
      if (byLineNo) q = q.order("line_no");
      const { data: page, error: lErr } = await q.order("created_at").order("id").range(off, off + 999);
      if (lErr && byLineNo && off === 0 && /line_no/.test(lErr.message || "")) { byLineNo = false; off -= 1000; continue; }
      if (lErr) return json({ error: lErr.message }, 500);
      lines.push(...(page ?? []));
      if (!page || page.length < 1000) break;
    }
    // Undo is offered for a sale completed today (store time), by a manager,
    // with no store credit (the server re-checks all of it).
    const mgr = locals.can("data.elevated");
    let undoable = false;
    if (mgr && (sale as any).status === "completed" && (sale as any).type === "sale" && (sale as any).completed_at && !(sale as any).store_credit_cents) {
      const tz = await storeTz(sb);
      undoable = dayIn(new Date((sale as any).completed_at), tz) === dayIn(new Date(), tz);
    }
    return json({ ok: true, sale, lines, canEditPayment: mgr, undoable });
  }

  const q = (url.searchParams.get("q") ?? "").replace(/[,()*%\\]/g, " ").trim();
  const status = url.searchParams.get("status") === "open" ? "open" : "completed";
  const days = Math.max(0, Math.min(3650, parseInt(url.searchParams.get("days") ?? "") || 0));
  // since = the start of the range as the register's clock sees it ("Today"
  // = since its midnight); else the last `days` days.
  const sinceRaw = url.searchParams.get("since");
  const since = sinceRaw && !Number.isNaN(Date.parse(sinceRaw)) ? new Date(sinceRaw).toISOString() : null;
  const before = url.searchParams.get("before");
  let query = sb.from("transactions").select(SALE_COLS).eq("type", "sale").eq("status", status).eq("is_tab", false);
  const dateCol = status === "open" ? "created_at" : "completed_at";
  const num = /^#?\d+$/.test(q) ? parseInt(q.replace(/^#/, "")) : NaN;
  // A sale number is found whatever range is picked.
  if (!Number.isFinite(num)) {
    if (since) query = query.gte(dateCol, since);
    else if (days) query = query.gte(dateCol, new Date(Date.now() - days * 86400000).toISOString());
  }
  if (before) query = query.lt(dateCol, before);
  if (q) query = Number.isFinite(num) ? query.eq("human_id", num) : query.ilike("note", `%${q}%`);
  const { data, error } = await query.order(dateCol, { ascending: false }).limit(50);
  if (error) return json({ error: error.message }, 500);
  // Units per sale for the list (one light query).
  const ids = (data ?? []).map((t: any) => t.id);
  const units = new Map<string, number>();
  for (let i = 0; i < ids.length; i += 50) {
    // (paged: a day's PRGE sale alone can have hundreds of lines)
    for (let off = 0; ; off += 1000) {
      const { data: its } = await sb.from("transaction_items").select("id, transaction_id, qty, kind").in("transaction_id", ids.slice(i, i + 50)).order("id").range(off, off + 999);
      for (const it of (its ?? []) as any[]) if (it.kind === "sale" || it.kind === "service") units.set(it.transaction_id, (units.get(it.transaction_id) ?? 0) + (it.qty || 0));
      if (!its || its.length < 1000) break;
    }
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

  if (b.action === "undo") {
    if (!locals.can("data.elevated")) return json({ error: "Only a manager can undo a sale." }, 403);
    const { data: r, error } = await sb.rpc("undo_sale", { p_id: b.id, p_tz: await storeTz(sb) });
    if (error) {
      if (error.code === "PGRST202" || /could not find the function/i.test(error.message || "")) return json({ error: "Undo needs the database update (the save_sale SQL) — ask the owner to run it in Supabase." }, 503);
      return json({ error: error.message }, 500);
    }
    if (!(r as any)?.ok) {
      const st = (r as any)?.state, n = (r as any)?.human_id;
      const msg = st === "past_midnight" ? `Sale #${n} was completed before today — it can only be undone the same day (before midnight). Use Returns instead.`
        : st === "store_credit" ? `Sale #${n} was partly paid with store credit — use Returns instead.`
        : st === "returned" ? `Items from sale #${n} were already returned — it can't be undone.`
        : st === "open" ? `Sale #${n} is already held (open).`
        : st === "not_sale" ? "That isn't a retail sale."
        : st && st !== "missing" ? `Sale #${n} is ${st} — it can't be undone.`
        : "Sale not found.";
      return json({ error: msg, state: st }, 409);
    }
    return json({ ok: true, id: (r as any).id, humanId: (r as any).human_id });
  }

  return json({ error: "Unknown action" }, 400);
};
