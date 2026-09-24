// The POS inbox: one registry of event types, routed to ROLES.
//
// Every event the store should hear about (a customer registered a warranty,
// a sell-form lead came in…) becomes a row in public.notifications addressed
// to a set of role keys. WHICH roles is a setting (Settings → Inbox), stored
// in store_settings.settings.notifyRouting = { [type]: [roleKey, …] } and
// resolved at creation time. The owner sees everything regardless.
//
// Rows are inserted with the admin client (public forms have no session);
// reading goes through RLS (can_see_notification) so the inbox query is just
// "select * from notifications".
import type { StoreRole } from "./permissions";

export type NotificationType = "warranty_registered" | "warranty_review" | "lead_new" | "club_signup";

export interface NotificationTypeDef {
  key: NotificationType;
  label: string;
  description: string;
  icon: string;
}

export const NOTIFICATION_TYPES: NotificationTypeDef[] = [
  { key: "warranty_registered", icon: "🛡️", label: "Warranty registered", description: "A customer scanned their sticker and registered a warranty." },
  { key: "warranty_review", icon: "🔎", label: "Warranty needs review", description: "Someone self-registered from the website without a sticker — confirm the purchase and approve." },
  { key: "lead_new", icon: "📥", label: "New sell / trade lead", description: "The “Sell your games” form on the website was submitted." },
  { key: "club_signup", icon: "🎉", label: "Free Club signup", description: "Someone joined the newsletter / Free Club." },
];

// New form submissions go to managers unless the owner routes them elsewhere.
// (Owner is implicit — never listed, always sees everything.)
export const DEFAULT_AUDIENCE = ["manager", "developer"];

export type NotifyRouting = Record<NotificationType, string[]>;

/** Trust boundary for the settings jsonb: only known types, only real roles. */
export function sanitizeNotifyRouting(raw: any, roles: StoreRole[]): NotifyRouting {
  const valid = new Set(roles.map((r) => r.key).filter((k) => k !== "owner"));
  const out = {} as NotifyRouting;
  for (const t of NOTIFICATION_TYPES) {
    const v = raw?.[t.key];
    out[t.key] = Array.isArray(v)
      ? Array.from(new Set(v.map(String).filter((k) => valid.has(k))))
      : DEFAULT_AUDIENCE.filter((k) => valid.has(k));
  }
  return out;
}

/** Reader for store_settings.settings.notifyRouting (settings-helper idiom). */
export function notifyRouting(rawSettings: any, roles: StoreRole[]): NotifyRouting {
  return sanitizeNotifyRouting(rawSettings?.notifyRouting, roles);
}

export type NewNotification = {
  type: NotificationType;
  title: string;
  body?: string;
  /** Clean POS path to open, e.g. "/warranties?reg=<id>". */
  href?: string;
  payload?: Record<string, unknown>;
};

/**
 * Insert an inbox row addressed per the store's routing. Best-effort: a
 * missing table (migration not applied yet) or any error is logged and
 * swallowed — an inbox hiccup must never fail the customer-facing action.
 */
export async function createNotification(admin: { from: (t: string) => any }, n: NewNotification): Promise<void> {
  try {
    const [{ data: srow }, { data: roleRows }] = await Promise.all([
      admin.from("store_settings").select("settings").eq("id", 1).maybeSingle(),
      admin.from("store_roles").select("key, name, description, is_system, sort_order, permissions"),
    ]);
    const roles: StoreRole[] = (roleRows as StoreRole[] | null) ?? [];
    const routing = notifyRouting(srow?.settings, roles.length ? roles : ([{ key: "manager" }, { key: "developer" }] as StoreRole[]));
    const { error } = await admin.from("notifications").insert({
      type: n.type,
      title: n.title.slice(0, 200),
      body: (n.body ?? "").slice(0, 1000),
      href: (n.href ?? "").slice(0, 300),
      payload: n.payload ?? {},
      audience_roles: routing[n.type] ?? [],
    });
    if (error) console.error("[notifications] insert failed:", error.message);
  } catch (err) {
    console.error("[notifications] threw:", err);
  }
}
