import type { APIRoute } from "astro";

export const prerender = false;
const json = (d: unknown, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { "content-type": "application/json", "cache-control": "no-store" } });

// Lightweight poll for the To-dos nav badge (open count) + manager alerts on
// freshly-completed tasks (only when the store setting is on and the viewer is a
// manager). Degrades to zeros if the tasks table isn't there yet.
export const GET: APIRoute = async ({ locals, url }) => {
  if (!locals.user) return json({ error: "unauthorized" }, 401);
  const sb = locals.supabase;

  const cRes = await sb.from("tasks").select("id", { count: "exact", head: true }).eq("status", "open");
  const openCount = cRes.error ? 0 : cRes.count ?? 0;

  let fresh: any[] = [];
  const isManager = locals.can("tasks.manage");
  const since = url.searchParams.get("since");
  if (isManager && since && !cRes.error) {
    const { data: row } = await sb.from("store_settings").select("settings").eq("id", 1).maybeSingle();
    if ((row?.settings as any)?.notifyTaskComplete) {
      const { data } = await sb
        .from("tasks")
        .select("id, title, completed_at")
        .eq("status", "done")
        .gt("completed_at", since)
        .order("completed_at", { ascending: false })
        .limit(10);
      fresh = data ?? [];
    }
  }
  return json({ ok: true, openCount, fresh });
};
