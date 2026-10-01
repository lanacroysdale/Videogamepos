-- ============================================================================
-- Listing-level UPCs (automatic from eBay's product catalog, or entered).
--
-- A game's UPC identifies the RELEASE, not a condition: "Mario Kart 7" has the
-- same UPC whether the copy is loose or sealed. So it belongs to the listing
-- (products), not to one condition row (product_barcodes is per variant).
-- Scanning a listing UPC finds the listing; if it has several conditions the
-- POS asks which one.
--
-- 1) product_upcs: one row per UPC. A listing may have more than one (a
--    reprint with a new code). A UPC belongs to ONE listing — compared as a
--    GTIN, so the 12-digit "045496742843" and 13-digit "0045496742843" are the
--    same code.
-- 2) products.upc_status / upc_checked_at: the automatic lookup's last result
--    ('found' | 'not_found' | 'ambiguous' | 'conflict' | 'error' | 'rejected'),
--    so the daily run skips listings it tried recently, and "Needs UPC" can
--    explain why a listing has none. upc_rejected: codes a manager removed —
--    never attached automatically again.
--
-- Apply in the Supabase SQL editor. Safe to re-run.
-- ============================================================================

create table if not exists public.product_upcs (
  id         uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products(id) on delete cascade,
  upc        text not null check (upc ~ '^[0-9]{8,14}$'),
  source     text not null default 'manual' check (source in ('ebay', 'manual', 'import')),
  evidence   text,
  created_at timestamptz not null default now()
);
create unique index if not exists product_upcs_gtin_key on public.product_upcs ((lpad(upc, 14, '0')));
create index if not exists product_upcs_product_idx on public.product_upcs (product_id);

alter table public.product_upcs enable row level security;
drop policy if exists product_upcs_staff on public.product_upcs;
create policy product_upcs_staff on public.product_upcs for all using (public.is_staff()) with check (public.is_staff());

alter table public.products add column if not exists upc_status text;
alter table public.products add column if not exists upc_checked_at timestamptz;
-- Codes a manager removed from this listing: the automatic lookup never
-- attaches them again.
alter table public.products add column if not exists upc_rejected text[] not null default '{}';

-- Codes already saved as a condition's "UPC" barcode (eBay imports) become
-- their listing's UPC too. Stored as the 12-digit UPC-A when it is one.
insert into public.product_upcs (product_id, upc, source, evidence)
select distinct on (lpad(b.barcode, 14, '0'))
       v.product_id,
       case when lpad(b.barcode, 14, '0') like '00%' then right(lpad(b.barcode, 14, '0'), 12) else b.barcode end,
       'ebay', 'From a condition''s UPC barcode'
  from public.product_barcodes b
  join public.product_variants v on v.id = b.variant_id
 where b.label = 'UPC' and b.barcode ~ '^[0-9]{12,14}$'
 order by lpad(b.barcode, 14, '0'), b.created_at
on conflict do nothing;
