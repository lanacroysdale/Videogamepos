/// <reference path="../.astro/types.d.ts" />
import type { SupabaseClient, User } from "@supabase/supabase-js";
import type { Profile } from "./lib/types";
import type { PermissionKey, StoreRole } from "./lib/permissions";

declare global {
  namespace App {
    interface Locals {
      supabase: SupabaseClient;
      user: User | null;
      profile: Profile | null;
      /** All roles (from store_roles, or the built-in defaults pre-migration). */
      roles: StoreRole[];
      /** Permission check for the signed-in employee. Owner always passes. */
      can: (key: PermissionKey) => boolean;
    }
  }

  interface ImportMetaEnv {
    readonly PUBLIC_SUPABASE_URL: string;
    readonly PUBLIC_SUPABASE_ANON_KEY: string;
    readonly SUPABASE_SERVICE_ROLE_KEY?: string;
    readonly PRICECHARTING_API_TOKEN?: string;
    readonly RESEND_API_KEY?: string;
    readonly CONTACT_TO_EMAIL?: string;
    readonly CONTACT_FROM?: string;
  }
}

export {};
