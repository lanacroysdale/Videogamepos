import type { APIRoute } from "astro";
import { createSupabaseAdminClient } from "../../../lib/supabase";
import { OWNER_ROLE, invalidateRolesCache } from "../../../lib/permissions";

export const prerender = false;
const json = (d: unknown, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { "content-type": "application/json" } });

// Readable temporary password (no ambiguous chars) for a newly-invited employee.
function genPw(): string {
  const a = "abcdefghijkmnpqrstuvwxyz23456789";
  const r = crypto.getRandomValues(new Uint8Array(10));
  return "TL-" + Array.from(r).map((x) => a[x % a.length]).join("");
}

// Effectively permanent: Supabase bans are a duration, not a flag.
const BAN_FOREVER = "876000h";

// Team management. `team.manage` = list / invite / change roles (owner +
// developer by default); `team.remove` = remove (owner only unless granted).
// Owner always passes both. All writes go through the service-role client
// AFTER the permission check.
export const POST: APIRoute = async ({ locals, request }) => {
  if (!locals.user) return json({ error: "unauthorized" }, 401);
  if (!locals.can("team.manage")) return json({ error: "You don't have permission to manage the team" }, 403);

  const admin = createSupabaseAdminClient();
  const b = await request.json().catch(() => ({} as any));
  const roleKeys = new Set(locals.roles.map((r) => r.key));
  const me = locals.user.id;

  const countOwners = async () => {
    const { count } = await admin.from("profiles").select("id", { count: "exact", head: true }).eq("role", OWNER_ROLE).is("removed_at", null);
    return count ?? 0;
  };

  if (b.action === "list") {
    const { data: profs } = await admin.from("profiles").select("*").order("full_name");
    // Per-id lookup (not bulk listUsers): bulk fails outright if any single auth
    // row can't be scanned, whereas this degrades that one user's email to blank.
    const emailById = new Map<string, string>(
      await Promise.all(
        (profs ?? []).map(async (p: any): Promise<[string, string]> => {
          const { data } = await admin.auth.admin.getUserById(p.id);
          return [p.id, data?.user?.email ?? ""];
        }),
      ),
    );
    const users = (profs ?? []).map((p: any) => ({
      id: p.id, full_name: p.full_name, role: p.role, removed_at: p.removed_at, email: emailById.get(p.id) ?? "", isYou: p.id === me,
    }));
    return json({ ok: true, users, roles: locals.roles });
  }

  if (b.action === "invite") {
    const email = String(b.email ?? "").trim().toLowerCase();
    const fullName = String(b.fullName ?? "").trim();
    const role = roleKeys.has(String(b.role)) ? String(b.role) : "cashier";
    if (!email.includes("@")) return json({ error: "A valid email is required" }, 400);
    if (!fullName) return json({ error: "Name is required" }, 400);

    const tempPassword = genPw();
    const { data, error } = await admin.auth.admin.createUser({
      email,
      password: tempPassword,
      email_confirm: true,
      user_metadata: { account_type: "employee", full_name: fullName, role }, // account_type=employee → trigger makes a staff profile
    });
    if (error) return json({ error: error.message }, 400);
    // Trigger creates the profile; upsert to be certain the name + role stick.
    await admin.from("profiles").upsert({ id: data.user!.id, full_name: fullName, role });
    return json({ ok: true, tempPassword, email });
  }

  if (b.action === "set-role") {
    const role = roleKeys.has(String(b.role)) ? String(b.role) : null;
    if (!b.userId || !role) return json({ error: "userId + role required" }, 400);
    if (b.userId === me) return json({ error: "You can't change your own role." }, 400);
    // Never strip the last owner.
    const { data: tgt } = await admin.from("profiles").select("role").eq("id", b.userId).maybeSingle();
    if (!tgt) return json({ error: "Employee not found" }, 404);
    if (tgt.role === OWNER_ROLE && role !== OWNER_ROLE && (await countOwners()) <= 1) {
      return json({ error: "You can't change the last owner's role." }, 400);
    }
    const { error } = await admin.from("profiles").update({ role }).eq("id", b.userId);
    if (error) return json({ error: error.message }, 500);
    return json({ ok: true });
  }

  // ---- Remove: soft-delete the profile + ban the login. History (sales,
  // entries, time clock) keeps pointing at the row, so this is reversible.
  if (b.action === "remove") {
    if (!locals.can("team.remove")) return json({ error: "Only the owner can remove employees" }, 403);
    if (!b.userId) return json({ error: "userId required" }, 400);
    if (b.userId === me) return json({ error: "You can't remove yourself." }, 400);
    const { data: tgt } = await admin.from("profiles").select("role, removed_at").eq("id", b.userId).maybeSingle();
    if (!tgt) return json({ error: "Employee not found" }, 404);
    if (tgt.removed_at) return json({ ok: true });
    if (tgt.role === OWNER_ROLE && (await countOwners()) <= 1) return json({ error: "You can't remove the last owner." }, 400);

    // Ban first (fails loudly if auth is unhappy), then flag the profile. The
    // card code + PIN go too so a badge swipe can't reach card-login.
    const { error: banErr } = await admin.auth.admin.updateUserById(b.userId, { ban_duration: BAN_FOREVER });
    if (banErr) return json({ error: banErr.message }, 500);
    const { error } = await admin.from("profiles").update({ removed_at: new Date().toISOString(), card_code: null, pin: null }).eq("id", b.userId);
    if (error) return json({ error: error.message }, 500);
    invalidateRolesCache();
    return json({ ok: true });
  }

  if (b.action === "restore") {
    if (!locals.can("team.remove")) return json({ error: "Only the owner can restore employees" }, 403);
    if (!b.userId) return json({ error: "userId required" }, 400);
    const { error: banErr } = await admin.auth.admin.updateUserById(b.userId, { ban_duration: "none" });
    if (banErr) return json({ error: banErr.message }, 500);
    const { error } = await admin.from("profiles").update({ removed_at: null }).eq("id", b.userId);
    if (error) return json({ error: error.message }, 500);
    return json({ ok: true });
  }

  return json({ error: "Unknown action" }, 400);
};
