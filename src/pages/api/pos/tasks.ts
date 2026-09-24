import type { APIRoute } from "astro";
import { PRIORITY_KEYS, RECURRENCES, periodKey, type Recurrence } from "../../../lib/todos";
import { createSupabaseAdminClient } from "../../../lib/supabase";

export const prerender = false;
const json = (d: unknown, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { "content-type": "application/json" } });
const prio = (p: any) => (PRIORITY_KEYS.includes(String(p)) ? String(p) : "normal");
const pts = (p: any) => Math.max(0, Math.min(1000, Math.round(Number(p)) || 0));
const DOCS_BUCKET = "documents";
const LIST_KINDS = ["tasks", "recurring", "done"];

// A live category, or null. Pre-migration (no task_lists table) also → null.
async function liveList(sb: any, id: unknown) {
  if (!id) return null;
  const { data } = await sb.from("task_lists").select("id, kind, recurrence, managers_only").eq("id", id).is("removed_at", null).maybeSingle();
  return data as { id: string; kind: string; recurrence: Recurrence | null; managers_only: boolean } | null;
}

// Shared store to-do lists (manager-defined categories) + recurring checklists.
// Staff-level (RLS); managers-only categories are hidden from everyone else.
export const POST: APIRoute = async ({ locals, request }) => {
  if (!locals.user) return json({ error: "unauthorized" }, 401);
  const sb = locals.supabase;
  const uid = locals.user.id;
  const isManager = locals.can("tasks.manage");
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
    if (b.listId) {
      const list = await liveList(sb, b.listId);
      if (!list || list.kind !== "tasks") return json({ error: "That category can't hold tasks" }, 400);
      if (list.managers_only && !isManager) return json({ error: "Managers only" }, 403);
      row.list_id = list.id;
    }
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
    if (b.listId) {
      const list = await liveList(sb, b.listId);
      if (!list || list.kind !== "tasks") return json({ error: "That category can't hold tasks" }, 400);
      if (list.managers_only && !isManager) return json({ error: "Managers only" }, 403);
      patch.list_id = list.id;
    }
    let { error } = await sb.from("tasks").update(patch).eq("id", b.id);
    if (error && v2col(error.message)) { delete patch.priority; delete patch.points; ({ error } = await sb.from("tasks").update(patch).eq("id", b.id)); }
    if (error) return json({ error: error.message }, 500);
    return json({ ok: true });
  }

  if (action === "delete") {
    if (!b.id) return json({ error: "id required" }, 400);
    // Remove any attached storage objects first — the FK cascade only clears the
    // task_files DB rows, which would otherwise orphan the files in the bucket.
    const { data: visible } = await sb.from("tasks").select("id").eq("id", b.id).maybeSingle();
    if (!visible) return json({ error: "Task not found" }, 404);
    if (locals.profile) {
      const admin = createSupabaseAdminClient();
      const { data: files } = await admin.from("task_files").select("storage_path").eq("task_id", b.id);
      const paths = (files ?? []).map((f: any) => f.storage_path).filter(Boolean);
      if (paths.length) await admin.storage.from(DOCS_BUCKET).remove(paths);
    }
    const { error } = await sb.from("tasks").delete().eq("id", b.id);
    if (error) return json({ error: error.message }, 500);
    return json({ ok: true });
  }

  // ---- Task attachments (any staff; private bucket via signed URLs) ---------
  // These use the service-role client for storage, so gate on a staff profile
  // explicitly (admin bypasses RLS; a customer auth user has no profile).
  if (action === "files" || action === "remove-file") {
    if (!locals.profile) return json({ error: "Staff only" }, 403);
    const admin = createSupabaseAdminClient();

    // The task must be visible to this user (RLS hides managers-only lists).
    const { data: visible } = await sb.from("tasks").select("id").eq("id", b.taskId ?? "").maybeSingle();

    if (action === "files") {
      if (!b.taskId) return json({ error: "taskId required" }, 400);
      if (!visible) return json({ ok: true, files: [] });
      const { data, error } = await admin
        .from("task_files").select("id, file_name, mime_type, size_bytes, storage_path")
        .eq("task_id", b.taskId).order("created_at", { ascending: true });
      if (error) return json({ ok: true, files: [] }); // table not migrated yet
      const files = await Promise.all((data ?? []).map(async (f: any) => {
        const dl = String(f.file_name).replace(/[\r\n"\\]/g, "_"); // safe Content-Disposition
        const { data: link } = await admin.storage.from(DOCS_BUCKET).createSignedUrl(f.storage_path, 60 * 60, { download: dl });
        return { id: f.id, fileName: f.file_name, mimeType: f.mime_type, sizeBytes: f.size_bytes, url: link?.signedUrl ?? null };
      }));
      return json({ ok: true, files });
    }

    // remove-file — scoped to the task being edited so a stray/forged fileId
    // can't delete an attachment from an unrelated task.
    if (!b.fileId || !b.taskId) return json({ error: "fileId + taskId required" }, 400);
    if (!visible) return json({ error: "Task not found" }, 404);
    const { data: f } = await admin.from("task_files").select("task_id, storage_path").eq("id", b.fileId).maybeSingle();
    if (!f) return json({ ok: true }); // already gone
    if (f.task_id !== b.taskId) return json({ error: "File does not belong to this task" }, 403);
    if (f.storage_path) await admin.storage.from(DOCS_BUCKET).remove([f.storage_path]);
    const { error } = await admin.from("task_files").delete().eq("id", b.fileId);
    if (error) return json({ error: error.message }, 500);
    return json({ ok: true });
  }

  // ---- Daily checklist templates (managers) --------------------------------
  if (action === "template-create" || action === "template-update" || action === "template-delete") {
    if (!isManager) return json({ error: "You don't have permission to edit the daily checklist" }, 403);

    if (action === "template-create") {
      const title = String(b.title ?? "").trim();
      if (!title) return json({ error: "Title required" }, 400);
      let listId: string | null = null;
      if (b.listId) {
        const list = await liveList(sb, b.listId);
        if (!list || list.kind !== "recurring") return json({ error: "That category isn't a checklist" }, 400);
        listId = list.id;
      }
      const { data, error } = await sb.from("daily_task_templates").insert({
        ...(listId ? { list_id: listId } : {}),
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

  // ---- Recurring checklist toggle (any staff) -------------------------------
  // Check-offs are stored against the period's start date, so they "uncheck"
  // themselves when the next period (day / week / month, at 4 AM) begins.
  if (action === "daily-toggle") {
    if (!b.templateId) return json({ error: "templateId required" }, 400);
    let { data: tmpl, error: tErr } = await sb.from("daily_task_templates").select("points, list_id").eq("id", b.templateId).maybeSingle();
    if (tErr) ({ data: tmpl } = await sb.from("daily_task_templates").select("points").eq("id", b.templateId).maybeSingle()); // pre-migration
    if (!tmpl) return json({ error: "Checklist item not found" }, 404);
    const list = await liveList(sb, (tmpl as any).list_id);
    const date = periodKey(list?.recurrence ?? "daily");
    if (b.done) {
      const { error } = await sb.from("daily_task_completions")
        .upsert({ template_id: b.templateId, completed_date: date, completed_by: uid, points: tmpl.points ?? 0 }, { onConflict: "template_id,completed_date" });
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true });
    }
    const { error } = await sb.from("daily_task_completions").delete().eq("template_id", b.templateId).eq("completed_date", date);
    if (error) return json({ error: error.message }, 500);
    return json({ ok: true });
  }

  // ---- Categories (managers) -------------------------------------------------
  if (action === "list-create" || action === "list-remove") {
    if (!isManager) return json({ error: "Only managers can change categories" }, 403);

    if (action === "list-remove") {
      if (!b.id) return json({ error: "id required" }, 400);
      // Soft-remove: items and points history stay, and re-adding restores them.
      const { error } = await sb.from("task_lists").update({ removed_at: new Date().toISOString() }).eq("id", b.id);
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true });
    }

    const name = String(b.name ?? "").trim().replace(/\s+/g, " ").slice(0, 60);
    if (!name) return json({ error: "Name required" }, 400);
    const kind = LIST_KINDS.includes(b.kind) ? String(b.kind) : "tasks";
    const recurrence = kind === "recurring" ? (RECURRENCES.includes(b.recurrence) ? String(b.recurrence) : "daily") : null;
    const managersOnly = kind === "done" ? false : !!b.managersOnly;

    const { data: all, error: lErr } = await sb.from("task_lists").select("id, name, kind, recurrence, removed_at, sort_order");
    if (lErr) return json({ error: "Categories aren't set up yet — run migration 20260924000001_task_lists.sql." }, 400);
    const live = (all ?? []).filter((l: any) => !l.removed_at);
    if (live.some((l: any) => l.name.toLowerCase() === name.toLowerCase())) return json({ error: `"${name}" is already a category` }, 400);
    if (kind === "done" && live.some((l: any) => l.kind === "done")) return json({ error: "There's already a completed-tasks category" }, 400);
    const sort_order = Math.max(-1, ...live.map((l: any) => l.sort_order ?? 0)) + 1;

    // Re-adding a removed category of the same name + type brings its items back.
    const prior = (all ?? []).find((l: any) => l.removed_at && l.name.toLowerCase() === name.toLowerCase() && l.kind === kind && (l.recurrence ?? null) === recurrence);
    if (prior) {
      const { error } = await sb.from("task_lists").update({ removed_at: null, name, managers_only: managersOnly, sort_order }).eq("id", prior.id);
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true, list: { id: prior.id }, restored: true });
    }
    const { data, error } = await sb.from("task_lists")
      .insert({ name, kind, recurrence, managers_only: managersOnly, sort_order, created_by: uid }).select("id").single();
    if (error) return json({ error: error.message }, 500);
    return json({ ok: true, list: data });
  }

  return json({ error: "Unknown action" }, 400);
};
