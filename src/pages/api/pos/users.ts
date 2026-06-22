import type { APIRoute } from "astro";
import { createSupabaseAdminClient } from "../../../lib/supabase";

export const prerender = false;
const json = (d: unknown, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { "content-type": "application/json" } });
const ROLES = ["owner", "manager", "cashier"];

// Readable temporary password (no ambiguous chars) for a newly-invited employee.
function genPw(): string {
  const a = "abcdefghijkmnpqrstuvwxyz23456789";
  const r = crypto.getRandomValues(new Uint8Array(10));
  return "TL-" + Array.from(r).map((x) => a[x % a.length]).join("");
}

// Team management — OWNER ONLY (provisioning + access control are high-privilege).
export const POST: APIRoute = async ({ locals, request }) => {
  if (!locals.user) return json({ error: "unauthorized" }, 401);
  if (locals.profile?.role !== "owner") return json({ error: "Owners only" }, 403);

  const admin = createSupabaseAdminClient();
  const b = await request.json().catch(() => ({} as any));

  if (b.action === "list") {
    const { data: profs } = await admin.from("profiles").select("id, full_name, role").order("full_name");
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
    const users = (profs ?? []).map((p: any) => ({ id: p.id, full_name: p.full_name, role: p.role, email: emailById.get(p.id) ?? "", isYou: p.id === locals.user!.id }));
    return json({ ok: true, users });
  }

  if (b.action === "invite") {
    const email = String(b.email ?? "").trim().toLowerCase();
    const fullName = String(b.fullName ?? "").trim();
    const role = ROLES.includes(b.role) ? b.role : "cashier";
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
    const role = ROLES.includes(b.role) ? b.role : null;
    if (!b.userId || !role) return json({ error: "userId + role required" }, 400);
    // Never strip the last owner.
    const { data: tgt } = await admin.from("profiles").select("role").eq("id", b.userId).maybeSingle();
    if (tgt?.role === "owner" && role !== "owner") {
      const { count } = await admin.from("profiles").select("id", { count: "exact", head: true }).eq("role", "owner");
      if ((count ?? 0) <= 1) return json({ error: "You can't change the last owner's role." }, 400);
    }
    const { error } = await admin.from("profiles").update({ role }).eq("id", b.userId);
    if (error) return json({ error: error.message }, 500);
    return json({ ok: true });
  }

  return json({ error: "Unknown action" }, 400);
};
