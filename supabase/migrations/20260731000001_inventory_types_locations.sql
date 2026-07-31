-- ============================================================================
-- Inventory TYPES (stock segmentation) + LOCATIONS, the spine of the barcode
-- label system and the PRGE personal-collection workflow.
--
-- An inventory type is a first-class stock pool (Retail / Online / Personal
-- Collection / whatever a licensee adds) carrying BEHAVIOR:
--   • allow_website_sync — may its variants appear on the shop / feed / eBay?
--   • block_at_checkout  — refuse selling it at the POS (the owner keeps their
--     Personal Collection blocked day-to-day and untoggles it at the expo).
-- Types live per-VARIANT (a product can have a retail copy AND a personal
-- copy), and every sold line SNAPSHOTS the type key so reports survive edits —
-- the same live-FK + snapshot pattern as departments.
--
-- Locations are the "PDX" on a printed label (store #2 / warehouse later);
-- no transfer logic yet.
--
-- Managed by managers+ via /api/pos/inventory-config (service-role writes);
-- RLS: staff read, NO authenticated writes (PostgREST-hardened like
-- store_departments). Apply in the Supabase SQL editor (no DDL from the app).
-- ============================================================================

-- ---- Inventory types --------------------------------------------------------
create table if not exists public.store_inventory_types (
  id                 uuid primary key default gen_random_uuid(),
  key                text not null unique,          -- retail / online / personal_collection
  name               text not null,
  icon               text,
  color              text,
  allow_website_sync boolean not null default true, -- gate: shop / PDP / feed / eBay
  block_at_checkout  boolean not null default false,-- gate: POS sale (expo toggle)
  is_system          boolean not null default false,
  sort_order         int not null default 0,
  created_at         timestamptz not null default now()
);
create index if not exists store_inventory_types_order_idx on public.store_inventory_types(sort_order, name);

alter table public.store_inventory_types enable row level security;
drop policy if exists store_inventory_types_read on public.store_inventory_types;
create policy store_inventory_types_read on public.store_inventory_types for select using (public.is_staff());
revoke insert, update, delete on public.store_inventory_types from authenticated;
grant select on public.store_inventory_types to authenticated;
grant select, insert, update, delete on public.store_inventory_types to service_role;

-- System rows keep their stable key and can't be deleted; their BEHAVIOR flags
-- (allow_website_sync / block_at_checkout) and label stay editable — the whole
-- point is toggling them.
create or replace function public.guard_store_inventory_type()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'DELETE' then
    if old.is_system then raise exception 'Core inventory types cannot be deleted.'; end if;
    return old;
  end if;
  if old.is_system and (new.key <> old.key or new.is_system <> old.is_system) then
    raise exception 'A core inventory type''s key cannot be changed.';
  end if;
  return new;
end $$;
drop trigger if exists guard_store_inventory_type on public.store_inventory_types;
create trigger guard_store_inventory_type before update or delete on public.store_inventory_types
  for each row execute function public.guard_store_inventory_type();

insert into public.store_inventory_types (key, name, icon, sort_order, is_system, allow_website_sync, block_at_checkout)
values
  ('retail',              'Retail',              '🏪', 0, true, true,  false),
  ('online',              'Online',              '🌐', 1, true, true,  false),
  ('personal_collection', 'Personal Collection', '🔒', 2, true, false, true)
on conflict (key) do nothing;

-- ---- Locations (the "PDX" on a label) ---------------------------------------
create table if not exists public.store_locations (
  id         uuid primary key default gen_random_uuid(),
  key        text not null unique,     -- short label code: PDX
  name       text not null,
  is_default boolean not null default false,
  sort_order int not null default 0,
  created_at timestamptz not null default now()
);
create unique index if not exists store_locations_one_default on public.store_locations(is_default) where is_default;

alter table public.store_locations enable row level security;
drop policy if exists store_locations_read on public.store_locations;
create policy store_locations_read on public.store_locations for select using (public.is_staff());
revoke insert, update, delete on public.store_locations from authenticated;
grant select on public.store_locations to authenticated;
grant select, insert, update, delete on public.store_locations to service_role;

-- Seed only into an EMPTY table: if the store later renames/deletes PDX and
-- defaults elsewhere, a re-run must not re-insert a second default (the
-- key-conflict guard alone wouldn't catch that — the partial unique index would
-- abort the whole script).
insert into public.store_locations (key, name, is_default, sort_order)
select 'PDX', 'Portland', true, 0
where not exists (select 1 from public.store_locations);

-- ---- Variants carry a live type + location ----------------------------------
alter table public.product_variants add column if not exists inventory_type_id uuid references public.store_inventory_types(id) on delete restrict;
alter table public.product_variants add column if not exists location_id uuid references public.store_locations(id) on delete set null;
create index if not exists variants_inv_type_idx on public.product_variants(inventory_type_id);

-- Backfill every existing variant to Retail (zero website-behavior change),
-- default new inserts to Retail, then lock the column NOT NULL.
update public.product_variants
  set inventory_type_id = (select id from public.store_inventory_types where key = 'retail')
  where inventory_type_id is null;

create or replace function public.default_variant_inventory_type()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.inventory_type_id is null then
    select id into new.inventory_type_id from public.store_inventory_types where key = 'retail';
  end if;
  return new;
end $$;
drop trigger if exists default_variant_inventory_type on public.product_variants;
create trigger default_variant_inventory_type before insert on public.product_variants
  for each row execute function public.default_variant_inventory_type();

alter table public.product_variants alter column inventory_type_id set not null;

-- ---- Per-line snapshot on the ledger ----------------------------------------
-- Stamped at sale time (checkout/tabs) with the type KEY, so "sold from my
-- Personal Collection" reporting survives later reassignment or renames.
alter table public.transaction_items add column if not exists inventory_type text;
