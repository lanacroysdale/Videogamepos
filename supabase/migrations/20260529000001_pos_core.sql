-- ============================================================================
-- Time Lag Gaming POS — core schema
-- Phase 1 of the real app: employees, customers, inventory, transactions,
-- trade-in margins, and a reporting view. Secured with Row Level Security.
-- ============================================================================

create extension if not exists pgcrypto;   -- gen_random_uuid()
create extension if not exists pg_trgm;     -- fuzzy / typo-tolerant search

-- ============================================================================
-- Employees (profiles) — linked to Supabase Auth users
-- ============================================================================
create table public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  full_name   text not null default 'New Employee',
  role        text not null default 'cashier' check (role in ('owner','manager','cashier')),
  pin         text,                       -- for quick card/PIN login (future)
  created_at  timestamptz not null default now()
);

-- Create a profile automatically whenever an auth user is created.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, full_name, role)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'full_name', split_part(new.email, '@', 1)),
    coalesce(new.raw_user_meta_data->>'role', 'cashier')
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
after insert on auth.users
for each row execute function public.handle_new_user();

-- Role helpers (security definer => bypass RLS, avoids policy recursion).
create or replace function public.is_staff()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where id = auth.uid());
$$;

create or replace function public.is_manager()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where id = auth.uid() and role in ('owner','manager'));
$$;

-- ============================================================================
-- Customers
-- ============================================================================
create table public.customers (
  id                 uuid primary key default gen_random_uuid(),
  first_name         text not null,
  last_name          text not null default '',
  email              text,
  phone              text,
  store_credit_cents integer not null default 0,
  points             integer not null default 0,
  membership         text not null default 'standard',  -- standard / member / vip
  email_subscribed   boolean not null default false,
  text_subscribed    boolean not null default false,
  notes              text,
  created_at         timestamptz not null default now()
);
create index customers_name_idx on public.customers (last_name, first_name);
create index customers_trgm_idx on public.customers using gin (
  (coalesce(first_name,'') || ' ' || coalesce(last_name,'') || ' ' ||
   coalesce(email,'') || ' ' || coalesce(phone,'')) gin_trgm_ops
);

-- ============================================================================
-- Inventory: categories -> products (title) -> variants (condition)
-- ============================================================================
create table public.categories (
  id           uuid primary key default gen_random_uuid(),
  name         text not null unique,
  color        text not null default '#2ce6e0',
  is_trackable boolean not null default true,   -- false = services (e.g. disc repair)
  sort_order   int not null default 0
);

create table public.products (
  id          uuid primary key default gen_random_uuid(),
  title       text not null,
  platform    text,                       -- e.g. "Nintendo 64"
  franchise   text,                       -- e.g. "Mario" (spinoffs included via tag)
  genre       text,
  rating      text,                       -- ESRB, e.g. "E"
  brand       text,
  category_id uuid references public.categories(id),
  created_at  timestamptz not null default now()
);
create index products_trgm_idx on public.products using gin (title gin_trgm_ops);
create index products_platform_idx on public.products (platform);
create index products_franchise_idx on public.products (franchise);

create table public.product_variants (
  id           uuid primary key default gen_random_uuid(),
  product_id   uuid not null references public.products(id) on delete cascade,
  condition    text not null default 'Good',   -- Loose / Good / Complete / New
  completeness text,                             -- e.g. "Cart only", "CIB"
  sku          text unique,
  barcode      text,
  price_cents  integer not null default 0,
  cost_cents   integer not null default 0,
  quantity     integer not null default 0,
  created_at   timestamptz not null default now()
);
create index variants_product_idx on public.product_variants (product_id);
create index variants_barcode_idx on public.product_variants (barcode);

-- ============================================================================
-- Transactions (open status doubles as drafts / suspended orders)
-- ============================================================================
create table public.transactions (
  id                 uuid primary key default gen_random_uuid(),
  human_id           bigint generated always as identity,
  customer_id        uuid references public.customers(id),
  employee_id        uuid references public.profiles(id),
  type               text not null default 'sale'  check (type in ('sale','trade_in','mixed','return')),
  status             text not null default 'open'  check (status in ('open','completed','void')),
  subtotal_cents     integer not null default 0,
  discount_cents     integer not null default 0,
  total_cents        integer not null default 0,
  cash_cents         integer not null default 0,
  card_cents         integer not null default 0,
  store_credit_cents integer not null default 0,
  note               text,
  created_at         timestamptz not null default now(),
  completed_at       timestamptz
);
create index transactions_status_idx on public.transactions (status);
create index transactions_employee_idx on public.transactions (employee_id);
create index transactions_created_idx on public.transactions (created_at);

create table public.transaction_items (
  id               uuid primary key default gen_random_uuid(),
  transaction_id   uuid not null references public.transactions(id) on delete cascade,
  variant_id       uuid references public.product_variants(id),
  category_id      uuid references public.categories(id),  -- denormalized for reporting
  kind             text not null default 'sale' check (kind in ('sale','trade_in','return','service')),
  description      text not null,
  qty              integer not null default 1,
  unit_price_cents integer not null default 0,             -- payout amount for trade_in
  discount_cents   integer not null default 0,
  serial_note      text,
  created_at       timestamptz not null default now()
);
create index items_transaction_idx on public.transaction_items (transaction_id);
create index items_category_idx on public.transaction_items (category_id);

-- ============================================================================
-- Trade-in margins (customizable by price range)
-- ============================================================================
create table public.trade_margins (
  id             uuid primary key default gen_random_uuid(),
  label          text not null,
  min_cents      integer not null default 0,
  max_cents      integer,                 -- null = no upper bound
  cash_percent   numeric(5,2) not null,   -- % of resale offered as cash
  credit_percent numeric(5,2) not null,   -- % of resale offered as store credit
  sort_order     int not null default 0
);

-- ============================================================================
-- Reporting view (respects RLS via security_invoker)
-- ============================================================================
create or replace view public.sales_report_items
with (security_invoker = true) as
  select
    ti.id,
    t.id                                              as transaction_id,
    t.completed_at,
    t.completed_at::date                              as sale_date,
    extract(hour from t.completed_at)::int            as hour_of_day,
    extract(dow  from t.completed_at)::int            as day_of_week,
    t.employee_id,
    p.full_name                                       as employee_name,
    ti.category_id,
    c.name                                            as category_name,
    ti.qty,
    (ti.unit_price_cents * ti.qty - ti.discount_cents) as net_cents
  from public.transaction_items ti
  join public.transactions t on t.id = ti.transaction_id
  left join public.profiles  p on p.id = t.employee_id
  left join public.categories c on c.id = ti.category_id
  where t.status = 'completed' and ti.kind in ('sale','service');

-- ============================================================================
-- Row Level Security
-- ============================================================================
alter table public.profiles          enable row level security;
alter table public.customers          enable row level security;
alter table public.categories         enable row level security;
alter table public.products           enable row level security;
alter table public.product_variants   enable row level security;
alter table public.transactions       enable row level security;
alter table public.transaction_items  enable row level security;
alter table public.trade_margins      enable row level security;

-- Profiles: any staff can read the roster; you can edit yourself, managers edit anyone.
create policy profiles_read   on public.profiles for select using (public.is_staff());
create policy profiles_update on public.profiles for update
  using (id = auth.uid() or public.is_manager())
  with check (id = auth.uid() or public.is_manager());

-- Operational tables: any authenticated staff member has full access.
-- (Finer-grained rules — e.g. cashiers only seeing their own transactions —
--  are enforced in the app for now and can be tightened here later.)
create policy customers_staff         on public.customers         for all using (public.is_staff()) with check (public.is_staff());
create policy categories_staff        on public.categories        for all using (public.is_staff()) with check (public.is_staff());
create policy products_staff          on public.products          for all using (public.is_staff()) with check (public.is_staff());
create policy variants_staff          on public.product_variants  for all using (public.is_staff()) with check (public.is_staff());
create policy transactions_staff      on public.transactions      for all using (public.is_staff()) with check (public.is_staff());
create policy items_staff             on public.transaction_items for all using (public.is_staff()) with check (public.is_staff());
create policy margins_staff           on public.trade_margins     for all using (public.is_staff()) with check (public.is_staff());

-- ============================================================================
-- Grants (RLS still governs row access). anon gets nothing.
-- ============================================================================
grant usage on schema public to authenticated;
grant select, insert, update, delete on all tables in schema public to authenticated;
grant usage, select on all sequences in schema public to authenticated;
grant select on public.sales_report_items to authenticated;
