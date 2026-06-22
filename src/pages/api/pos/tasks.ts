import type { APIRoute } from "astro";

export const prerender = false;
const json = (d: unknown, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { "content-type": "application/json" } });

// Shared store to-do list. Staff-level (RLS enforces is_staff on public.tasks).
export const POST: APIRoute = async ({ locals, request }) => {
  if (!locals.user) return json({ error: "unauthorized" }, 401);
  const sb = locals.supabase;
  const b = await request.json().catch(() => ({} as any));
  const action = b.action;

  if (action === "create") {
    const title = String(b.title ?? "").trim();
    if (!title) return json({ error: "Title required" }, 400);
    const row: Record<string, unknown> = {
      title: title.slice(0, 200),
      assignee_id: b.assigneeId || null,
      due_date: b.dueDate || null,
      created_by: locals.user.id,
    };
    const { data, error } = await sb.from("tasks").insert(row).select("id, title, notes, status, assignee_id, due_date, created_at, completed_at").single();
    if (error) return json({ error: error.message }, 500);
    return json({ ok: true, task: data });
  }

  if (action === "toggle") {
    if (!b.id) return json({ error: "id required" }, 400);
    const done = !!b.done;
    const { error } = await sb.from("tasks").update({ status: done ? "done" : "open", completed_at: done ? new Date().toISOString() : null }).eq("id", b.id);
    if (error) return json({ error: error.message }, 500);
    return json({ ok: true });
  }

  if (action === "update") {
    if (!b.id) return json({ error: "id required" }, 400);
    const patch: Record<string, unknown> = {};
    if (b.title !== undefined) patch.title = String(b.title).trim().slice(0, 200);
    if (b.assigneeId !== undefined) patch.assignee_id = b.assigneeId || null;
    if (b.dueDate !== undefined) patch.due_date = b.dueDate || null;
    if (b.notes !== undefined) patch.notes = b.notes ? String(b.notes).slice(0, 2000) : null;
    const { error } = await sb.from("tasks").update(patch).eq("id", b.id);
    if (error) return json({ error: error.message }, 500);
    return json({ ok: true });
  }

  if (action === "delete") {
    if (!b.id) return json({ error: "id required" }, 400);
    const { error } = await sb.from("tasks").delete().eq("id", b.id);
    if (error) return json({ error: error.message }, 500);
    return json({ ok: true });
  }

  return json({ error: "Unknown action" }, 400);
};
