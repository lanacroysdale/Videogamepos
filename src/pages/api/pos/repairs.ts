import type { APIRoute } from "astro";

export const prerender = false;
const json = (d: unknown, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { "content-type": "application/json" } });

export const POST: APIRoute = async ({ locals, request }) => {
  if (!locals.user) return json({ error: "unauthorized" }, 401);
  const b = await request.json().catch(() => ({}));

  if (b.action === "updateStatus") {
    const { error } = await locals.supabase
      .from("repairs")
      .update({ status: b.status, updated_at: new Date().toISOString() })
      .eq("id", b.id);
    if (error) return json({ error: error.message }, 500);
    return json({ ok: true });
  }

  // create
  if (!String(b.device_type ?? "").trim()) return json({ error: "Device type is required" }, 400);
  const row = {
    customer_name: b.customer_name || null,
    phone: b.phone || null,
    device_type: String(b.device_type).slice(0, 120),
    serial: b.serial || null,
    location: b.location || null,
    issue: b.issue || null,
    status: "in_queue",
    price_cents: Math.max(0, Math.round(Number(b.priceCents)) || 0),
    employee_id: locals.user.id,
  };
  const { data, error } = await locals.supabase.from("repairs").insert(row).select("ticket").single();
  if (error) return json({ error: error.message }, 500);
  return json({ ok: true, ticket: data.ticket });
};
