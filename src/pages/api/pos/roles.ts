import type { APIRoute } from "astro";
import { createSupabaseAdminClient } from "../../../lib/supabase";
import {
  OWNER_ROLE, PERMISSIONS, DEFAULT_ROLES, SYSTEM_ROLE_KEYS, invalidateRolesCache, sanitizePermissions,
} from "../../../lib/permissions";

export const prerender = false;
const json = (d: unknown, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { "content-type": "application/json" } });

const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 32);
const cleanName = (s: unknown) => String(s ?? "").trim().replace(/\s+/g, " ").slice(0, 40);
const cleanDesc = (s: unknown) => String(s ?? "").trim().slice(0, 240);

// Roles & permissions — GOVERNED like departments: the table has no
// authenticated write policy, every write goes through this service-role API
// after a `roles.manage` check (owner always; developer by default), and a DB
// trigger stops even this API deleting/re-keying built-in roles.
export const GET: APIRoute = async ({ locals }) => {
  if (!locals.user) return json({ error: "unauthorized" }, 401);
  if (!locals.can("roles.manage")) return json({ error: "You don't have permission to edit roles" }, 403);
  return json({ ok: true, roles: locals.roles, permissions: PERMISSIONS });
};

export const POST: APIRoute = async ({ locals, request }) => {
  if (!locals.user) return json({ error: "unauthorized" }, 401);
  if (!locals.can("roles.manage")) return json({ error: "You don't have permission to edit roles" }, 403);

  const admin = createSupabaseAdminClient();
  const b = await request.json().catch(() => ({} as any));
  const a = b.action;
  const fail = (e: any) => json({ error: e?.message || "Failed" }, 500);
  const done = async () => {
    invalidateRolesCache();
    const { data } = await admin.from("store_roles").select("*").order("sort_order").order("name");
    return json({ ok: true, roles: data ?? [] });
  };

  const { data: existing, error: loadErr } = await admin.from("store_roles").select("key, is_system, permissions, sort_order");
  if (loadErr) return json({ error: "Roles aren't set up yet — apply migration 20260903000001_roles_and_permissions.sql first." }, 400);
  const byKey = new Map((existing ?? []).map((r: any) => [r.key, r]));

  if (a === "create") {
    const name = cleanName(b.name);
    if (!name) return json({ error: "Give the role a name" }, 400);
    let key = slugify(name) || "role";
    if (byKey.has(key)) return json({ error: `A role called "${name}" already exists` }, 400);
    // Start from an existing role's permissions (default: none), never the owner's implicit "all".
    const src = b.copyFrom && byKey.get(String(b.copyFrom));
    const permissions = src && src.key !== OWNER_ROLE ? sanitizePermissions(src.permissions) : [];
    const sort_order = Math.max(0, ...(existing ?? []).map((r: any) => Number(r.sort_order) || 0)) + 1;
    const { error } = await admin.from("store_roles").insert({ key, name, description: cleanDesc(b.description), is_system: false, sort_order, permissions });
    if (error) return fail(error);
    return done();
  }

  if (a === "rename") {
    const key = String(b.key ?? "");
    if (!byKey.has(key)) return json({ error: "Role not found" }, 404);
    const patch: Record<string, unknown> = {};
    if (b.name !== undefined) { const name = cleanName(b.name); if (!name) return json({ error: "Name can't be empty" }, 400); patch.name = name; }
    if (b.description !== undefined) patch.description = cleanDesc(b.description);
    const { error } = await admin.from("store_roles").update(patch).eq("key", key);
    if (error) return fail(error);
    return done();
  }

  if (a === "set-permissions") {
    const key = String(b.key ?? "");
    if (!byKey.has(key)) return json({ error: "Role not found" }, 404);
    if (key === OWNER_ROLE) return json({ error: "The owner always has every permission." }, 400);
    const { error } = await admin.from("store_roles").update({ permissions: sanitizePermissions(b.permissions) }).eq("key", key);
    if (error) return fail(error);
    return done();
  }

  if (a === "reset") {
    const key = String(b.key ?? "");
    const def = DEFAULT_ROLES.find((r) => r.key === key);
    if (!def || !(SYSTEM_ROLE_KEYS as readonly string[]).includes(key)) return json({ error: "Only built-in roles have defaults" }, 400);
    const { error } = await admin.from("store_roles").update({ permissions: def.permissions, name: def.name, description: def.description }).eq("key", key);
    if (error) return fail(error);
    return done();
  }

  if (a === "delete") {
    const key = String(b.key ?? "");
    const row = byKey.get(key);
    if (!row) return json({ error: "Role not found" }, 404);
    if (row.is_system) return json({ error: "Built-in roles can't be deleted (you can rename them or clear their permissions)." }, 400);
    const { count } = await admin.from("profiles").select("id", { count: "exact", head: true }).eq("role", key);
    if ((count ?? 0) > 0) return json({ error: `${count} employee${count === 1 ? " still has" : "s still have"} this role — move them to another role first.` }, 400);
    const { error } = await admin.from("store_roles").delete().eq("key", key);
    if (error) return fail(error);
    return done();
  }

  return json({ error: "Unknown action" }, 400);
};
