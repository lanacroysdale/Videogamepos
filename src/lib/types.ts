// Hand-written types matching the POS schema (see supabase/migrations).
export type Role = "owner" | "manager" | "cashier";

export interface Profile {
  id: string;
  full_name: string;
  role: Role;
  pin: string | null;
  created_at: string;
}

export interface Customer {
  id: string;
  first_name: string;
  last_name: string;
  email: string | null;
  phone: string | null;
  store_credit_cents: number;
  points: number;
  membership: string;
  email_subscribed: boolean;
  text_subscribed: boolean;
  notes: string | null;
  created_at: string;
}

export interface Category {
  id: string;
  name: string;
  color: string;
  is_trackable: boolean;
  sort_order: number;
  default_completeness: string | null;
}

export interface Product {
  id: string;
  title: string;
  platform: string | null;
  franchise: string | null;
  genre: string | null;
  rating: string | null;
  brand: string | null;
  category_id: string | null;
  // Rich metadata (website listing + search)
  description: string | null;
  image_url: string | null;
  tags: string[];
  alternative_names: string[];
  release_year: number | null;
  trailer_url: string | null;
  created_at: string;
}

export interface ProductVariant {
  id: string;
  product_id: string;
  condition: string;
  completeness: string | null;
  sku: string | null;
  barcode: string | null;
  internal_code: string | null;
  price_cents: number;
  cost_cents: number;
  online_price_cents: number | null;
  online_visible: boolean;
  inventory_type_id: string;
  location_id: string | null;
  quantity: number;
  restocked_at: string | null;
  created_at: string;
}

export interface TradeMargin {
  id: string;
  label: string;
  min_cents: number;
  max_cents: number | null;
  cash_percent: number;
  credit_percent: number;
  sort_order: number;
}

export interface ProductBarcode {
  id: string;
  variant_id: string;
  barcode: string;
  label: string | null;
  created_at: string;
}

export interface ProductSku {
  id: string;
  variant_id: string;
  sku: string;
  label: string | null;
  created_at: string;
}

// ---- Catalog foundation (settings + configurable condition taxonomy) ----
export interface StoreSettings {
  id: number;
  store_name: string;
  condition_pricing_enabled: boolean;
  condition_entry_mode: "separate" | "combined";
  enrichment_provider: string | null;
  receipt_config: Record<string, unknown>;
  settings: Record<string, unknown>;
  updated_at: string;
}

// Business departments — the POS spine (Retail / Food & Beverage / Arcade).
// Configured at setup, then governed (owner/company unlock). Bar vs Kitchen is
// a station WITHIN Food & Beverage (menu_items.station), not a department.
export interface StoreDepartment {
  id: string;
  key: string;
  name: string;
  kind: "retail" | "food_bev" | "arcade" | "service" | "other";
  color: string | null;
  icon: string | null;
  is_enabled: boolean;
  is_system: boolean;
  sort_order: number;
  created_at: string;
}

// Inventory type = a first-class stock pool (Retail / Online / Personal
// Collection…) with behavior: website sync + checkout blocking. Variant-level.
export interface StoreInventoryType {
  id: string;
  key: string;
  name: string;
  icon: string | null;
  color: string | null;
  allow_website_sync: boolean;
  block_at_checkout: boolean;
  is_system: boolean;
  sort_order: number;
  created_at: string;
}

// The "PDX" on a printed label (multi-location roadmap: transfers later).
export interface StoreLocation {
  id: string;
  key: string;
  name: string;
  is_default: boolean;
  sort_order: number;
  created_at: string;
}

export interface CompletenessLevel {
  id: string;
  code: string;
  label: string;
  aliases: string[];
  sort_order: number;
  badge_label: string | null;
  badge_color: string | null;
  banner_on_thumbnail: boolean;
  use_as_filter: boolean;
  is_active: boolean;
}

export interface ConditionGrade {
  id: string;
  code: string;
  label: string;
  icon: string | null;
  rank: number;
  aliases: string[];
  use_as_filter: boolean;
  is_active: boolean;
}

export interface StockMovement {
  id: string;
  variant_id: string;
  delta: number;
  reason: "sale" | "return" | "receive" | "manual" | "adjust" | "initial";
  channel: "in_store" | "online";
  transaction_id: string | null;
  employee_id: string | null;
  created_at: string;
}

export interface Repair {
  id: string;
  ticket: number;
  customer_id: string | null;
  customer_name: string | null;
  phone: string | null;
  device_type: string;
  serial: string | null;
  location: string | null;
  issue: string | null;
  status: "in_queue" | "in_progress" | "completed" | "picked_up" | "cancelled";
  price_cents: number;
  employee_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface Shift {
  id: string;
  employee_id: string;
  starts_at: string;
  ends_at: string;
  note: string | null;
  created_at: string;
}

export interface TimeEntry {
  id: string;
  employee_id: string;
  clock_in: string;
  clock_out: string | null;
  created_at: string;
}

export interface PriceChange {
  id: string;
  variant_id: string;
  old_cents: number;
  suggested_cents: number;
  source: string;
  status: "pending" | "approved" | "reverted";
  created_at: string;
  reviewed_at: string | null;
  reviewed_by: string | null;
}

export interface Transaction {
  id: string;
  human_id: number;
  customer_id: string | null;
  employee_id: string | null;
  type: string;
  status: string;
  subtotal_cents: number;
  discount_cents: number;
  total_cents: number;
  cash_cents: number;
  card_cents: number;
  store_credit_cents: number;
  note: string | null;
  created_at: string;
  completed_at: string | null;
  // Gratuity folded into total_cents at settle (bar tabs).
  tip_cents: number;
  // Bar tab fields (a tab is a long-lived is_tab=true, status='open' transaction).
  is_tab: boolean;
  tab_name: string | null;
  table_label: string | null;
  tab_opened_at: string | null;
  tab_closed_at: string | null;
}
