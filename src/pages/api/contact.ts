import type { APIRoute } from "astro";
import { createSupabaseAdminClient } from "../../lib/supabase";

// Run as an on-demand Vercel serverless function (not prerendered).
export const prerender = false;

// Read config at request time. Vercel injects dashboard env vars into
// process.env; import.meta.env is the local-dev (.env) fallback.
const TO = process.env.CONTACT_TO_EMAIL || import.meta.env.CONTACT_TO_EMAIL || "timelaggaming@gmail.com";
const FROM = process.env.CONTACT_FROM || import.meta.env.CONTACT_FROM || "TimeLag Video Games <onboarding@resend.dev>";
const API_KEY = process.env.RESEND_API_KEY || import.meta.env.RESEND_API_KEY;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Only allow same-origin redirects so the _redirect field can't be abused.
function safeRedirect(path: string): string {
  return path.startsWith("/") && !path.startsWith("//") ? path : "/";
}

export const POST: APIRoute = async ({ request, redirect }) => {
  const form = await request.formData();

  const wantsJson =
    request.headers.get("x-requested-with") === "fetch" ||
    (request.headers.get("accept") || "").includes("application/json");
  const backTo = safeRedirect(String(form.get("_redirect") || "/"));

  const fail = (msg: string, status = 400): Response =>
    wantsJson
      ? new Response(JSON.stringify({ ok: false, error: msg }), {
          status,
          headers: { "content-type": "application/json" },
        })
      : redirect(`${backTo}?error=1#contact`, 303);

  const ok = (): Response =>
    wantsJson
      ? new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      : redirect(`${backTo}?sent=1#contact`, 303);

  // Honeypot: bots fill hidden fields. Pretend success, send nothing.
  if (String(form.get("company") || "").trim() !== "") {
    return ok();
  }

  const name = String(form.get("name") || "").trim();
  const email = String(form.get("email") || "").trim();
  const phone = String(form.get("phone") || "").trim();
  const condition = String(form.get("condition") || "").trim();
  const items = String(form.get("items") || "").trim();
  const photos = String(form.get("photos") || "").trim();

  if (!name || !email || !items) {
    return fail("Please fill in your name, email, and what you're selling.");
  }
  if (!EMAIL_RE.test(email)) {
    return fail("That email address doesn't look right — please double-check it.");
  }

  // Collect uploaded files (the cash-offer form's spreadsheet / image buttons)
  // and attach them to the email. Capped to stay under the serverless body
  // limit; oversized batches are flagged so the shop can request them by email.
  const MAX_ATTACH_BYTES = 4 * 1024 * 1024;
  const uploads: File[] = [];
  const sheet = form.get("spreadsheet");
  if (sheet instanceof File && sheet.size > 0) uploads.push(sheet);
  for (const img of form.getAll("images")) {
    if (img instanceof File && img.size > 0) uploads.push(img);
  }
  const attachments: { filename: string; content: string }[] = [];
  const totalBytes = uploads.reduce((n, f) => n + f.size, 0);
  let attachLine = "—";
  if (uploads.length && totalBytes <= MAX_ATTACH_BYTES) {
    for (const f of uploads) {
      const buf = Buffer.from(await f.arrayBuffer());
      attachments.push({ filename: f.name || "upload", content: buf.toString("base64") });
    }
    attachLine = uploads.map((f) => f.name).join(", ");
  } else if (uploads.length) {
    attachLine = `${uploads.length} file(s) too large to attach (${(totalBytes / 1048576).toFixed(1)}MB) — ask the customer to email them`;
  }

  // Capture the lead into the POS database — the primary record, shown in the
  // staff-only Leads inbox. Best-effort: a DB hiccup shouldn't lose the lead,
  // so we still email below. Uses the service-role client (server-only).
  const first = String(form.get("first") || "").trim();
  const last = String(form.get("last") || "").trim();
  const [splitFirst, ...splitRest] = name.split(/\s+/);
  try {
    const admin = createSupabaseAdminClient();
    const { error: leadErr } = await admin.from("leads").insert({
      type: "sell_request",
      first_name: first || splitFirst || name,
      last_name: last || splitRest.join(" "),
      email,
      phone: phone || null,
      condition: condition || null,
      items,
      photos: photos || null,
      source: "sell_form",
      payload: { attachments: attachLine },
    });
    if (leadErr) console.error("[contact] lead insert failed:", leadErr.message);
  } catch (err) {
    console.error("[contact] lead insert threw:", err);
  }

  const rows: Array<[string, string]> = [
    ["Name", name],
    ["Email", email],
    ["Phone", phone || "—"],
    ["Condition", condition || "—"],
    ["Items for sale", items],
    ["Photo link", photos || "—"],
    ["Attachments", attachLine],
  ];

  const textBody = rows.map(([k, v]) => `${k}: ${v}`).join("\n");
  const htmlBody = `
    <h2 style="font-family:Arial,sans-serif;margin:0 0 12px">New sell/trade request</h2>
    <table style="font-family:Arial,sans-serif;border-collapse:collapse;font-size:14px">
      ${rows
        .map(
          ([k, v]) =>
            `<tr><td style="padding:6px 14px 6px 0;vertical-align:top;color:#666"><strong>${escapeHtml(
              k,
            )}</strong></td><td style="padding:6px 0;white-space:pre-wrap">${escapeHtml(v)}</td></tr>`,
        )
        .join("")}
    </table>`;

  // No email provider configured yet: log the lead so it isn't lost, then
  // report success. Set RESEND_API_KEY (see .env.example) to enable delivery.
  if (!API_KEY) {
    console.warn(
      "[contact] RESEND_API_KEY not set — logging submission instead of emailing:\n" + textBody,
    );
    return ok();
  }

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: FROM,
        to: [TO],
        reply_to: email,
        subject: `🎮 New sell/trade request from ${name}`,
        text: textBody,
        html: htmlBody,
        ...(attachments.length ? { attachments } : {}),
      }),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      console.error("[contact] Resend error", res.status, detail);
      return fail("We couldn't send your message right now. Please try again later.", 502);
    }
  } catch (err) {
    console.error("[contact] Unexpected error", err);
    return fail("Something went wrong on our end. Please try again.", 500);
  }

  return ok();
};

// Friendly response if the endpoint is hit directly (e.g. in a browser).
export const GET: APIRoute = () =>
  new Response("This endpoint only accepts POST submissions from the contact form.", {
    status: 405,
    headers: { "content-type": "text/plain", allow: "POST" },
  });
