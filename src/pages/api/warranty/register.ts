import type { APIRoute } from "astro";
import { createSupabaseAdminClient } from "../../../lib/supabase";
import { addMonths, findOrCreateCustomer, isIsoDate, isToken, makeToken, snapshotPlan, todayIso, type WarrantyPlan } from "../../../lib/warranty";
import { sendWarrantyProof } from "../../../lib/warrantyEmail";
import { createNotification } from "../../../lib/notifications";

// PUBLIC endpoint (no session) behind the customer-facing warranty pages.
// Two modes:
//   • token   — the customer scanned a sticker: /w/<token> posts here to
//               claim the pending registration. The token is the credential.
//   • public  — no sticker (flyer QR / website): a self-registration that
//               lands in 'review' for staff to confirm against a sale.
// Uses the service-role client; every write is scoped to one row.
export const prerender = false;
const json = (d: unknown, s = 200) =>
  new Response(JSON.stringify(d), { status: s, headers: { "content-type": "application/json" } });

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const clean = (v: unknown, max: number) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);

// Best-effort per-instance rate limit (serverless → per warm instance). It
// stops a runaway script from hammering the endpoint; the token space (~40
// bits) is what actually protects registrations.
const hits = new Map<string, { n: number; at: number }>();
function limited(ip: string): boolean {
  const now = Date.now();
  const h = hits.get(ip);
  if (!h || now - h.at > 60_000) { hits.set(ip, { n: 1, at: now }); return false; }
  h.n++;
  return h.n > 20;
}

export const POST: APIRoute = async ({ request, clientAddress }) => {
  const b = await request.json().catch(() => ({}));
  let ip = "";
  try { ip = clientAddress; } catch { ip = request.headers.get("x-forwarded-for") ?? ""; }
  if (limited(ip || "?")) return json({ ok: false, error: "Too many attempts — please wait a minute and try again." }, 429);

  // Honeypot: bots fill hidden fields. Pretend success, do nothing.
  if (clean(b.company, 10)) return json({ ok: true });

  const first = clean(b.first, 60);
  const last = clean(b.last, 60);
  const email = clean(b.email, 200).toLowerCase();
  const phone = clean(b.phone, 40);
  if (!first || !email) return json({ ok: false, error: "Please enter your name and email." }, 400);
  if (!EMAIL_RE.test(email)) return json({ ok: false, error: "That email address doesn't look right — please double-check it." }, 400);

  const admin = createSupabaseAdminClient();
  const { data: srow } = await admin.from("store_settings").select("store_name").eq("id", 1).maybeSingle();
  const storeName = (srow as any)?.store_name || "TimeLag";
  const subscribe = b.subscribe === true;

  // ---- Sticker flow ----
  if (b.mode !== "public") {
    const token = String(b.token ?? "").toLowerCase();
    if (!isToken(token)) return json({ ok: false, error: "This registration link isn't valid." }, 400);
    const { data: reg } = await admin.from("warranty_registrations").select("*").eq("token", token).maybeSingle();
    if (!reg) return json({ ok: false, error: "We couldn't find that warranty. Please contact the store." }, 404);
    if (reg.status === "void") return json({ ok: false, error: "This warranty has been cancelled. Please contact the store." }, 410);
    if (reg.status === "active") return json({ ok: true, already: true });
    // Registration window: counted from the sale date, per the frozen plan.
    const windowDays = Number(reg.plan_snapshot?.registration_window_days) || 0;
    if (windowDays > 0) {
      const deadline = Date.parse(reg.sale_date) + windowDays * 86_400_000;
      if (Date.now() > deadline + 86_400_000) return json({ ok: false, error: "The registration window for this purchase has closed. Please contact the store — we can still help." }, 410);
    }
    const customer_id = await findOrCreateCustomer(admin, { first, last, email, phone });
    if (subscribe && customer_id) await admin.from("customers").update({ email_subscribed: true }).eq("id", customer_id);
    const { data: updated, error } = await admin
      .from("warranty_registrations")
      .update({ status: "active", registered_at: new Date().toISOString(), customer_id, first_name: first, last_name: last, email, phone: phone || null })
      .eq("id", reg.id)
      .eq("status", reg.status) // no double-claim race
      .select("*")
      .single();
    if (error || !updated) return json({ ok: false, error: "We couldn't save your registration just now — please try again." }, 500);
    const emailed = await sendWarrantyProof(updated, storeName);
    await createNotification(admin, {
      type: "warranty_registered",
      title: `${first} ${last}`.trim() + ` registered ${updated.warranty_no}`,
      body: [updated.item_title, updated.item_condition].filter(Boolean).join(" · "),
      href: `/warranties?reg=${updated.id}`,
      payload: { registration_id: updated.id, customer_id },
    });
    return json({ ok: true, emailed, warranty_no: updated.warranty_no });
  }

  // ---- Self-registration (no sticker) ----
  const item_title = clean(b.item_title, 140);
  const sale_date = isIsoDate(b.sale_date) ? String(b.sale_date) : "";
  if (!item_title || !sale_date) return json({ ok: false, error: "Please tell us what you bought and when." }, 400);
  if (Date.parse(sale_date) > Date.now() + 86_400_000) return json({ ok: false, error: "The purchase date can't be in the future." }, 400);
  const planKey = clean(b.plan_key, 24);
  let planQ = admin.from("warranty_plans").select("*").eq("is_active", true);
  planQ = planKey ? planQ.eq("key", planKey) : planQ.eq("is_default", true);
  const { data: plan } = await planQ.limit(1).maybeSingle();
  if (!plan) return json({ ok: false, error: "Warranty registration isn't available right now — please contact the store." }, 400);
  const snap = snapshotPlan(plan as WarrantyPlan);
  const customer_id = await findOrCreateCustomer(admin, { first, last, email, phone });
  if (subscribe && customer_id) await admin.from("customers").update({ email_subscribed: true }).eq("id", customer_id);
  const { data: reg, error } = await admin
    .from("warranty_registrations")
    .insert({
      token: makeToken(),
      status: "review",
      source: "public",
      plan_id: plan.id,
      plan_snapshot: snap,
      item_title,
      item_platform: clean(b.item_platform, 60),
      item_condition: clean(b.item_condition, 60),
      serial: clean(b.serial, 80),
      sale_date,
      coverage_start: sale_date,
      coverage_end: addMonths(sale_date, snap.months),
      customer_id,
      first_name: first,
      last_name: last,
      email,
      phone: phone || null,
      payload: { receipt: clean(b.receipt, 120), where: clean(b.where, 120) },
      registered_at: new Date().toISOString(),
    })
    .select("*")
    .single();
  if (error || !reg) return json({ ok: false, error: "We couldn't save your registration just now — please try again." }, 500);
  await createNotification(admin, {
    type: "warranty_review",
    title: `${first} ${last}`.trim() + ` self-registered a warranty (${reg.warranty_no})`,
    body: `${item_title} · bought ${sale_date}${reg.payload?.receipt ? ` · receipt ${reg.payload.receipt}` : ""}`,
    href: `/warranties?reg=${reg.id}`,
    payload: { registration_id: reg.id, customer_id },
  });
  return json({ ok: true, review: true, warranty_no: reg.warranty_no, today: todayIso() });
};

export const GET: APIRoute = () =>
  new Response("This endpoint only accepts POST submissions from the warranty form.", { status: 405, headers: { "content-type": "text/plain", allow: "POST" } });
