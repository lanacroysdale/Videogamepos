import type { APIRoute } from "astro";

export const prerender = false;
const json = (d: unknown, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { "content-type": "application/json" } });

// Merge customer `src` into `dst` (reassign history, sum credit/points).
// The SQL function also enforces manager-only.
export const POST: APIRoute = async ({ locals, request }) => {
  if (!locals.user) return json({ error: "unauthorized" }, 401);
  if (!locals.profile || !["owner", "manager"].includes(locals.profile.role)) return json({ error: "Managers only" }, 403);
  const b = await request.json().catch(() => ({}));
  if (!b.src || !b.dst) return json({ error: "Pick two customers to merge" }, 400);
  if (b.src === b.dst) return json({ error: "Pick two different customers" }, 400);

  const { error } = await locals.supabase.rpc("merge_customers", { p_src: b.src, p_dst: b.dst });
  if (error) return json({ error: error.message }, 500);
  return json({ ok: true });
};
