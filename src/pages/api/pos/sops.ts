import type { APIRoute } from "astro";
import { createSupabaseAdminClient } from "../../../lib/supabase";

export const prerender = false;
const json = (d: unknown, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { "content-type": "application/json" } });

const BUCKET = "documents";
const SIGNED_TTL = 60 * 60; // 1h — links are regenerated on every view

// Internal SOP library. Staff can read; managers/owners author + edit + delete.
// Uses the service-role client for reliable reads of author names / file paths,
// with auth + role enforced here in code (every action is gated below).
export const POST: APIRoute = async ({ locals, request }) => {
  if (!locals.user) return json({ error: "unauthorized" }, 401);
  const role = locals.profile?.role; // a staff profile only exists for employees
  if (!role) return json({ error: "Staff only" }, 403);
  const isManager = ["owner", "manager"].includes(role);
  const isOwner = role === "owner";
  const uid = locals.user.id;
  const now = new Date().toISOString();
  // Tolerate running before the approval migration is applied: if a write hits a
  // missing approval column, we retry without those fields. Requires BOTH an
  // approval-column name AND a missing-column phrase, so an unrelated DB error
  // (e.g. a not-null violation) isn't silently swallowed.
  const approvalColMissing = (msg: string) =>
    /status|approved_by|approved_at/i.test(msg) && /does not exist|schema cache|column/i.test(msg);
  // A SOP is visible to a cashier once it's been approved at least once. Pre-migration
  // rows have no approved_at field at all → treat as visible (old behavior).
  const everApproved = (s: any) => !("approved_at" in s) || s.approved_at != null;

  const admin = createSupabaseAdminClient();
  const b = await request.json().catch(() => ({} as any));
  const action = b.action;

  // Resolve author display names for a set of profile ids.
  const namesFor = async (ids: (string | null)[]) => {
    const uniq = [...new Set(ids.filter(Boolean))] as string[];
    if (!uniq.length) return new Map<string, string>();
    const { data } = await admin.from("profiles").select("id, full_name").in("id", uniq);
    return new Map((data ?? []).map((p: any) => [p.id, p.full_name as string]));
  };

  const signed = async (path: string, fileName: string) => {
    // Sanitize before the Content-Disposition (download) header so a crafted
    // file name can't malform it.
    const dl = fileName.replace(/[\r\n"\\]/g, "_");
    const { data } = await admin.storage.from(BUCKET).createSignedUrl(path, SIGNED_TTL, { download: dl });
    return data?.signedUrl ?? null;
  };

  if (action === "list") {
    // select("*") so missing approval columns don't error pre-migration.
    const { data: rows, error } = await admin
      .from("sops").select("*")
      .order("pinned", { ascending: false })
      .order("category", { ascending: true })
      .order("title", { ascending: true });
    if (error) return json({ ok: true, sops: [], categories: [], needsMigration: true });
    // Cashiers only see approved SOPs; managers/owners see everything.
    const sops = (rows ?? []).filter((s: any) => isManager || everApproved(s));
    const fileCounts = new Map<string, number>();
    const { data: files } = await admin.from("sop_files").select("sop_id");
    (files ?? []).forEach((f: any) => fileCounts.set(f.sop_id, (fileCounts.get(f.sop_id) ?? 0) + 1));
    const names = await namesFor(sops.flatMap((s: any) => [s.updated_by, s.created_by]));
    const list = sops.map((s: any) => ({
      id: s.id, title: s.title, category: s.category, pinned: s.pinned,
      status: s.status ?? "approved",
      updatedAt: s.updated_at, updatedBy: s.updated_by ? names.get(s.updated_by) ?? "" : "",
      createdBy: s.created_by ? names.get(s.created_by) ?? "" : "",
      fileCount: fileCounts.get(s.id) ?? 0,
    }));
    const categories = [...new Set(list.map((s) => s.category))].sort();
    const pendingCount = list.filter((s) => s.status === "pending").length;
    return json({ ok: true, sops: list, categories, pendingCount });
  }

  if (action === "pending-count") {
    if (!isOwner) return json({ ok: true, count: 0 });
    const { count, error } = await admin.from("sops").select("id", { count: "exact", head: true }).eq("status", "pending");
    return json({ ok: true, count: error ? 0 : count ?? 0 });
  }

  if (action === "get") {
    if (!b.id) return json({ error: "id required" }, 400);
    const { data: sop, error } = await admin.from("sops").select("*").eq("id", b.id).maybeSingle();
    if (error || !sop) return json({ error: "Not found" }, 404);
    if (!isManager && !everApproved(sop)) return json({ error: "Not found" }, 404); // hide unapproved from cashiers
    const { data: files } = await admin
      .from("sop_files").select("*").eq("sop_id", b.id).order("created_at", { ascending: true });
    const names = await namesFor([sop.updated_by, sop.created_by, sop.approved_by]);
    const withUrls = await Promise.all((files ?? []).map(async (f: any) => ({
      id: f.id, fileName: f.file_name, mimeType: f.mime_type, sizeBytes: f.size_bytes,
      url: await signed(f.storage_path, f.file_name),
    })));
    return json({
      ok: true,
      sop: {
        id: sop.id, title: sop.title, category: sop.category, bodyMd: sop.body_md, pinned: sop.pinned,
        updatedAt: sop.updated_at, createdAt: sop.created_at,
        updatedBy: sop.updated_by ? names.get(sop.updated_by) ?? "" : "",
        createdBy: sop.created_by ? names.get(sop.created_by) ?? "" : "",
        status: sop.status ?? "approved",
        approvedBy: sop.approved_by ? names.get(sop.approved_by) ?? "" : "",
        approvedAt: sop.approved_at ?? null,
      },
      files: withUrls,
    });
  }

  // ---- Mutations: managers/owners only ----
  if (!isManager) return json({ error: "Managers only" }, 403);

  if (action === "create") {
    const title = String(b.title ?? "").trim();
    if (!title) return json({ error: "Title is required" }, 400);
    const base: Record<string, unknown> = {
      title,
      category: String(b.category ?? "General").trim() || "General",
      body_md: String(b.bodyMd ?? ""),
      pinned: !!b.pinned,
      created_by: uid,
      updated_by: uid,
    };
    // Owner's own SOPs are auto-approved; a manager's go to the owner pending.
    const approval = isOwner ? { status: "approved", approved_by: uid, approved_at: now } : { status: "pending" };
    let { data, error } = await admin.from("sops").insert({ ...base, ...approval }).select("id").single();
    if (error && approvalColMissing(error.message)) ({ data, error } = await admin.from("sops").insert(base).select("id").single());
    if (error) return json({ error: error.message }, 500);
    return json({ ok: true, id: data!.id, status: isOwner ? "approved" : "pending" });
  }

  if (action === "approve") {
    if (!isOwner) return json({ error: "Only the owner can approve SOPs." }, 403);
    if (!b.id) return json({ error: "id required" }, 400);
    const { error } = await admin.from("sops").update({ status: "approved", approved_by: uid, approved_at: now }).eq("id", b.id);
    if (error) return json({ error: approvalColMissing(error.message) ? "Run the SOP approval migration first." : error.message }, 500);
    return json({ ok: true });
  }

  if (action === "update") {
    if (!b.id) return json({ error: "id required" }, 400);
    const patch: Record<string, unknown> = { updated_by: uid, updated_at: now };
    if (b.title !== undefined) {
      const t = String(b.title).trim();
      if (!t) return json({ error: "Title can't be empty" }, 400);
      patch.title = t;
    }
    if (b.category !== undefined) patch.category = String(b.category).trim() || "General";
    if (b.bodyMd !== undefined) patch.body_md = String(b.bodyMd);
    if (b.pinned !== undefined) patch.pinned = !!b.pinned;
    // Only a content change re-triggers approval — pinning/unpinning shouldn't.
    // Owner edits stay approved; a manager's edit sends it back to pending for
    // sign-off (approved_at is left intact so a previously-approved SOP stays
    // visible to cashiers while the new version awaits approval).
    const contentEdit = b.title !== undefined || b.category !== undefined || b.bodyMd !== undefined;
    const approval = !contentEdit ? {} : isOwner ? { status: "approved", approved_by: uid, approved_at: now } : { status: "pending" };
    let { error } = await admin.from("sops").update({ ...patch, ...approval }).eq("id", b.id);
    if (error && approvalColMissing(error.message)) ({ error } = await admin.from("sops").update(patch).eq("id", b.id));
    if (error) return json({ error: error.message }, 500);
    return json({ ok: true });
  }

  if (action === "delete") {
    if (!b.id) return json({ error: "id required" }, 400);
    // Remove the attachments from storage first, then the row (cascade clears
    // the sop_files rows).
    const { data: files } = await admin.from("sop_files").select("storage_path").eq("sop_id", b.id);
    const paths = (files ?? []).map((f: any) => f.storage_path).filter(Boolean);
    if (paths.length) await admin.storage.from(BUCKET).remove(paths);
    const { error } = await admin.from("sops").delete().eq("id", b.id);
    if (error) return json({ error: error.message }, 500);
    return json({ ok: true });
  }

  if (action === "remove-file") {
    if (!b.fileId) return json({ error: "fileId required" }, 400);
    const { data: f } = await admin.from("sop_files").select("storage_path").eq("id", b.fileId).maybeSingle();
    if (f?.storage_path) await admin.storage.from(BUCKET).remove([f.storage_path]);
    const { error } = await admin.from("sop_files").delete().eq("id", b.fileId);
    if (error) return json({ error: error.message }, 500);
    return json({ ok: true });
  }

  return json({ error: "Unknown action" }, 400);
};
