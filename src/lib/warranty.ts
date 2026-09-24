// Warranty plans + registrations: the shared vocabulary for the counter page
// (/app/warranties), the public registration page (/w/<token>), Settings, the
// sticker renderer and the proof-of-warranty email.
//
// A PLAN is the store's warranty product as data (rows in warranty_plans). A
// REGISTRATION is one warranted item; at creation the plan's terms are frozen
// into plan_snapshot so editing the plan later never rewrites a customer's
// existing warranty. Coverage runs from the SALE date, not registration.
import { SITE } from "../consts";
import type { LabelItem } from "./labels";

export type WarrantyPlan = {
  id: string;
  key: string;
  name: string;
  months: number;
  summary: string;
  coverage: string;      // one bullet per line
  exclusions: string;    // one bullet per line
  terms: string;
  registration_window_days: number;
  is_active: boolean;
  is_default: boolean;
  sort_order: number;
};

/** Frozen copy of a plan stored on each registration. */
export type PlanSnapshot = {
  key: string;
  name: string;
  months: number;
  summary: string;
  coverage: string[];
  exclusions: string[];
  terms: string;
  registration_window_days: number;
};

export type RegistrationStatus = "pending" | "active" | "review" | "void";
export const REG_STATUS: Record<RegistrationStatus, { label: string; pill: string; hint: string }> = {
  pending: { label: "Awaiting customer", pill: "cyan", hint: "Sticker printed — the customer hasn't scanned it yet." },
  active: { label: "Active", pill: "green", hint: "Registered. Coverage is running." },
  review: { label: "Needs review", pill: "magenta", hint: "Self-registered from the website without a sticker — confirm the purchase, then approve." },
  void: { label: "Void", pill: "muted", hint: "Cancelled by staff." },
};

export const lines = (text: string | null | undefined): string[] =>
  String(text ?? "").split(/\r?\n/).map((s) => s.trim()).filter(Boolean);

export function snapshotPlan(p: WarrantyPlan): PlanSnapshot {
  return { key: p.key, name: p.name, months: p.months, summary: p.summary, coverage: lines(p.coverage), exclusions: lines(p.exclusions), terms: p.terms, registration_window_days: p.registration_window_days };
}

/** Sanitize a plan snapshot read back from jsonb (older rows / hand edits). */
export function readSnapshot(raw: any): PlanSnapshot {
  return {
    key: String(raw?.key ?? ""),
    name: String(raw?.name ?? "Warranty"),
    months: Math.max(1, Math.round(Number(raw?.months)) || 12),
    summary: String(raw?.summary ?? ""),
    coverage: Array.isArray(raw?.coverage) ? raw.coverage.map(String) : lines(raw?.coverage),
    exclusions: Array.isArray(raw?.exclusions) ? raw.exclusions.map(String) : lines(raw?.exclusions),
    terms: String(raw?.terms ?? ""),
    registration_window_days: Math.max(0, Math.round(Number(raw?.registration_window_days)) || 0),
  };
}

// ---- Dates (all ISO yyyy-mm-dd, computed in UTC so a date is a date) ----
export const todayIso = () => new Date().toISOString().slice(0, 10);

export function addMonths(iso: string, months: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1 + months, 1));
  // Clamp to the target month's last day (Jan 31 + 1 month → Feb 28/29).
  const last = new Date(Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth() + 1, 0)).getUTCDate();
  dt.setUTCDate(Math.min(d, last));
  return dt.toISOString().slice(0, 10);
}

export const isIsoDate = (s: any) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));

/** Whole days until coverage ends (negative = expired). */
export function daysLeft(coverageEnd: string, today = todayIso()): number {
  return Math.round((Date.parse(coverageEnd) - Date.parse(today)) / 86_400_000);
}

/** Share of the coverage window still ahead, 0–1. */
export function fractionLeft(start: string, end: string, today = todayIso()): number {
  const total = Date.parse(end) - Date.parse(start);
  if (total <= 0) return 0;
  return Math.max(0, Math.min(1, (Date.parse(end) - Date.parse(today)) / total));
}

export function fmtDate(iso: string | null | undefined, style: "short" | "long" = "short"): string {
  if (!iso) return "—";
  const [y, m, d] = String(iso).slice(0, 10).split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.toLocaleDateString("en-US", style === "long"
    ? { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" }
    : { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

/** "1 Year", "18 Months", "90 Days"-style length for labels and pages. */
export function lengthLabel(months: number): string {
  if (months % 12 === 0) { const y = months / 12; return `${y} Year${y === 1 ? "" : "s"}`; }
  return `${months} Month${months === 1 ? "" : "s"}`;
}

// ---- Tokens + links ----
// The QR payload. 8 chars from a 31-symbol alphabet (no 0/O/1/l/I) ≈ 40 bits:
// unguessable, and short enough for a version-3 QR on a sticker.
const TOKEN_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
export function makeToken(len = 8): string {
  const buf = new Uint8Array(len);
  crypto.getRandomValues(buf);
  let out = "";
  for (const b of buf) out += TOKEN_ALPHABET[b % TOKEN_ALPHABET.length];
  return out;
}
export const isToken = (s: any) => typeof s === "string" && /^[a-z0-9]{6,16}$/.test(s);

/** Absolute public link — the QR encodes this. Always the marketing host. */
export const warrantyUrl = (token: string) => `${SITE.url}/w/${token}`;

export function maskEmail(email: string | null | undefined): string {
  if (!email) return "";
  const [u, dom] = email.split("@");
  if (!dom) return "•••";
  return `${u.slice(0, 1)}•••@${dom}`;
}

// ---- Sticker ----
export type WarrantyLabel = {
  warrantyNo: string;
  planName: string;
  lengthText: string;   // "1 Year"
  saleDate: string;     // display form
  url: string;          // QR payload
  itemTitle: string;
  condition: string;
  platform: string;
};

/** Build the LabelItem the print pipeline renders as a warranty sticker. */
export function warrantyLabelItem(reg: {
  warranty_no: string; token: string; item_title: string; item_platform?: string | null; item_condition?: string | null;
  sale_date: string; plan_snapshot: any;
}, storeName: string): LabelItem {
  const snap = readSnapshot(reg.plan_snapshot);
  return {
    title: reg.item_title,
    categoryName: reg.item_platform ?? "",
    condShort: reg.item_condition ?? "",
    priceCents: 0,
    invTypeName: "",
    locationKey: "",
    internalCode: "",
    labelCode: "",
    sku: "",
    storeName,
    warranty: {
      warrantyNo: reg.warranty_no,
      planName: snap.name,
      lengthText: lengthLabel(snap.months),
      saleDate: fmtDate(reg.sale_date),
      url: warrantyUrl(reg.token),
      itemTitle: reg.item_title,
      condition: reg.item_condition ?? "",
      platform: reg.item_platform ?? "",
    },
  };
}

// ---- Customers ----
// Find the customer this registration belongs to (by email, case-insensitive,
// skipping merged duplicates) or create one. Never overwrites what's already
// on a matched record — only fills blanks — so a POS-entered name/phone wins.
export async function findOrCreateCustomer(
  admin: { from: (t: string) => any },
  c: { first: string; last: string; email: string; phone?: string },
): Promise<string | null> {
  const email = c.email.trim().toLowerCase();
  const { data: found } = await admin
    .from("customers")
    .select("id, first_name, last_name, phone")
    .ilike("email", email)
    .is("merged_into", null)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (found) {
    const patch: Record<string, string> = {};
    if (!found.first_name?.trim() && c.first) patch.first_name = c.first;
    if (!found.last_name?.trim() && c.last) patch.last_name = c.last;
    if (!found.phone && c.phone) patch.phone = c.phone;
    if (Object.keys(patch).length) await admin.from("customers").update(patch).eq("id", found.id);
    return found.id;
  }
  const { data: made } = await admin
    .from("customers")
    .insert({ first_name: c.first || "Customer", last_name: c.last || "", email, phone: c.phone || null })
    .select("id")
    .single();
  return made?.id ?? null;
}

// ---- Plan sanitizing (Settings API trust boundary) ----
const slug = (s: any) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24);
export function sanitizePlanInput(raw: any): Omit<WarrantyPlan, "id"> | { error: string } {
  const name = String(raw?.name ?? "").trim().slice(0, 80);
  if (!name) return { error: "Give the plan a name." };
  const months = Math.round(Number(raw?.months));
  if (!Number.isFinite(months) || months < 1 || months > 120) return { error: "Length must be 1–120 months." };
  const key = slug(raw?.key) || slug(name) || "plan";
  const win = Math.round(Number(raw?.registration_window_days));
  return {
    key,
    name,
    months,
    summary: String(raw?.summary ?? "").trim().slice(0, 300),
    coverage: lines(raw?.coverage).slice(0, 20).map((s) => s.slice(0, 200)).join("\n"),
    exclusions: lines(raw?.exclusions).slice(0, 20).map((s) => s.slice(0, 200)).join("\n"),
    terms: String(raw?.terms ?? "").trim().slice(0, 4000),
    registration_window_days: Number.isFinite(win) ? Math.min(3650, Math.max(1, win)) : 60,
    is_active: raw?.is_active !== false,
    is_default: raw?.is_default === true,
    sort_order: Math.max(0, Math.round(Number(raw?.sort_order)) || 0),
  };
}
