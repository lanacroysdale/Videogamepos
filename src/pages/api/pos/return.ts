import type { APIRoute } from "astro";
import { createSupabaseAdminClient } from "../../../lib/supabase";

export const prerender = false;
const json = (d: unknown, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { "content-type": "application/json" } });
const RETURN_WINDOW_DAYS = 30;

// Look up an original sale by its transaction number (admin read so any staff
// member can process a return regardless of which cashier rang it up).
export const GET: APIRoute = async ({ locals, url }) => {
  if (!locals.user) return json({ error: "unauthorized" }, 401);
  const ticket = parseInt(url.searchParams.get("ticket") ?? "");
  if (!ticket) return json({ error: "Transaction number required" }, 400);

  const admin = createSupabaseAdminClient();
  const { data: tx } = await admin
    .from("transactions")
    .select("id, human_id, completed_at, customer_id, total_cents, type, status, customer:customers(first_name,last_name), transaction_items(id, description, qty, unit_price_cents, discount_cents, category_id, kind)")
    .eq("human_id", ticket)
    .maybeSingle();
  if (!tx) return json({ error: "No transaction with that number" }, 404);

  const ageDays = tx.completed_at ? (Date.now() - new Date(tx.completed_at).getTime()) / 86400000 : 0;
  return json({ ok: true, transaction: tx, pastWindow: ageDays > RETURN_WINDOW_DAYS, windowDays: RETURN_WINDOW_DAYS });
};

export const POST: APIRoute = async ({ locals, request }) => {
  if (!locals.user) return json({ error: "unauthorized" }, 401);
  const b = await request.json().catch(() => ({}));
  const isManager = !!locals.profile && ["owner", "manager"].includes(locals.profile.role);

  const admin = createSupabaseAdminClient();
  const { data: orig } = await admin.from("transactions").select("id, completed_at, customer_id, human_id").eq("id", b.originalId).maybeSingle();
  if (!orig) return json({ error: "Original sale not found" }, 404);

  const ageDays = orig.completed_at ? (Date.now() - new Date(orig.completed_at).getTime()) / 86400000 : 0;
  if (ageDays > RETURN_WINDOW_DAYS && !isManager) {
    return json({ error: `Past the ${RETURN_WINDOW_DAYS}-day return window — a manager must approve this return.` }, 403);
  }

  const items = (b.items ?? []).map((it: any) => ({
    description: String(it.description ?? "Returned item").slice(0, 200),
    category_id: it.categoryId || null,
    kind: "return",
    qty: 1,
    unit_price_cents: Math.max(0, Math.round(Number(it.amountCents)) || 0),
    discount_cents: 0,
  }));
  if (!items.length) return json({ error: "Select at least one item to return" }, 400);
  const refund = items.reduce((s: number, it: any) => s + it.unit_price_cents, 0);
  const method = b.method === "credit" ? "credit" : "cash";

  const { data: ret, error } = await locals.supabase
    .from("transactions")
    .insert({
      customer_id: orig.customer_id,
      employee_id: locals.user.id,
      type: "return",
      status: "completed",
      subtotal_cents: refund,
      total_cents: refund,
      original_transaction_id: orig.id,
      approved_by: ageDays > RETURN_WINDOW_DAYS ? locals.user.id : null,
      cash_cents: method === "cash" ? refund : 0,
      store_credit_cents: method === "credit" ? refund : 0,
      completed_at: new Date().toISOString(),
      note: `Return of #${orig.human_id}`,
    })
    .select()
    .single();
  if (error) return json({ error: error.message }, 500);

  await locals.supabase.from("transaction_items").insert(items.map((it: any) => ({ ...it, transaction_id: ret.id })));

  if (method === "credit" && orig.customer_id) {
    const { data: c } = await locals.supabase.from("customers").select("store_credit_cents").eq("id", orig.customer_id).maybeSingle();
    if (c) await locals.supabase.from("customers").update({ store_credit_cents: c.store_credit_cents + refund }).eq("id", orig.customer_id);
  }

  return json({ ok: true, humanId: ret.human_id, refund, method });
};
