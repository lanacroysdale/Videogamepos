import type { APIRoute } from "astro";

export const prerender = false;
const json = (d: unknown, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { "content-type": "application/json" } });

// Toggle clock in/out for the logged-in employee.
export const POST: APIRoute = async ({ locals }) => {
  if (!locals.user) return json({ error: "unauthorized" }, 401);
  const uid = locals.user.id;

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
  const { error } = await locals.supabase.from("time_entries").insert({ employee_id: uid });
  if (error) return json({ error: error.message }, 500);
  return json({ ok: true, state: "in" });
};
