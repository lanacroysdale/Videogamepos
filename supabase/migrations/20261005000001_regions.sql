-- ============================================================================
-- REGIONS as a tag on every listing (owner request, 2026-10-05).
--
-- A game's market (US / PAL / Japan…) is a property of the RELEASE — a JP copy
-- has its own UPC/JAN and its own PriceCharting id — so it lives on the
-- listing: products.region_code. Until now it only existed as a "[PAL]" /
-- "[JP]" suffix the CSV importer appended to the TITLE; that tag moves into the
-- field and titles become clean. The app shows a badge (🇯🇵 JP) wherever a
-- title shows, filters/sorts by it (POS + shop), and keeps "[JP]" in text
-- snapshots (receipts, trade-in tickets).
--
-- 1) store_regions — the list, as data (licensing: a UK store makes PAL its
--    default). code is stable (URLs ?region=, sale snapshots, imports);
--    aliases are the words that mean it (import sheets, eBay "Region Code",
--    search "pal"/"jp", title tags); show_badge = false for the home market.
--    Managed in Settings (service-role writes via /api/pos/inventory-config).
-- 2) products.region_code — explicit code, NOT NULL (changing the default
--    region later must not relabel the catalog). A guard trigger:
--      * fills the default when a write leaves it empty;
--      * moves a bracket tag whose WHOLE text is a region alias ("[PAL]",
--        "(Japan Import)") out of the title into region_code — so no write
--        path (eBay import, a typed title, an old screen) can bring tags back.
--        Edition tags ("[Collector's Edition]", "[Clear Orange]") stay.
-- 3) Backfill: tagged titles (via the trigger), regional platform names
--    ("PAL Nintendo Switch", Super Famicom, WonderSwan) and Japanese JAN codes
--    (13 digits starting 45/49) → JP. The last statement lists every listing
--    that is now not the default region — check it.
-- 4) transaction_items.region — the code, snapshotted at sale time (reports
--    "by region" survive later edits), like inventory_type.
--
-- Apply in the Supabase SQL editor AFTER the app update is live (the app works
-- before and after). Safe to re-run: a re-run applies the table / field /
-- guard only — the region GUESSES in step 3 (b)–(d) run once, so they never
-- undo a region you corrected by hand. To review regions again, run just the
-- last SELECT.
-- ============================================================================

-- ---- 1. the list ------------------------------------------------------------
create table if not exists public.store_regions (
  id          uuid primary key default gen_random_uuid(),
  code        text not null unique check (code ~ '^[A-Z0-9]{1,8}$'),
  name        text not null,
  short_tag   text not null,                  -- badge / "[PAL]" text
  flag        text,                           -- emoji
  aliases     text[] not null default '{}',   -- normalized: lowercase words
  show_badge  boolean not null default true,  -- false for the home market
  is_default  boolean not null default false,
  is_active   boolean not null default true,
  is_system   boolean not null default false,
  sort_order  int not null default 0,
  created_at  timestamptz not null default now()
);
create unique index if not exists store_regions_one_default on public.store_regions(is_default) where is_default;
create index if not exists store_regions_order_idx on public.store_regions(sort_order, name);

alter table public.store_regions enable row level security;
drop policy if exists store_regions_read on public.store_regions;
create policy store_regions_read on public.store_regions for select using (public.is_staff());
revoke insert, update, delete on public.store_regions from authenticated;
grant select on public.store_regions to authenticated;
grant select, insert, update, delete on public.store_regions to service_role;

-- Core rows keep their code (listings, URLs and sale snapshots use it) and
-- can't be deleted; name / tag / flag / aliases / badge stay editable.
create or replace function public.guard_store_region()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'DELETE' then
    if old.is_system then raise exception 'Core regions cannot be deleted.'; end if;
    return old;
  end if;
  if old.is_system and (new.code <> old.code or new.is_system <> old.is_system) then
    raise exception 'A core region''s code cannot be changed.';
  end if;
  return new;
end $$;
drop trigger if exists guard_store_region on public.store_regions;
create trigger guard_store_region before update or delete on public.store_regions
  for each row execute function public.guard_store_region();

-- Seed only into an EMPTY table (a store that changed its default or renamed
-- a region must not get a second default on re-run).
insert into public.store_regions (code, name, short_tag, flag, aliases, show_badge, is_default, is_system, sort_order)
select * from (values
  ('US',   'North America (NTSC-U/C)', 'US',   '🇺🇸',
   array['us','usa','u s','ntsc','ntsc u','ntsc uc','ntsc u c','north america','north american','us version','usa version','canada','american'],
   false, true,  true,  0),
  ('PAL',  'Europe / Australia (PAL)', 'PAL',  '🇪🇺',
   array['pal','eu','europe','european','uk','pal uk','pal eu','pal au','pal version','eu version','uk version','australia','australian'],
   true,  false, true,  1),
  ('JP',   'Japan (NTSC-J)',           'JP',   '🇯🇵',
   array['jp','jpn','japan','japanese','ntsc j','japan import','japanese import','jp import','import japan','japanese version','jp version','japan version'],
   true,  false, true,  2),
  ('ASIA', 'Asia',                     'ASIA', '🌏',
   array['asia','asian','asian english','asia english','asian version','hk','hong kong','chinese','china','korea','korean'],
   true,  false, false, 3)
) as s(code, name, short_tag, flag, aliases, show_badge, is_default, is_system, sort_order)
where not exists (select 1 from public.store_regions);

-- The same normalization the app uses for aliases (lowercase words).
create or replace function public.region_norm(p text)
returns text language sql immutable as $$
  select btrim(regexp_replace(lower(coalesce(p, '')), '[^a-z0-9]+', ' ', 'g'))
$$;

-- The region a bit of text names exactly ("PAL", "Japan Import"), or null.
create or replace function public.region_for_text(p text)
returns text language sql stable security definer set search_path = public as $$
  select r.code from public.store_regions r
   where public.region_norm(p) <> ''
     and (public.region_norm(p) = any(r.aliases)
          or public.region_norm(p) = lower(r.code)
          or public.region_norm(p) = lower(r.short_tag))
   order by r.sort_order
   limit 1
$$;

-- ---- 2. the field + its guard ----------------------------------------------
alter table public.products add column if not exists region_code text
  references public.store_regions(code) on update cascade on delete restrict;
create index if not exists products_region_idx on public.products(region_code);

create or replace function public.products_region_guard()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_default text;
  v_tag     text;
  v_code    text;
  v_title   text;
  m         text[];
begin
  select code into v_default from public.store_regions where is_default limit 1;
  -- A bracket / paren tag that is exactly a region → the field, not the title.
  if new.title ~ '[\[(]' then
    v_title := new.title;
    for m in select regexp_matches(new.title, '([\[(]([^\])\[(]*)[\])])', 'g') loop
      v_code := public.region_for_text(m[2]);
      if v_code is not null then
        v_tag := coalesce(v_tag, v_code);
        v_title := replace(v_title, m[1], ' ');
      end if;
    end loop;
    v_title := btrim(regexp_replace(v_title, '\s{2,}', ' ', 'g'));
    if v_tag is not null and v_title <> '' then
      new.title := v_title;
      if new.region_code is null or new.region_code = v_default then
        new.region_code := v_tag;
      end if;
    end if;
  end if;
  if new.region_code is null then
    new.region_code := v_default;
  end if;
  return new;
end $$;
drop trigger if exists products_region_guard on public.products;
create trigger products_region_guard before insert or update of title, region_code on public.products
  for each row execute function public.products_region_guard();

-- ---- 3. backfill ------------------------------------------------------------
-- (a) Titles with a region tag: re-saving the title runs the guard.
update public.products set title = title where title ~ '[\[(]';

-- Everything else starts as the default region (the rules below only ever
-- move a DEFAULT listing to an import region, never one already tagged).
update public.products set region_code = (select code from public.store_regions where is_default) where region_code is null;

-- (b) A regional platform name: "PAL Nintendo Switch" → Nintendo Switch + PAL.
update public.products p
   set region_code = x.code,
       platform    = x.rest
  from (
    select id, public.region_for_text(m[1]) as code, btrim(m[2]) as rest
      from public.products,
           lateral regexp_match(platform, '^(pal|jp|jpn|japan|japanese|eu|europe|uk|asia|asian english)\s+(.+)$', 'i') as m
     where m is not null
  ) x
 where p.id = x.id and x.code is not null and x.rest <> ''
   and p.region_code = (select code from public.store_regions where is_default)
   and exists (select 1 from information_schema.columns   -- first run only
                where table_schema = 'public' and table_name = 'products'
                  and column_name = 'region_code' and is_nullable = 'YES');

-- (c) Systems sold only in Japan, or under their Japanese names.
update public.products
   set region_code = (select code from public.store_regions where code = 'JP')
 where region_code = (select code from public.store_regions where is_default)
   and exists (select 1 from public.store_regions where code = 'JP')
   and public.region_norm(platform) ~ '(^| )(super famicom|famicom|famicom disk system|sfc|pc engine|pc engine cd|pc engine duo|pc fx|satellaview|wonderswan|wonderswan color|wonderswan crystal)( |$)'
   and exists (select 1 from information_schema.columns   -- first run only
                where table_schema = 'public' and table_name = 'products'
                  and column_name = 'region_code' and is_nullable = 'YES');

-- (d) A Japanese JAN (13 digits, 45/49 prefix) on the listing or any copy.
update public.products p
   set region_code = 'JP'
 where p.region_code = (select code from public.store_regions where is_default)
   and exists (select 1 from public.store_regions where code = 'JP')
   and (
     exists (select 1 from public.product_upcs u where u.product_id = p.id and u.upc ~ '^4[59][0-9]{11}$')
     or exists (select 1 from public.product_variants v where v.product_id = p.id and v.barcode ~ '^4[59][0-9]{11}$')
     or exists (select 1 from public.product_barcodes b join public.product_variants v on v.id = b.variant_id
                 where v.product_id = p.id and b.barcode ~ '^4[59][0-9]{11}$')
   )
   and exists (select 1 from information_schema.columns   -- first run only
                where table_schema = 'public' and table_name = 'products'
                  and column_name = 'region_code' and is_nullable = 'YES');

-- (e) The field is required from here on (the guard fills the default).
alter table public.products alter column region_code set not null;

-- ---- 4. sale snapshot ---------------------------------------------------------
alter table public.transaction_items add column if not exists region text;
-- Past sales: their listing's region (as set above), so "by region" reports
-- include them. Only lines still unstamped.
update public.transaction_items ti
   set region = p.region_code
  from public.product_variants v
  join public.products p on p.id = v.product_id
 where ti.variant_id = v.id
   and ti.region is null;

-- ---- check: every listing that is NOT the default region now ---------------
select p.title, p.platform, p.region_code, p.slug
  from public.products p
 where p.region_code <> (select code from public.store_regions where is_default)
 order by p.region_code, p.title;
