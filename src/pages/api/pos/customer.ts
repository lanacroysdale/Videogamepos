import type { APIRoute } from "astro";

export const prerender = false;
const json = (d: unknown, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { "content-type": "application/json" } });

export const POST: APIRoute = async ({ locals, request }) => {
  if (!locals.user) return json({ error: "unauthorized" }, 401);
  const b = await request.json().catch(() => ({}));
  const sb = locals.supabase;

  if (b.action === "update") {
    if (!b.id) return json({ error: "id required" }, 400);
    const patch: Record<string, unknown> = {};
    if (b.first_name !== undefined) patch.first_name = String(b.first_name || "").trim() || "Customer";
    if (b.last_name !== undefined) patch.last_name = b.last_name || "";
    if (b.email !== undefined) patch.email = b.email || null;
    if (b.phone !== undefined) patch.phone = b.phone || null;
    if (b.membership !== undefined) patch.membership = b.membership || "standard";
    if (b.notes !== undefined) patch.notes = b.notes || null;
    if (b.storeCreditCents != null) patch.store_credit_cents = Math.max(0, Math.round(Number(b.storeCreditCents)));
    if (b.points != null) patch.points = Math.max(0, Math.round(Number(b.points)));
    if (b.emailSubscribed != null) patch.email_subscribed = !!b.emailSubscribed;
    if (b.textSubscribed != null) patch.text_subscribed = !!b.textSubscribed;
    const { error } = await sb.from("customers").update(patch).eq("id", b.id);
    if (error) return json({ error: error.message }, 500);
    return json({ ok: true });
  }

  // create
  if (!String(b.first_name ?? "").trim()) return json({ error: "First name is required" }, 400);
  const { data, error } = await sb
    .from("customers")
    .insert({
      first_name: String(b.first_name).trim(),
      last_name: b.last_name || "",
      email: b.email || null,
      phone: b.phone || null,
      membership: b.membership || "standard",
      store_credit_cents: Math.max(0, Math.round(Number(b.storeCreditCents)) || 0),
      points: Math.max(0, Math.round(Number(b.points)) || 0),
      email_subscribed: !!b.emailSubscribed,
      text_subscribed: !!b.textSubscribed,
      notes: b.notes || null,
    })
    .select()
    .single();
  if (error) return json({ error: error.message }, 500);
  return json({ ok: true, id: data.id });
};
