import type { APIRoute } from "astro";
import { PRIORITY_KEYS, storeToday } from "../../../lib/todos";

export const prerender = false;
const json = (d: unknown, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { "content-type": "application/json" } });
const prio = (p: any) => (PRIORITY_KEYS.includes(String(p)) ? String(p) : "normal");
const pts = (p: any) => Math.max(0, Math.min(1000, Math.round(Number(p)) || 0));

// Shared store to-do list + recurring daily checklist. Staff-level (RLS).
export const POST: APIRoute = async ({ locals, request }) => {
  if (!locals.user) return json({ error: "unauthorized" }, 401);
  const sb = locals.supabase;
  const uid = locals.user.id;
  const isManager = ["owner", "manager"].includes(locals.profile?.role ?? "");
  const b = await request.json().catch(() => ({} as any));
  const action = b.action;

  // ---- One-off tasks --------------------------------------------------------
  const v2col = (msg: string) => /priority|points|completed_by/i.test(msg); // pre-v2-migration columns

  if (action === "create") {
    const title = String(b.title ?? "").trim();
    if (!title) return json({ error: "Title required" }, 400);
    const row: Record<string, unknown> = {
      title: title.slice(0, 200),
      notes: b.notes ? String(b.notes).slice(0, 2000) : null,
      assignee_id: b.assigneeId || null,
      due_date: b.dueDate || null,
      priority: prio(b.priority),
      points: pts(b.points),
      created_by: uid,
    };
    let { data, error } = await sb.from("tasks").insert(row).select("id").single();
    if (error && v2col(error.message)) {
      delete row.priority; delete row.points;
      ({ data, error } = await sb.from("tasks").insert(row).select("id").single());
    }
    if (error) return json({ error: error.message }, 500);
    return json({ ok: true, task: data });
  }

  if (action === "toggle") {
    if (!b.id) return json({ error: "id required" }, 400);
    const done = !!b.done;
    const patch: Record<string, unknown> = { status: done ? "done" : "open", completed_at: done ? new Date().toISOString() : null, completed_by: done ? uid : null };
    let { error } = await sb.from("tasks").update(patch).eq("id", b.id);
    if (error && v2col(error.message)) { delete patch.completed_by; ({ error } = await sb.from("tasks").update(patch).eq("id", b.id)); }
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
    if (b.priority !== undefined) patch.priority = prio(b.priority);
    if (b.points !== undefined) patch.points = pts(b.points);
    let { error } = await sb.from("tasks").update(patch).eq("id", b.id);
    if (error && v2col(error.message)) { delete patch.priority; delete patch.points; ({ error } = await sb.from("tasks").update(patch).eq("id", b.id)); }
    if (error) return json({ error: error.message }, 500);
    return json({ ok: true });
  }

  if (action === "delete") {
    if (!b.id) return json({ error: "id required" }, 400);
    const { error } = await sb.from("tasks").delete().eq("id", b.id);
    if (error) return json({ error: error.message }, 500);
    return json({ ok: true });
  }

  // ---- Daily checklist templates (managers) --------------------------------
  if (action === "template-create" || action === "template-update" || action === "template-delete") {
    if (!isManager) return json({ error: "Managers only" }, 403);

    if (action === "template-create") {
      const title = String(b.title ?? "").trim();
      if (!title) return json({ error: "Title required" }, 400);
      const { data, error } = await sb.from("daily_task_templates").insert({
        title: title.slice(0, 200),
        notes: b.notes ? String(b.notes).slice(0, 2000) : null,
        priority: prio(b.priority),
        points: pts(b.points),
        created_by: uid,
      }).select("id").single();
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true, template: data });
    }
    if (action === "template-update") {
      if (!b.id) return json({ error: "id required" }, 400);
      const patch: Record<string, unknown> = {};
      if (b.title !== undefined) patch.title = String(b.title).trim().slice(0, 200);
      if (b.notes !== undefined) patch.notes = b.notes ? String(b.notes).slice(0, 2000) : null;
      if (b.priority !== undefined) patch.priority = prio(b.priority);
      if (b.points !== undefined) patch.points = pts(b.points);
      if (b.active !== undefined) patch.active = !!b.active;
      const { error } = await sb.from("daily_task_templates").update(patch).eq("id", b.id);
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true });
    }
    // template-delete
    const { error } = await sb.from("daily_task_templates").delete().eq("id", b.id);
    if (error) return json({ error: error.message }, 500);
    return json({ ok: true });
  }

  // ---- Daily completion toggle (any staff) ---------------------------------
  if (action === "daily-toggle") {
    if (!b.templateId) return json({ error: "templateId required" }, 400);
    const date = storeToday();
    if (b.done) {
      const { data: tmpl } = await sb.from("daily_task_templates").select("points").eq("id", b.templateId).maybeSingle();
      const { error } = await sb.from("daily_task_completions")
        .upsert({ template_id: b.templateId, completed_date: date, completed_by: uid, points: tmpl?.points ?? 0 }, { onConflict: "template_id,completed_date" });
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true });
    }
    const { error } = await sb.from("daily_task_completions").delete().eq("template_id", b.templateId).eq("completed_date", date);
    if (error) return json({ error: error.message }, 500);
    return json({ ok: true });
  }

  return json({ error: "Unknown action" }, 400);
};
