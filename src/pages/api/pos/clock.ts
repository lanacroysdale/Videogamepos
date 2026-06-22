import type { APIRoute } from "astro";

export const prerender = false;
const json = (d: unknown, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { "content-type": "application/json" } });

// Toggle clock in/out for the logged-in employee. Clocking IN can tag an activity
// (stored on time_entries.activity). Falls back gracefully if the column isn't
// there yet (migration not applied).
export const POST: APIRoute = async ({ locals, request }) => {
  if (!locals.user) return json({ error: "unauthorized" }, 401);
  const uid = locals.user.id;
  const body = await request.json().catch(() => ({} as any));

  const { data: open } = await locals.supabase
    .from("time_entries")
    .select("id")
    .eq("employee_id", uid)
    .is("clock_out", null)
    .maybeSingle();

  if (open) {
    const { error } = await locals.supabase.from("time_entries").update({ clock_out: new Date().toISOString() }).eq("id", open.id);
    if (error) return json({ error: error.message }, 500);
    return json({ ok: true, state: "out" });
  }

  const activity = typeof body.activity === "string" && body.activity.trim() ? body.activity.trim().slice(0, 60) : null;
  let { error } = await locals.supabase.from("time_entries").insert({ employee_id: uid, activity });
  // Pre-migration fallback: retry without the activity column.
  if (error && /activity/i.test(error.message)) {
    ({ error } = await locals.supabase.from("time_entries").insert({ employee_id: uid }));
  }
  if (error) return json({ error: error.message }, 500);
  return json({ ok: true, state: "in", activity });
};
