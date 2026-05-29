/// <reference path="../.astro/types.d.ts" />
import type { SupabaseClient, User } from "@supabase/supabase-js";
import type { Profile } from "./lib/types";

declare global {
  namespace App {
    interface Locals {
      supabase: SupabaseClient;
      user: User | null;
      profile: Profile | null;
    }
  }

  interface ImportMetaEnv {
    readonly PUBLIC_SUPABASE_URL: string;
    readonly PUBLIC_SUPABASE_ANON_KEY: string;
    readonly SUPABASE_SERVICE_ROLE_KEY?: string;
    readonly RESEND_API_KEY?: string;
    readonly CONTACT_TO_EMAIL?: string;
    readonly CONTACT_FROM?: string;
  }
}

export {};
