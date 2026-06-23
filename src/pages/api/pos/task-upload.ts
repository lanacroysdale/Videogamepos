import type { APIRoute } from "astro";
import { createSupabaseAdminClient } from "../../../lib/supabase";

export const prerender = false;
const json = (d: unknown, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { "content-type": "application/json" } });

const BUCKET = "documents";
const MAX_BYTES = 25 * 1024 * 1024; // matches the bucket's file_size_limit

// Attachment types allowed on a task. Images by prefix; everything else must be
// on this list (no executables/archives).
const OK_TYPES = new Set([
  "application/pdf",
  "text/plain", "text/markdown", "text/csv",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
]);
const okMime = (t: string) => t.startsWith("image/") || OK_TYPES.has(t);

// Upload a file attachment to a to-do task. Staff-level (matches task RLS).
export const POST: APIRoute = async ({ locals, request }) => {
  if (!locals.user) return json({ error: "unauthorized" }, 401);
  if (!locals.profile) return json({ error: "Staff only" }, 403); // a profile only exists for employees

  const form = await request.formData();
  const taskId = String(form.get("taskId") ?? "").trim();
  const file = form.get("file");
  if (!taskId) return json({ error: "taskId required" }, 400);
  if (!(file instanceof File) || file.size === 0) return json({ error: "No file provided" }, 400);
  if (file.size > MAX_BYTES) return json({ error: "File too large (25MB max)" }, 400);
  if (!okMime(file.type || "")) return json({ error: `Unsupported file type${file.type ? ` (${file.type})` : ""}` }, 400);

  const admin = createSupabaseAdminClient();

  // The task must exist (and tells us the migration has been applied).
  const { data: task, error: taskErr } = await admin.from("tasks").select("id").eq("id", taskId).maybeSingle();
  if (taskErr) return json({ error: "Task storage isn't set up yet — run migration 20260621000005_task_files.sql." }, 400);
  if (!task) return json({ error: "Task not found" }, 404);

  const ext = (file.name.split(".").pop() || "bin").toLowerCase().replace(/[^a-z0-9]/g, "") || "bin";
  const path = `tasks/${taskId}/${crypto.randomUUID()}.${ext}`;
  const bytes = new Uint8Array(await file.arrayBuffer());
  const { error: upErr } = await admin.storage.from(BUCKET).upload(path, bytes, {
    contentType: file.type || "application/octet-stream",
    upsert: false,
  });
  if (upErr) return json({ error: `Upload failed: ${upErr.message}` }, 500);

  const { data: row, error: insErr } = await admin.from("task_files").insert({
    task_id: taskId,
    file_name: file.name || `file.${ext}`,
    storage_path: path,
    mime_type: file.type || null,
    size_bytes: file.size,
    uploaded_by: locals.user.id,
  }).select("id").single();
  if (insErr) {
    await admin.storage.from(BUCKET).remove([path]); // don't orphan the object
    return json({ error: insErr.message }, 500);
  }

  const dl = (file.name || "file").replace(/[\r\n"\\]/g, "_"); // safe Content-Disposition
  const { data: link } = await admin.storage.from(BUCKET).createSignedUrl(path, 60 * 60, { download: dl });
  return json({
    ok: true,
    file: { id: row.id, fileName: file.name, mimeType: file.type || null, sizeBytes: file.size, url: link?.signedUrl ?? null },
  });
};
