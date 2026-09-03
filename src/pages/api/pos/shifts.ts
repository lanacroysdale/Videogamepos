import type { APIRoute } from "astro";

export const prerender = false;
const json = (d: unknown, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { "content-type": "application/json" } });

// Managers create/remove scheduled shifts (enforced by RLS too).
export const POST: APIRoute = async ({ locals, request }) => {
  if (!locals.user) return json({ error: "unauthorized" }, 401);
  if (!locals.can("shifts.manage")) return json({ error: "You don't have permission to edit the schedule" }, 403);
  const b = await request.json().catch(() => ({}));

  if (b.action === "delete") {
    const { error } = await locals.supabase.from("shifts").delete().eq("id", b.id);
    if (error) return json({ error: error.message }, 500);
    return json({ ok: true });
  }

  if (!b.employeeId || !b.startsAt || !b.endsAt) return json({ error: "Employee, start and end are required" }, 400);
  if (new Date(b.endsAt) <= new Date(b.startsAt)) return json({ error: "End must be after start" }, 400);
  const { error } = await locals.supabase.from("shifts").insert({
    employee_id: b.employeeId,
    starts_at: new Date(b.startsAt).toISOString(),
    ends_at: new Date(b.endsAt).toISOString(),
    note: b.note || null,
  });
  if (error) return json({ error: error.message }, 500);
  return json({ ok: true });
};
