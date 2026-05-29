import { defineMiddleware } from "astro:middleware";
import { createSupabaseServerClient } from "./lib/supabase";
import type { Profile } from "./lib/types";

// Only the POS app (and its API) needs auth; marketing pages stay public/static.
export const onRequest = defineMiddleware(async (context, next) => {
  const { pathname } = context.url;
  const isApp = pathname.startsWith("/app");
  const isPosApi = pathname.startsWith("/api/pos");
  if (!isApp && !isPosApi) return next();

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
  if (isPosApi) return next();

  const isLogin = pathname === "/app/login";
  if (!user) {
    return isLogin ? next() : context.redirect("/app/login");
  }
  if (isLogin) return context.redirect("/app");

  // RBAC: reporting + pricing are for managers and owners only.
  const managerOnly = pathname.startsWith("/app/reports") || pathname.startsWith("/app/pricing");
  if (managerOnly && profile && !["owner", "manager"].includes(profile.role)) {
    return context.redirect(`/app?denied=${pathname.startsWith("/app/pricing") ? "pricing" : "reports"}`);
  }

  return next();
});
