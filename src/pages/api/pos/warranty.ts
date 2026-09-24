import type { APIRoute } from "astro";
import { createSupabaseAdminClient } from "../../../lib/supabase";
import { addMonths, isIsoDate, makeToken, sanitizePlanInput, snapshotPlan, todayIso, type WarrantyPlan } from "../../../lib/warranty";
import { sendWarrantyProof } from "../../../lib/warrantyEmail";

export const prerender = false;
const json = (d: unknown, s = 200) =>
  new Response(JSON.stringify(d), { status: s, headers: { "content-type": "application/json" } });

const REG_COLS = "id, human_id, warranty_no, token, status, source, plan_id, plan_snapshot, item_title, item_platform, item_condition, serial, variant_id, transaction_id, sale_date, coverage_start, coverage_end, customer_id, first_name, last_name, email, phone, notes, created_by, created_at, registered_at, voided_at, void_reason";

// GET ?q=  — find registrations for the counter page (warranty #, token,
// customer name/email, item). Empty q → the 40 most recent.
export const GET: APIRoute = async ({ locals, url }) => {
  if (!locals.user) return json({ error: "unauthorized" }, 401);
  const q = (url.searchParams.get("q") ?? "").replace(/[,()*%\\]/g, " ").trim();
  let query = locals.supabase.from("warranty_registrations").select(REG_COLS).order("created_at", { ascending: false }).limit(40);
  if (q) {
    const like = `%${q}%`;
    query = query.or(`warranty_no.ilike.${like},token.eq.${q.toLowerCase()},first_name.ilike.${like},last_name.ilike.${like},email.ilike.${like},item_title.ilike.${like},serial.ilike.${like}`);
  }
  const { data, error } = await query;
  if (error) return json({ error: error.message }, 500);
  return json({ ok: true, results: data ?? [] });
};

export const POST: APIRoute = async ({ locals, request }) => {
  if (!locals.user) return json({ error: "unauthorized" }, 401);
  const b = await request.json().catch(() => ({}));
  const sb = locals.supabase;
  const canManage = locals.can("warranty.manage");

  // ---- create: the counter's "Generate sticker" — a pending registration
  // whose token the QR carries. Any employee.
  if (b.action === "create") {
    const item_title = String(b.item_title ?? "").trim().slice(0, 140);
    if (!item_title) return json({ error: "What's the item?" }, 400);
    const sale_date = isIsoDate(b.sale_date) ? String(b.sale_date) : todayIso();
    const { data: plan, error: pe } = await sb.from("warranty_plans").select("*").eq("id", String(b.plan_id ?? "")).maybeSingle();
    if (pe || !plan) return json({ error: "Pick a warranty plan." }, 400);
    if (!plan.is_active) return json({ error: "That plan is inactive." }, 400);
    const snap = snapshotPlan(plan as WarrantyPlan);
    const row = {
      token: makeToken(),
      status: "pending",
      source: "label",
      plan_id: plan.id,
      plan_snapshot: snap,
      item_title,
      item_platform: String(b.item_platform ?? "").trim().slice(0, 60),
      item_condition: String(b.item_condition ?? "").trim().slice(0, 60),
      serial: String(b.serial ?? "").trim().slice(0, 80),
      variant_id: typeof b.variant_id === "string" && b.variant_id ? b.variant_id : null,
      transaction_id: typeof b.transaction_id === "string" && b.transaction_id ? b.transaction_id : null,
      sale_date,
      coverage_start: sale_date,
      coverage_end: addMonths(sale_date, snap.months),
      customer_id: typeof b.customer_id === "string" && b.customer_id ? b.customer_id : null,
      notes: String(b.notes ?? "").trim().slice(0, 1000),
      created_by: locals.user.id,
    };
    // Prefill the customer's name if the sale was rung to a known customer —
    // the registration page shows it, the customer confirms/edits.
    if (row.customer_id) {
      const { data: c } = await sb.from("customers").select("first_name, last_name").eq("id", row.customer_id).maybeSingle();
      if (c) Object.assign(row, { first_name: c.first_name ?? "", last_name: c.last_name ?? "" });
    }
    const { data: reg, error } = await sb.from("warranty_registrations").insert(row).select(REG_COLS).single();
    if (error) return json({ error: error.message }, 500);
    return json({ ok: true, registration: reg });
  }

  // ---- void / approve / resend / note — work an existing registration.
  if (["void", "unvoid", "approve", "resend", "note"].includes(b.action)) {
    const { data: reg, error: re } = await sb.from("warranty_registrations").select(REG_COLS).eq("id", String(b.id ?? "")).maybeSingle();
    if (re || !reg) return json({ error: "Registration not found" }, 404);
    const { data: srow } = await sb.from("store_settings").select("store_name").eq("id", 1).maybeSingle();
    const storeName = (srow as any)?.store_name || "TimeLag";

    if (b.action === "note") {
      const { error } = await sb.from("warranty_registrations").update({ notes: String(b.notes ?? "").trim().slice(0, 1000) }).eq("id", reg.id);
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true });
    }
    if (b.action === "void") {
      if (!canManage) return json({ error: "You don't have permission to void warranties" }, 403);
      const { error } = await sb.from("warranty_registrations")
        .update({ status: "void", voided_at: new Date().toISOString(), void_reason: String(b.reason ?? "").trim().slice(0, 300) || null })
        .eq("id", reg.id);
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true });
    }
    if (b.action === "unvoid") {
      if (!canManage) return json({ error: "You don't have permission to restore warranties" }, 403);
      const back = reg.registered_at ? "active" : "pending";
      const { error } = await sb.from("warranty_registrations").update({ status: back, voided_at: null, void_reason: null }).eq("id", reg.id);
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true, status: back });
    }
    if (b.action === "approve") {
      if (!canManage) return json({ error: "You don't have permission to approve warranties" }, 403);
      if (reg.status !== "review") return json({ error: "Only self-registrations awaiting review can be approved" }, 400);
      const { error } = await sb.from("warranty_registrations").update({ status: "active" }).eq("id", reg.id);
      if (error) return json({ error: error.message }, 500);
      const emailed = await sendWarrantyProof({ ...reg, status: "active" } as any, storeName);
      return json({ ok: true, emailed });
    }
    if (b.action === "resend") {
      if (reg.status !== "active") return json({ error: "Only active warranties have a proof to send" }, 400);
      if (!reg.email) return json({ error: "No email on this registration" }, 400);
      const emailed = await sendWarrantyProof(reg as any, storeName);
      return json({ ok: emailed, error: emailed ? undefined : "Email delivery isn't configured (RESEND_API_KEY)" }, emailed ? 200 : 500);
    }
  }

  // ---- plans (Settings → Warranty). Needs warranty.manage; writes go
  // through the admin client after the check (RLS also enforces it).
  if (b.action === "savePlan" || b.action === "deletePlan") {
    if (!canManage) return json({ error: "You don't have permission to edit warranty plans" }, 403);
    const admin = createSupabaseAdminClient();
    if (b.action === "deletePlan") {
      const { count } = await admin.from("warranty_registrations").select("id", { count: "exact", head: true }).eq("plan_id", String(b.id ?? ""));
      if ((count ?? 0) > 0) return json({ error: `This plan has ${count} registration(s) — mark it inactive instead of deleting.` }, 400);
      const { error } = await admin.from("warranty_plans").delete().eq("id", String(b.id ?? ""));
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true });
    }
    const input = sanitizePlanInput(b.plan);
    if ("error" in input) return json({ error: input.error }, 400);
    const id = typeof b.id === "string" && b.id ? b.id : null;
    // Exactly one default: setting this one clears the others.
    if (input.is_default) await admin.from("warranty_plans").update({ is_default: false }).neq("id", id ?? "00000000-0000-0000-0000-000000000000");
    const patch = { ...input, updated_at: new Date().toISOString() };
    const q = id
      ? admin.from("warranty_plans").update(patch).eq("id", id).select("*").single()
      : admin.from("warranty_plans").insert(patch).select("*").single();
    const { data, error } = await q;
    if (error) return json({ error: error.message.includes("warranty_plans_key_key") ? "That short key is already used by another plan." : error.message }, 500);
    // Never leave the store with no default plan.
    const { data: anyDefault } = await admin.from("warranty_plans").select("id").eq("is_default", true).limit(1);
    if (!anyDefault?.length) await admin.from("warranty_plans").update({ is_default: true }).eq("id", data.id);
    return json({ ok: true, plan: data });
  }

  return json({ error: "unknown action" }, 400);
};
