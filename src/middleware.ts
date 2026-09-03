import { defineMiddleware } from "astro:middleware";
import { createSupabaseServerClient, createSupabaseAdminClient } from "./lib/supabase";
import type { Profile } from "./lib/types";
import { can, loadRoles, type PermissionKey } from "./lib/permissions";
import { MARKETING_HOSTS, POS_HOST } from "./consts";

// The POS is served on its OWN host (pos.timelag.co — or any non-marketing host,
// e.g. a future licensee subdomain) at CLEAN root URLs. The pages physically live
// under /app, so on a POS host we transparently REWRITE clean paths -> /app/*
// (the address bar stays clean). On the marketing host the POS is NOT served —
// /app redirects out to the POS host. Auth + RBAC then run on the effective path.
export const onRequest = defineMiddleware(async (context, next) => {
  const url = context.url;
  // Behind Vercel's proxy, url.hostname can be the internal *.vercel.app
  // deployment host — the visitor's real domain arrives in x-forwarded-host.
  // Without this, www.timelag.co fails the marketing check and serves the POS.
  const host = (context.request.headers.get("x-forwarded-host") ?? url.hostname).split(":")[0].toLowerCase();
  const isMarketing = MARKETING_HOSTS.includes(host);
  const search = url.search;
  let pathname = url.pathname;

  // ---- Marketing host: keep the POS off it (send /app -> the POS host). ----
  if (isMarketing && (pathname === "/app" || pathname.startsWith("/app/"))) {
    const clean = pathname.replace(/^\/app/, "") || "/";
    return context.redirect(`https://${POS_HOST}${clean === "/" ? "/dashboard" : clean}${search}`, 308);
  }

  // ---- POS host: map clean page URLs onto the underlying /app/* routes. ----
  // Leave API, storefront and static assets untouched. The rewrite target starts
  // with /app, which is excluded here, so a re-entrant pass never loops.
  let rewritten = false;
  if (!isMarketing) {
    const isAsset = pathname.startsWith("/_") || pathname.includes(".");
    const isApiOrShop = pathname.startsWith("/api") || pathname === "/shop" || pathname.startsWith("/shop/");
    if (!pathname.startsWith("/app") && !isApiOrShop && !isAsset) {
      pathname = pathname === "/" || pathname === "/dashboard" ? "/app" : "/app" + pathname;
      rewritten = true;
    }
  }
  const go = () => (rewritten ? next(pathname + search) : next());

  // Only the POS app + API + storefront need a session; marketing stays public.
  const isApp = pathname.startsWith("/app");
  const isPosApi = pathname.startsWith("/api/pos");
  const isShop = pathname === "/shop" || pathname.startsWith("/shop/");
  if (!isApp && !isPosApi && !isShop) return go();

  const supabase = createSupabaseServerClient(context);
  context.locals.supabase = supabase;

  const {
    data: { user },
  } = await supabase.auth.getUser();
  context.locals.user = user ?? null;

  let profile: Profile | null = null;
  if (user) {
    const { data } = await supabase.from("profiles").select("*").eq("id", user.id).maybeSingle();
    profile = (data as Profile) ?? null;
  }
  // A REMOVED employee is signed out on their next request: no profile, no
  // session. (The API also bans their auth user; this covers a live cookie.)
  if (profile?.removed_at) {
    await supabase.auth.signOut();
    profile = null;
    context.locals.user = null;
    if (isApp) return context.redirect(isMarketing ? "/app/login" : "/login");
  }
  context.locals.profile = profile;

  // Permissions: roles are data (store_roles); one cached load per instance.
  const { roles } = await loadRoles(createSupabaseAdminClient());
  context.locals.roles = roles;
  context.locals.can = (key: PermissionKey) => can(profile, roles, key);

  // API routes enforce their own auth (return 401); let them through.
  if (isPosApi) return go();

  // Clean login/dashboard URLs on a POS host; /app-prefixed on the marketing host.
  const loginPath = isMarketing ? "/app/login" : "/login";
  const homePath = isMarketing ? "/app" : "/dashboard";
  const isLogin = pathname === "/app/login";
  if (!user) {
    return isLogin ? go() : context.redirect(loginPath);
  }
  if (isLogin) return context.redirect(homePath);

  // RBAC: page-level gates come from the permission matrix (Settings → Roles).
  const PAGE_GATES: [prefix: string, key: PermissionKey, denied: string][] = [
    ["/app/reports", "reports.view", "reports"],
    ["/app/pricing", "pricing.manage", "pricing"],
    ["/app/settings", "settings.manage", "settings"],
    ["/app/menu", "menu.manage", "menu"],
  ];
  const gate = PAGE_GATES.find(([prefix]) => pathname.startsWith(prefix));
  if (gate && !context.locals.can(gate[1])) {
    return context.redirect(`${homePath}?denied=${gate[2]}`);
  }

  return go();
});
