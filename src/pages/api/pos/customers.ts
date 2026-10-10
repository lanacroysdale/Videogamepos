import type { APIRoute } from "astro";

export const prerender = false;

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

export const GET: APIRoute = async ({ locals, url }) => {
  if (!locals.user) return json({ error: "unauthorized" }, 401);

  // Strip characters that have meaning in PostgREST's or() filter syntax.
  const q = (url.searchParams.get("q") ?? "").replace(/[,()*%\\]/g, " ").trim();
  if (q.length < 1) return json({ results: [] });

  // Every word must match some field ("jane doe" = first AND last name). A
  // phone typed as bare digits also finds "(503) 555-1234".
  let query = locals.supabase
    .from("customers")
    .select("id, first_name, last_name, email, phone, store_credit_cents, points, membership")
    .is("merged_into", null);
  for (const w of q.split(/\s+/).filter(Boolean).slice(0, 5)) {
    const like = `%${w}%`;
    const digits = w.replace(/\D/g, "");
    const phone = digits.length >= 4 && /^[\d().+-]+$/.test(w) ? `%${digits.split("").join("%")}%` : like;
    query = query.or(`first_name.ilike.${like},last_name.ilike.${like},email.ilike.${like},phone.ilike.${phone}`);
  }
  const { data, error } = await query.order("last_name", { ascending: true }).limit(8);

  if (error) return json({ error: error.message }, 500);
  return json({ results: data ?? [] });
};
