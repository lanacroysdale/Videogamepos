import type { APIRoute } from "astro";
import { createSupabaseAdminClient } from "../../../lib/supabase";

export const prerender = false;
const json = (d: unknown, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { "content-type": "application/json" } });

// Passwordless "tap your card" login: a card code maps to an employee. We use
// the service role to mint a one-time token, then verify it on the cookie-bound
// client to establish the session (sets auth cookies on the response).
export const POST: APIRoute = async ({ request, locals }) => {
  const body = await request.json().catch(() => null);
  const code = String(body?.card_code ?? "").trim();
  if (!code) return json({ error: "Card code required" }, 400);

  const admin = createSupabaseAdminClient();
  const { data: profile } = await admin.from("profiles").select("id").eq("card_code", code).maybeSingle();
  if (!profile) return json({ error: "Card not recognized" }, 404);

  const { data: userRes, error: uErr } = await admin.auth.admin.getUserById(profile.id);
  const email = userRes?.user?.email;
  if (uErr || !email) return json({ error: "No login is linked to this card" }, 404);

  const { data: link, error: linkErr } = await admin.auth.admin.generateLink({ type: "magiclink", email });
  const otp = link?.properties?.email_otp;
  if (linkErr || !otp) return json({ error: "Could not start a session" }, 500);

  const { error: vErr } = await locals.supabase.auth.verifyOtp({ email, token: otp, type: "email" });
  if (vErr) return json({ error: vErr.message }, 401);

  return json({ ok: true });
};
