import type { APIRoute } from "astro";

export const prerender = false;
const json = (d: unknown, s = 200) =>
  new Response(JSON.stringify(d), { status: s, headers: { "content-type": "application/json" } });

// The inbox poller. RLS already scopes rows to what this employee may see
// (their role is in the audience, or they're the owner), so the count is
// "unread among visible". ?since=<human_id> returns anything newer for the
// desktop notification. A missing table (migration pending) reads as empty.
export const GET: APIRoute = async ({ locals, url }) => {
  if (!locals.user) return json({ error: "unauthorized" }, 401);
  const since = Number(url.searchParams.get("since") || "0") || 0;
  const sb = locals.supabase;

  const { data: reads, error: rerr } = await sb.from("notification_reads").select("notification_id").eq("user_id", locals.user.id);
  if (rerr) return json({ ok: true, unread: 0, maxId: since, fresh: [], ready: false });
  const readIds = new Set((reads ?? []).map((r: any) => r.notification_id));

  const { data: recent } = await sb
    .from("notifications")
    .select("id, human_id, type, title, body, href, created_at")
    .order("human_id", { ascending: false })
    .limit(200);
  const rows = recent ?? [];
  const unread = rows.filter((n: any) => !readIds.has(n.id)).length;
  const fresh = rows.filter((n: any) => n.human_id > since).slice(0, 20);
  const maxId = rows.reduce((m: number, r: any) => Math.max(m, r.human_id), since);
  return json({ ok: true, unread, maxId, fresh, ready: true });
};

export const POST: APIRoute = async ({ locals, request }) => {
  if (!locals.user) return json({ error: "unauthorized" }, 401);
  const b = await request.json().catch(() => ({}));
  const sb = locals.supabase;
  const uid = locals.user.id;

  if (b.action === "markRead") {
    const ids = (Array.isArray(b.ids) ? b.ids : [b.id]).filter((x: any) => typeof x === "string" && x);
    if (!ids.length) return json({ error: "nothing to mark" }, 400);
    const { error } = await sb.from("notification_reads").upsert(ids.map((id: string) => ({ notification_id: id, user_id: uid })), { onConflict: "notification_id,user_id", ignoreDuplicates: true });
    if (error) return json({ error: error.message }, 500);
    return json({ ok: true });
  }
  if (b.action === "markUnread") {
    const { error } = await sb.from("notification_reads").delete().eq("user_id", uid).eq("notification_id", String(b.id ?? ""));
    if (error) return json({ error: error.message }, 500);
    return json({ ok: true });
  }
  if (b.action === "markAllRead") {
    const { data: all } = await sb.from("notifications").select("id").limit(1000);
    const ids = (all ?? []).map((n: any) => n.id);
    if (ids.length) {
      const { error } = await sb.from("notification_reads").upsert(ids.map((id: string) => ({ notification_id: id, user_id: uid })), { onConflict: "notification_id,user_id", ignoreDuplicates: true });
      if (error) return json({ error: error.message }, 500);
    }
    return json({ ok: true, count: ids.length });
  }
  return json({ error: "unknown action" }, 400);
};
