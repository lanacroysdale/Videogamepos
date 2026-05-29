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
  created_at: string;
}

export interface ProductVariant {
  id: string;
  product_id: string;
  condition: string;
  completeness: string | null;
  sku: string | null;
  barcode: string | null;
  price_cents: number;
  cost_cents: number;
  quantity: number;
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
}
