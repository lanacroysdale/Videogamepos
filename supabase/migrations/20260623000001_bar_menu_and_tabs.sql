-- ============================================================================
-- Bar / food & beverage foundation: a proper menu model (sections, items,
-- sizes, reusable modifier groups + options, 86'ing) and real bar TABS
-- (named, appendable, settle-later, cross-side pickup) layered on the existing
-- transactions ledger — a tab is just a long-lived open transaction, so Reports
-- and the rest of the POS keep working unchanged.
-- Apply in the Supabase SQL editor (no DDL from the app).
-- ============================================================================

-- ---- Menu sections (Cocktails, Draft Beer, Appetizers, …) -------------------
create table if not exists public.menu_sections (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  sort_order  int not null default 0,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now()
);
create index if not exists menu_sections_order_idx on public.menu_sections(sort_order, name);

-- ---- Menu items (a drink or dish) ------------------------------------------
create table if not exists public.menu_items (
  id               uuid primary key default gen_random_uuid(),
  section_id       uuid references public.menu_sections(id) on delete set null,
  name             text not null,
  description      text,
  base_price_cents int not null default 0,        -- used when the item has no sizes
  cost_cents       int not null default 0,        -- est. pour/food cost, for F&B margin
  image_url        text,
  is_available     boolean not null default true, -- the "86" toggle
  online_orderable boolean not null default true, -- show on the QR / web menu
  abv              numeric,                        -- optional, for drinks
  tags             text[] not null default '{}',  -- "gluten-free", "vegan", search
  sort_order       int not null default 0,
  created_by       uuid references public.profiles(id) on delete set null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index if not exists menu_items_section_idx on public.menu_items(section_id, sort_order, name);

-- ---- Sizes / pours (Pint vs Pitcher, 12oz vs 16oz, Single vs Double) --------
-- Optional: an item with no sizes just sells at base_price_cents.
create table if not exists public.menu_item_sizes (
  id            uuid primary key default gen_random_uuid(),
  menu_item_id  uuid not null references public.menu_items(id) on delete cascade,
  label         text not null,                 -- "Pint", "Double", "16 oz"
  price_cents   int not null,
  is_default    boolean not null default false,
  is_available  boolean not null default true,
  sort_order    int not null default 0
);
create index if not exists menu_item_sizes_item_idx on public.menu_item_sizes(menu_item_id, sort_order);

-- ---- Reusable modifier groups (Milk, Add-ons, Temperature) ------------------
-- Standalone so one "Milk" group can be attached to every coffee. min/max_select
-- model required/optional + single/multi choice (max_select=1 => radio).
create table if not exists public.menu_modifier_groups (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  min_select  int not null default 0,          -- 0 = optional
  max_select  int,                             -- null = unlimited
  sort_order  int not null default 0,
  created_at  timestamptz not null default now()
);

create table if not exists public.menu_modifier_options (
  id               uuid primary key default gen_random_uuid(),
  group_id         uuid not null references public.menu_modifier_groups(id) on delete cascade,
  name             text not null,              -- "Oat", "Almond", "Extra shot"
  price_delta_cents int not null default 0,
  is_default       boolean not null default false,
  is_available     boolean not null default true,
  sort_order       int not null default 0
);
create index if not exists menu_modifier_options_group_idx on public.menu_modifier_options(group_id, sort_order);

-- ---- Which items use which modifier groups (many-to-many + per-item order) --
create table if not exists public.menu_item_modifier_groups (
  id            uuid primary key default gen_random_uuid(),
  menu_item_id  uuid not null references public.menu_items(id) on delete cascade,
  group_id      uuid not null references public.menu_modifier_groups(id) on delete cascade,
  sort_order    int not null default 0,
  unique (menu_item_id, group_id)
);
create index if not exists menu_item_mod_groups_item_idx on public.menu_item_modifier_groups(menu_item_id, sort_order);

-- ---- RLS: staff read, managers manage the menu -----------------------------
-- (The public QR/web menu is served server-side via the service-role client,
--  so no public read policy is needed here.)
do $$
declare t text;
begin
  foreach t in array array[
    'menu_sections','menu_items','menu_item_sizes',
    'menu_modifier_groups','menu_modifier_options','menu_item_modifier_groups'
  ] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists %I on public.%I', t||'_read', t);
    execute format('create policy %I on public.%I for select using (public.is_staff())', t||'_read', t);
    execute format('drop policy if exists %I on public.%I', t||'_write', t);
    execute format('create policy %I on public.%I for all using (public.is_manager()) with check (public.is_manager())', t||'_write', t);
    execute format('grant select, insert, update, delete on public.%I to authenticated', t);
  end loop;
end $$;

-- ============================================================================
-- Tabs + menu-aware line items on the existing ledger
-- ============================================================================
-- A bar tab is a transaction with is_tab=true kept in status='open', named, and
-- appended to over time; settling it sets status='completed' + tab_closed_at.
alter table public.transactions add column if not exists is_tab        boolean not null default false;
alter table public.transactions add column if not exists tab_name      text;
alter table public.transactions add column if not exists table_label   text;   -- optional table/seat
alter table public.transactions add column if not exists tab_opened_at timestamptz;
alter table public.transactions add column if not exists tab_closed_at timestamptz;
create index if not exists transactions_open_tab_idx on public.transactions(is_tab, status) where is_tab;

-- Menu line items: link to the menu item, snapshot the size + chosen modifiers
-- (so historical orders are immune to later menu edits), and flag cross-side
-- pickup (a retail game parked on a bar tab to grab next day).
alter table public.transaction_items add column if not exists menu_item_id uuid references public.menu_items(id) on delete set null;
alter table public.transaction_items add column if not exists size_label   text;
alter table public.transaction_items add column if not exists modifiers    jsonb;  -- [{name, price_delta_cents}]
alter table public.transaction_items add column if not exists fulfillment  text not null default 'immediate'
  check (fulfillment in ('immediate','pickup'));
alter table public.transaction_items add column if not exists fulfilled_at timestamptz;
create index if not exists transaction_items_pickup_idx on public.transaction_items(fulfillment) where fulfillment = 'pickup';

-- A line is either a retail variant or a menu item, never both. (Both NULL is
-- still allowed — that's a custom/service line like Disc Repair.)
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'transaction_items_one_product_ref') then
    alter table public.transaction_items
      add constraint transaction_items_one_product_ref check (variant_id is null or menu_item_id is null);
  end if;
end $$;

-- ---- Tab access: any staff can read / add-to / settle a TAB ----------------
-- The base transaction policies are per-cashier; these permissive policies are
-- OR'd on top so a tab (is_tab=true) is shared across the whole staff, without
-- changing retail-sale isolation.
drop policy if exists tx_tab_staff_select on public.transactions;
create policy tx_tab_staff_select on public.transactions for select using (is_tab and public.is_staff());
drop policy if exists tx_tab_staff_insert on public.transactions;
create policy tx_tab_staff_insert on public.transactions for insert with check (is_tab and public.is_staff());
drop policy if exists tx_tab_staff_update on public.transactions;
create policy tx_tab_staff_update on public.transactions for update
  using (is_tab and public.is_staff()) with check (public.is_staff());

drop policy if exists ti_tab_staff_select on public.transaction_items;
create policy ti_tab_staff_select on public.transaction_items for select
  using (exists (select 1 from public.transactions t where t.id = transaction_id and t.is_tab and public.is_staff()));
drop policy if exists ti_tab_staff_insert on public.transaction_items;
create policy ti_tab_staff_insert on public.transaction_items for insert
  with check (exists (select 1 from public.transactions t where t.id = transaction_id and t.is_tab and public.is_staff()));
drop policy if exists ti_tab_staff_update on public.transaction_items;
create policy ti_tab_staff_update on public.transaction_items for update
  using (exists (select 1 from public.transactions t where t.id = transaction_id and t.is_tab and public.is_staff()))
  with check (exists (select 1 from public.transactions t where t.id = transaction_id and t.is_tab and public.is_staff()));
drop policy if exists ti_tab_staff_delete on public.transaction_items;
create policy ti_tab_staff_delete on public.transaction_items for delete
  using (exists (select 1 from public.transactions t where t.id = transaction_id and t.is_tab and public.is_staff()));
