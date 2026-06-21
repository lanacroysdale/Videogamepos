-- ============================================================================
-- Catalog foundation
-- The schema bedrock for Phase 1 (condition pricing, smart entry, PDP, filters,
-- collections, New Arrivals). Everything here is additive + license-ready:
-- features are settings-toggleable and the condition taxonomy is store-editable
-- config (rules-as-data), so a licensee defines their own.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. store_settings — single-row config + feature flags (the licensable knobs)
-- ---------------------------------------------------------------------------
create table if not exists public.store_settings (
  id                          int primary key default 1 check (id = 1),
  store_name                  text not null default 'TimeLag Video Games',
  condition_pricing_enabled   boolean not null default false,         -- off by default for licensees
  condition_entry_mode        text not null default 'separate' check (condition_entry_mode in ('separate','combined')),
  enrichment_provider         text default 'igdb',
  receipt_config              jsonb not null default '{}'::jsonb,
  settings                    jsonb not null default '{}'::jsonb,      -- catch-all for future flags
  updated_at                  timestamptz not null default now()
);
insert into public.store_settings (id) values (1) on conflict (id) do nothing;

alter table public.store_settings enable row level security;
grant select, insert, update on public.store_settings to authenticated;
create policy store_settings_read   on public.store_settings for select using (public.is_staff());
create policy store_settings_write  on public.store_settings for update using (public.is_manager());

-- ---------------------------------------------------------------------------
-- 2. Condition taxonomy — TWO configurable axes (completeness × grade)
-- ---------------------------------------------------------------------------
create table if not exists public.completeness_levels (
  id                  uuid primary key default gen_random_uuid(),
  code                text not null unique,                 -- 'L','CIB','IB','NEW'
  label               text not null,
  aliases             text[] not null default '{}',         -- for smart search
  sort_order          int not null default 0,
  badge_label         text,                                 -- e.g. 'No manual'
  badge_color         text,
  banner_on_thumbnail boolean not null default false,
  use_as_filter       boolean not null default true,
  is_active           boolean not null default true
);

create table if not exists public.condition_grades (
  id              uuid primary key default gen_random_uuid(),
  code            text not null unique,                     -- '1','2','3','MINT'
  label           text not null,
  icon            text,                                     -- '★','★★★','🌙'
  rank            int not null default 0,
  aliases         text[] not null default '{}',
  use_as_filter   boolean not null default true,
  is_active       boolean not null default true
);

-- Per-category default completeness (Switch→CIB, SNES→loose, …), store-configurable.
alter table public.categories add column if not exists default_completeness text;

-- Default preset (the owner's old store's model) — editable per store.
insert into public.completeness_levels (code, label, aliases, sort_order, badge_label, banner_on_thumbnail) values
  ('L',   'Loose',              array['loose','cart only','disc only','cartridge'], 1, 'Loose',     false),
  ('CIB', 'Complete in box',    array['cib','complete','complete in box'],          2, null,        false),
  ('IB',  'In box (no manual)', array['ib','in box','no manual'],                   3, 'No manual', true),
  ('NEW', 'New / sealed',       array['new','sealed','factory sealed','brand new'], 4, 'Sealed',    false)
on conflict (code) do nothing;

insert into public.condition_grades (code, label, icon, rank, aliases) values
  ('1',    'Poor', '★',   1, array['poor','rough','as is']),
  ('2',    'Fair', '★★',  2, array['fair','okay','decent']),
  ('3',    'Great','★★★', 3, array['great','good','very good','excellent']),
  ('MINT', 'Mint', '🌙',  4, array['mint','like new','near mint'])
on conflict (code) do nothing;

alter table public.completeness_levels enable row level security;
alter table public.condition_grades enable row level security;
grant select, insert, update, delete on public.completeness_levels to authenticated;
grant select, insert, update, delete on public.condition_grades to authenticated;
create policy completeness_read   on public.completeness_levels for select using (public.is_staff());
create policy completeness_manage on public.completeness_levels for all using (public.is_manager()) with check (public.is_manager());
create policy grades_read         on public.condition_grades for select using (public.is_staff());
create policy grades_manage       on public.condition_grades for all using (public.is_manager()) with check (public.is_manager());

-- ---------------------------------------------------------------------------
-- 3. Identifiers — one unique internal label code + many SKUs (barcodes exist)
-- ---------------------------------------------------------------------------
alter table public.product_variants add column if not exists internal_code text unique;

-- Auto-generate a unique internal code on insert (condition-encoding refined later).
create or replace function public.gen_variant_internal_code()
returns trigger language plpgsql as $$
begin
  if new.internal_code is null then
    new.internal_code := 'TL' || upper(substr(replace(new.id::text, '-', ''), 1, 10));
  end if;
  return new;
end; $$;
drop trigger if exists trg_variant_internal_code on public.product_variants;
create trigger trg_variant_internal_code before insert on public.product_variants
  for each row execute function public.gen_variant_internal_code();

update public.product_variants
  set internal_code = 'TL' || upper(substr(replace(id::text, '-', ''), 1, 10))
  where internal_code is null;

-- Multiple alt-SKUs per variant (barcodes already live in product_barcodes).
create table if not exists public.product_skus (
  id          uuid primary key default gen_random_uuid(),
  variant_id  uuid not null references public.product_variants(id) on delete cascade,
  sku         text not null,
  label       text,
  created_at  timestamptz not null default now(),
  unique (variant_id, sku)
);
create index if not exists product_skus_sku_idx on public.product_skus (sku);

alter table public.product_skus enable row level security;
grant select, insert, update, delete on public.product_skus to authenticated;
create policy product_skus_staff on public.product_skus for all using (public.is_staff()) with check (public.is_staff());

-- ---------------------------------------------------------------------------
-- 4. Restock tracking — powers "New Arrivals (48h)" + audit ledger
-- ---------------------------------------------------------------------------
alter table public.product_variants add column if not exists restocked_at timestamptz;

-- Stamp restocked_at whenever quantity crosses 0 -> positive (any code path).
create or replace function public.set_restocked_at()
returns trigger language plpgsql as $$
begin
  if coalesce(old.quantity, 0) <= 0 and new.quantity > 0 then
    new.restocked_at := now();
  end if;
  return new;
end; $$;
drop trigger if exists trg_restocked_at on public.product_variants;
create trigger trg_restocked_at before update of quantity on public.product_variants
  for each row execute function public.set_restocked_at();

-- Movement ledger (reason is set by the app: sale/return/receive/manual). Created
-- now; populated as the atomic stock RPC + scan-in land.
create table if not exists public.stock_movements (
  id              uuid primary key default gen_random_uuid(),
  variant_id      uuid not null references public.product_variants(id) on delete cascade,
  delta           int not null,
  reason          text not null check (reason in ('sale','return','receive','manual','adjust','initial')),
  channel         text not null default 'in_store' check (channel in ('in_store','online')),
  transaction_id  uuid references public.transactions(id) on delete set null,
  employee_id     uuid references public.profiles(id) on delete set null,
  created_at      timestamptz not null default now()
);
create index if not exists stock_movements_variant_idx on public.stock_movements (variant_id, created_at desc);

alter table public.stock_movements enable row level security;
grant select, insert on public.stock_movements to authenticated;
create policy stock_movements_read   on public.stock_movements for select using (public.is_staff());
create policy stock_movements_insert on public.stock_movements for insert with check (public.is_staff());

-- ---------------------------------------------------------------------------
-- 5. Product metadata — round out the rich-metadata model (PDP + search + filters)
-- ---------------------------------------------------------------------------
alter table public.products
  add column if not exists tags              text[] not null default '{}',
  add column if not exists alternative_names text[] not null default '{}',  -- search aliases (BOTW…)
  add column if not exists release_year      int,
  add column if not exists trailer_url       text;

create index if not exists products_tags_idx on public.products using gin (tags);
