-- ============================================================================
-- Online shop listings
-- One shared stock pool (product_variants.quantity) feeds both the in-store POS
-- and the public website. These fields let staff PUBLISH specific variants to a
-- hidden /shop page without exposing the whole catalog (or any cost data).
--
-- No anon RLS policy is added: the hidden shop reads server-side via the
-- service-role client and selects only safe columns. When the shop goes fully
-- public, swap to a curated anon-readable view (see the architecture notes).
-- ============================================================================

alter table public.product_variants
  add column if not exists online_visible boolean not null default false,
  add column if not exists online_price_cents integer;   -- null => fall back to price_cents

alter table public.products
  add column if not exists description text,
  add column if not exists image_url text;

-- Fast lookup of just the published rows for the storefront query.
create index if not exists variants_online_visible_idx
  on public.product_variants (online_visible) where online_visible;
