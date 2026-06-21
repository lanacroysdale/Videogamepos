import type { APIRoute } from "astro";

export const prerender = false;
const json = (d: unknown, s = 200) =>
  new Response(JSON.stringify(d), { status: s, headers: { "content-type": "application/json" } });

const STATUSES = ["new", "contacted", "closed"];

// GET — used by the in-app notification poller. Returns the count of unworked
// ('new') leads for the nav badge, plus any leads newer than ?since (the last
// human_id the client has seen) so the browser can fire a desktop notification.
export const GET: APIRoute = async ({ locals, url }) => {
  if (!locals.user) return json({ error: "unauthorized" }, 401);
  const since = Number(url.searchParams.get("since") || "0") || 0;

  const { data: fresh } = await locals.supabase
    .from("leads")
    .select("human_id, type, first_name, last_name, created_at")
    .gt("human_id", since)
    .order("human_id", { ascending: false })
    .limit(20);

  const { count } = await locals.supabase
    .from("leads")
    .select("id", { count: "exact", head: true })
    .eq("status", "new");

  const rows = fresh ?? [];
  const maxId = rows.reduce((m: number, r: any) => Math.max(m, r.human_id), since);
  return json({ ok: true, newCount: count ?? 0, maxId, fresh: rows });
};

// POST — work a lead: change its status, or spin it into a customer record.
export const POST: APIRoute = async ({ locals, request }) => {
  if (!locals.user) return json({ error: "unauthorized" }, 401);
  const b = await request.json().catch(() => ({}));

  if (b.action === "updateStatus") {
    if (!STATUSES.includes(b.status)) return json({ error: "bad status" }, 400);
    const patch: Record<string, unknown> =
      b.status === "new"
        ? { status: "new", handled_by: null, handled_at: null }
        : { status: b.status, handled_by: locals.user.id, handled_at: new Date().toISOString() };
    const { error } = await locals.supabase.from("leads").update(patch).eq("id", b.id);
    if (error) return json({ error: error.message }, 500);
    return json({ ok: true });
  }

  if (b.action === "convertToCustomer") {
    const { data: lead, error: le } = await locals.supabase
      .from("leads")
      .select("*")
      .eq("id", b.id)
      .single();
    if (le || !lead) return json({ error: le?.message || "Lead not found" }, 404);
    if (lead.customer_id) return json({ ok: true, customer_id: lead.customer_id, already: true });

    const { data: cust, error: ce } = await locals.supabase
      .from("customers")
      .insert({
        first_name: lead.first_name || "New",
        last_name: lead.last_name || "",
        email: lead.email || null,
        phone: lead.phone || null,
        email_subscribed: lead.type === "free_club",
        membership: lead.type === "free_club" ? "member" : "standard",
        notes:
          lead.type === "sell_request" && lead.items ? `Sell request: ${lead.items}` : null,
      })
      .select("id")
      .single();
    if (ce) return json({ error: ce.message }, 500);

    await locals.supabase
      .from("leads")
      .update({
        customer_id: cust.id,
        status: lead.status === "new" ? "contacted" : lead.status,
        handled_by: locals.user.id,
        handled_at: new Date().toISOString(),
      })
      .eq("id", b.id);
    return json({ ok: true, customer_id: cust.id });
  }

  return json({ error: "unknown action" }, 400);
};
