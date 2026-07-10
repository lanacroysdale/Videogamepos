import { defineMiddleware } from "astro:middleware";
import { createSupabaseServerClient } from "./lib/supabase";
import type { Profile } from "./lib/types";
import { MARKETING_HOSTS, POS_HOST } from "./consts";

// The POS is served on its OWN host (pos.timelag.co — or any non-marketing host,
// e.g. a future licensee subdomain) at CLEAN root URLs. The pages physically live
// under /app, so on a POS host we transparently REWRITE clean paths -> /app/*
// (the address bar stays clean). On the marketing host the POS is NOT served —
// /app redirects out to the POS host. Auth + RBAC then run on the effective path.
export const onRequest = defineMiddleware(async (context, next) => {
  const url = context.url;
  const host = url.hostname;
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
  context.locals.profile = profile;

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

  // RBAC: reporting + pricing + settings + menu are for managers and owners only.
  const managerOnly =
    pathname.startsWith("/app/reports") || pathname.startsWith("/app/pricing") ||
    pathname.startsWith("/app/settings") || pathname.startsWith("/app/menu");
  if (managerOnly && profile && !["owner", "manager"].includes(profile.role)) {
    const denied = pathname.startsWith("/app/pricing") ? "pricing" : pathname.startsWith("/app/settings") ? "settings" : "reports";
    return context.redirect(`${homePath}?denied=${denied}`);
  }

  return go();
});
