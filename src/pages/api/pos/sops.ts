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
    const { data: sops, error } = await admin
      .from("sops")
      .select("id, title, category, pinned, updated_at, updated_by")
      .order("pinned", { ascending: false })
      .order("category", { ascending: true })
      .order("title", { ascending: true });
    if (error) return json({ ok: true, sops: [], categories: [], needsMigration: true });
    const fileCounts = new Map<string, number>();
    const { data: files } = await admin.from("sop_files").select("sop_id");
    (files ?? []).forEach((f: any) => fileCounts.set(f.sop_id, (fileCounts.get(f.sop_id) ?? 0) + 1));
    const names = await namesFor((sops ?? []).map((s: any) => s.updated_by));
    const list = (sops ?? []).map((s: any) => ({
      id: s.id, title: s.title, category: s.category, pinned: s.pinned,
      updatedAt: s.updated_at, updatedBy: s.updated_by ? names.get(s.updated_by) ?? "" : "",
      fileCount: fileCounts.get(s.id) ?? 0,
    }));
    const categories = [...new Set(list.map((s) => s.category))].sort();
    return json({ ok: true, sops: list, categories });
  }

  if (action === "get") {
    if (!b.id) return json({ error: "id required" }, 400);
    const { data: sop, error } = await admin.from("sops").select("*").eq("id", b.id).maybeSingle();
    if (error || !sop) return json({ error: "Not found" }, 404);
    const { data: files } = await admin
      .from("sop_files").select("*").eq("sop_id", b.id).order("created_at", { ascending: true });
    const names = await namesFor([sop.updated_by, sop.created_by]);
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
      },
      files: withUrls,
    });
  }

  // ---- Mutations: managers/owners only ----
  if (!isManager) return json({ error: "Managers only" }, 403);

  if (action === "create") {
    const title = String(b.title ?? "").trim();
    if (!title) return json({ error: "Title is required" }, 400);
    const { data, error } = await admin.from("sops").insert({
      title,
      category: String(b.category ?? "General").trim() || "General",
      body_md: String(b.bodyMd ?? ""),
      pinned: !!b.pinned,
      created_by: locals.user.id,
      updated_by: locals.user.id,
    }).select("id").single();
    if (error) return json({ error: error.message }, 500);
    return json({ ok: true, id: data.id });
  }

  if (action === "update") {
    if (!b.id) return json({ error: "id required" }, 400);
    const patch: Record<string, unknown> = { updated_by: locals.user.id, updated_at: new Date().toISOString() };
    if (b.title !== undefined) {
      const t = String(b.title).trim();
      if (!t) return json({ error: "Title can't be empty" }, 400);
      patch.title = t;
    }
    if (b.category !== undefined) patch.category = String(b.category).trim() || "General";
    if (b.bodyMd !== undefined) patch.body_md = String(b.bodyMd);
    if (b.pinned !== undefined) patch.pinned = !!b.pinned;
    const { error } = await admin.from("sops").update(patch).eq("id", b.id);
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
