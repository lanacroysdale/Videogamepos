import type { APIRoute } from "astro";

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

  const rows: Array<[string, string]> = [
    ["Name", name],
    ["Email", email],
    ["Phone", phone || "—"],
    ["Condition", condition || "—"],
    ["Items for sale", items],
    ["Photo link", photos || "—"],
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
