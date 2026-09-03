// Roles-as-data + the permission registry.
//
// A ROLE is a row in public.store_roles: a display name plus the list of
// permission KEYS it grants. The keys themselves are defined HERE (the app is
// the only thing that knows what each one gates), and the owner assigns them to
// roles from Settings → Roles & permissions. `owner` always has everything.
//
// Every gate in the app goes through `can(profile, roles, key)` — reached in
// pages/APIs as `Astro.locals.can(key)` / `locals.can(key)` (set in middleware).
// RLS uses the SQL twin, public.has_permission(key).

export type PermissionKey =
  | "reports.view" | "pricing.manage" | "settings.manage" | "menu.manage"
  | "inventory.manage" | "inventory_config.manage"
  | "returns.override" | "tabs.close_all" | "customers.merge"
  | "shifts.manage" | "tasks.manage" | "sops.manage" | "sops.approve"
  | "data.elevated" | "departments.manage" | "team.manage" | "team.remove" | "roles.manage" | "maintenance.manage";

export interface PermissionDef {
  key: PermissionKey;
  label: string;
  description: string;
  group: "Pages" | "Inventory" | "Sales" | "Staff" | "Administration";
  /** Extra-careful: shown with a warning in the matrix. */
  sensitive?: boolean;
}

export const PERMISSIONS: PermissionDef[] = [
  // ---- Pages ----
  { key: "reports.view", group: "Pages", label: "Reports", description: "Open the Reports page (revenue, margin, trends, volume)." },
  { key: "pricing.manage", group: "Pages", label: "Pricing tools", description: "Open Pricing and record price changes." },
  { key: "settings.manage", group: "Pages", label: "Settings", description: "Open Settings and change store settings (appearance, labels, low-stock, AI, notifications)." },
  { key: "menu.manage", group: "Pages", label: "Menu builder", description: "Edit the food & beverage menu: sections, items, sizes, modifiers, photos." },
  // ---- Inventory ----
  { key: "inventory.manage", group: "Inventory", label: "Inventory admin", description: "Revert committed entries, supplier links, cost history, eBay import & stock sync, image resync." },
  { key: "inventory_config.manage", group: "Inventory", label: "Inventory types & locations", description: "Add or edit inventory pools and storage locations." },
  // ---- Sales ----
  { key: "returns.override", group: "Sales", label: "Approve late returns", description: "Process a return after the return window has passed." },
  { key: "tabs.close_all", group: "Sales", label: "Close all bar tabs", description: "End-of-night close-out of every open tab." },
  { key: "customers.merge", group: "Sales", label: "Merge customers", description: "Merge duplicate customer records." },
  // ---- Staff ----
  { key: "shifts.manage", group: "Staff", label: "Schedule", description: "Add and remove scheduled shifts." },
  { key: "tasks.manage", group: "Staff", label: "Daily checklist", description: "Edit the daily checklist templates and receive task-completion notifications." },
  { key: "sops.manage", group: "Staff", label: "Write SOPs", description: "Create, edit, delete SOPs and attach files. See unapproved drafts." },
  { key: "sops.approve", group: "Staff", label: "Approve SOPs", description: "Publish SOP drafts. Anyone with this permission also publishes their own edits without review." },
  // ---- Administration ----
  { key: "data.elevated", group: "Administration", label: "Elevated data access", description: "Database-level manager access: see every employee's transactions and time entries, and write settings, menu, SOPs, shifts and price changes directly. Most manager-level permissions above need this to fully work.", sensitive: true },
  { key: "departments.manage", group: "Administration", label: "Departments", description: "Edit the business departments (the POS spine) and their lock.", sensitive: true },
  { key: "team.manage", group: "Administration", label: "Manage team", description: "Invite employees and change anyone's role.", sensitive: true },
  { key: "team.remove", group: "Administration", label: "Remove employees", description: "Remove an employee: their login is disabled and they disappear from the team. Owner-only unless granted here.", sensitive: true },
  { key: "roles.manage", group: "Administration", label: "Roles & permissions", description: "Edit this matrix: rename roles, add custom roles, grant or revoke permissions.", sensitive: true },
  { key: "maintenance.manage", group: "Administration", label: "Danger zone", description: "Full database backup export and the inventory reset. Destructive — owner-only unless granted here.", sensitive: true },
];

export const PERMISSION_KEYS = PERMISSIONS.map((p) => p.key) as PermissionKey[];
export const PERMISSION_GROUPS = ["Pages", "Inventory", "Sales", "Staff", "Administration"] as const;

export interface StoreRole {
  key: string;
  name: string;
  description: string;
  is_system: boolean;
  sort_order: number;
  permissions: string[];
}

/** Built-in roles + their DEFAULT permissions (also seeded by the migration). */
export const SYSTEM_ROLE_KEYS = ["owner", "developer", "manager", "cashier"] as const;
const MANAGER_DEFAULTS: PermissionKey[] = [
  "reports.view", "pricing.manage", "settings.manage", "menu.manage", "inventory.manage", "inventory_config.manage",
  "returns.override", "tabs.close_all", "customers.merge", "shifts.manage", "tasks.manage", "sops.manage", "data.elevated",
];
export const DEFAULT_ROLES: StoreRole[] = [
  { key: "owner", name: "Owner", description: "Full access to everything, including the team and this permission matrix.", is_system: true, sort_order: 0, permissions: [] },
  { key: "developer", name: "Developer", description: "Builds and maintains the POS. Everything the owner can do except removing employees and the danger zone (grant them below if needed).", is_system: true, sort_order: 1,
    permissions: PERMISSION_KEYS.filter((k) => k !== "team.remove" && k !== "maintenance.manage") },
  { key: "manager", name: "Manager", description: "Runs the floor: reports, pricing, settings, menu, schedule, SOPs.", is_system: true, sort_order: 2, permissions: MANAGER_DEFAULTS },
  { key: "cashier", name: "Cashier", description: "Checkout, trade-ins, inventory entry, returns inside the window.", is_system: true, sort_order: 3, permissions: [] },
];

export const OWNER_ROLE = "owner";

/** Does this profile hold the permission under the given role table? Owner always does. */
export function can(
  profile: { role: string; removed_at?: string | null } | null | undefined,
  roles: StoreRole[],
  key: PermissionKey,
): boolean {
  if (!profile || profile.removed_at) return false;
  if (profile.role === OWNER_ROLE) return true;
  const role = roles.find((r) => r.key === profile.role);
  return !!role && role.permissions.includes(key);
}

export const sanitizePermissions = (raw: unknown): PermissionKey[] =>
  Array.isArray(raw) ? (PERMISSION_KEYS.filter((k) => raw.includes(k)) as PermissionKey[]) : [];

export const roleName = (roles: StoreRole[], key: string) => roles.find((r) => r.key === key)?.name ?? key;

// ---- Loading (server) --------------------------------------------------------
// Roles change rarely; one row-set is cached per server instance for a few
// seconds so middleware doesn't add a query to every request. The roles API
// calls invalidateRolesCache() after every write.
let cache: { at: number; roles: StoreRole[]; fromDb: boolean } | null = null;
const TTL_MS = 10_000;

export function invalidateRolesCache() { cache = null; }

/**
 * Load roles via any Supabase client (admin preferred — it's shared across
 * users). Falls back to DEFAULT_ROLES when the table doesn't exist yet (the
 * migration hasn't been applied) so the app keeps working with built-in roles.
 */
export async function loadRoles(sb: { from: (t: string) => any }): Promise<{ roles: StoreRole[]; fromDb: boolean }> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache;
  const { data, error } = await sb.from("store_roles").select("key, name, description, is_system, sort_order, permissions").order("sort_order").order("name");
  let out: { roles: StoreRole[]; fromDb: boolean };
  if (error || !data || data.length === 0) {
    out = { roles: DEFAULT_ROLES, fromDb: false };
  } else {
    out = {
      roles: (data as any[]).map((r) => ({ ...r, description: r.description ?? "", permissions: sanitizePermissions(r.permissions) })),
      fromDb: true,
    };
  }
  cache = { at: Date.now(), ...out };
  return out;
}
