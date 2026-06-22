import type { APIRoute } from "astro";
import { createSupabaseAdminClient } from "../../../lib/supabase";

export const prerender = false;
const json = (d: unknown, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { "content-type": "application/json" } });

const BUCKET = "documents";
const MAX_BYTES = 25 * 1024 * 1024; // matches the bucket's file_size_limit

// Strip CR/LF/quotes/backslash from a name before it goes into the signed URL's
// Content-Disposition (download) header, so a crafted file name can't malform it.
const safeDownloadName = (name: string) => name.replace(/[\r\n"\\]/g, "_");

// Reference document types allowed as SOP attachments. Images are allowed by
// prefix; everything else must be on this list (no executables/archives).
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

// Upload a document attachment to a SOP. Managers/owners only.
export const POST: APIRoute = async ({ locals, request }) => {
  if (!locals.user) return json({ error: "unauthorized" }, 401);
  const role = locals.profile?.role; // a staff profile only exists for employees
  if (!role) return json({ error: "Staff only" }, 403);
  if (!["owner", "manager"].includes(role)) return json({ error: "Managers only" }, 403);

  const form = await request.formData();
  const sopId = String(form.get("sopId") ?? "").trim();
  const file = form.get("file");
  if (!sopId) return json({ error: "sopId required" }, 400);
  if (!(file instanceof File) || file.size === 0) return json({ error: "No file provided" }, 400);
  if (file.size > MAX_BYTES) return json({ error: "File too large (25MB max)" }, 400);
  if (!okMime(file.type || "")) return json({ error: `Unsupported file type${file.type ? ` (${file.type})` : ""}` }, 400);

  const admin = createSupabaseAdminClient();

  // The SOP must exist (and tells us the migration has been applied).
  const { data: sop, error: sopErr } = await admin.from("sops").select("id").eq("id", sopId).maybeSingle();
  if (sopErr) return json({ error: "SOP storage isn't set up yet — run the migration." }, 400);
  if (!sop) return json({ error: "SOP not found" }, 404);

  const ext = (file.name.split(".").pop() || "bin").toLowerCase().replace(/[^a-z0-9]/g, "") || "bin";
  const path = `sops/${sopId}/${crypto.randomUUID()}.${ext}`;
  const bytes = new Uint8Array(await file.arrayBuffer());
  const { error: upErr } = await admin.storage.from(BUCKET).upload(path, bytes, {
    contentType: file.type || "application/octet-stream",
    upsert: false,
  });
  if (upErr) return json({ error: `Upload failed: ${upErr.message}` }, 500);

  const { data: row, error: insErr } = await admin.from("sop_files").insert({
    sop_id: sopId,
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

  // Touch the SOP so its "updated" stamp reflects the new attachment.
  await admin.from("sops").update({ updated_by: locals.user.id, updated_at: new Date().toISOString() }).eq("id", sopId);

  const { data: link } = await admin.storage.from(BUCKET).createSignedUrl(path, 60 * 60, { download: safeDownloadName(file.name) });
  return json({
    ok: true,
    file: { id: row.id, fileName: file.name, mimeType: file.type || null, sizeBytes: file.size, url: link?.signedUrl ?? null },
  });
};
