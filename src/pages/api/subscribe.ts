import type { APIRoute } from "astro";

// Runs as an on-demand serverless function (not prerendered).
export const prerender = false;

// Read config at request time (Vercel injects dashboard env vars into process.env;
// import.meta.env is the local-dev .env fallback).
const API_KEY = process.env.RESEND_API_KEY || import.meta.env.RESEND_API_KEY;
const AUDIENCE_ID = process.env.RESEND_AUDIENCE_ID || import.meta.env.RESEND_AUDIENCE_ID;
const TO = process.env.CONTACT_TO_EMAIL || import.meta.env.CONTACT_TO_EMAIL || "timelaggaming@gmail.com";
const FROM = process.env.CONTACT_FROM || import.meta.env.CONTACT_FROM || "TimeLag Video Games <onboarding@resend.dev>";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function safeRedirect(path: string): string {
  return path.startsWith("/") && !path.startsWith("//") ? path : "/";
}

export const POST: APIRoute = async ({ request, redirect }) => {
  const form = await request.formData();

  const wantsJson =
    request.headers.get("x-requested-with") === "fetch" ||
    (request.headers.get("accept") || "").includes("application/json");
  const backTo = safeRedirect(String(form.get("_redirect") || "/"));

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fail = (msg: string, status = 400): Response =>
    wantsJson ? json({ ok: false, error: msg }, status) : redirect(`${backTo}?error=1#updates`, 303);
  const ok = (): Response =>
    wantsJson ? json({ ok: true }, 200) : redirect(`${backTo}?club=1#updates`, 303);

  // Honeypot: bots fill hidden fields. Pretend success, do nothing.
  if (String(form.get("company") || "").trim() !== "") return ok();

  const first = String(form.get("first") || form.get("name") || "").trim();
  const last = String(form.get("last") || "").trim();
  const email = String(form.get("email") || "").trim();
  const phone = String(form.get("phone") || "").trim();

  if (!email || !EMAIL_RE.test(email)) {
    return fail("Please enter a valid email address.");
  }

  // Not configured at all: log the signup so it isn't lost, then report success.
  if (!API_KEY) {
    console.warn(
      "[subscribe] RESEND_API_KEY not set — logging signup instead:\n" +
        `${first} ${last} <${email}> ${phone || "—"}`,
    );
    return ok();
  }

  let captured = false;

  // 1) Add the subscriber to the Resend Audience (mailing list), if configured.
  //    Best-effort: a bad/missing audience ID or a send-only key shouldn't break
  //    the signup — we still capture it by email below.
  if (AUDIENCE_ID) {
    try {
      const res = await fetch(`https://api.resend.com/audiences/${AUDIENCE_ID}/contacts`, {
        method: "POST",
        headers: { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ email, first_name: first, last_name: last, unsubscribed: false }),
      });
      if (res.ok) {
        captured = true;
      } else {
        const detail = await res.text().catch(() => "");
        // An already-subscribed contact is fine — treat it as success.
        if (res.status === 409 || /already|exists/i.test(detail)) captured = true;
        else console.error("[subscribe] Resend audience error", res.status, detail);
      }
    } catch (err) {
      console.error("[subscribe] audience request failed", err);
    }
  }

  // 2) Email the shop a copy — captures the phone (not stored on the contact)
  //    and is the reliable record even when the audience add didn't work.
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: FROM,
        to: [TO],
        reply_to: email,
        subject: `📨 New TimeLag Club signup: ${`${first} ${last}`.trim() || email}`,
        text: `Name: ${first} ${last}\nEmail: ${email}\nPhone: ${phone || "—"}`,
      }),
    });
    if (res.ok) captured = true;
    else console.error("[subscribe] Resend email error", res.status, await res.text().catch(() => ""));
  } catch (err) {
    console.error("[subscribe] email request failed", err);
  }

  if (!captured) {
    return fail("We couldn't sign you up right now. Please email timelaggaming@gmail.com and we'll add you.", 502);
  }
  return ok();
};

// Friendly response if the endpoint is hit directly in a browser.
export const GET: APIRoute = () =>
  new Response("This endpoint only accepts POST submissions from the signup form.", {
    status: 405,
    headers: { "content-type": "text/plain", allow: "POST" },
  });
