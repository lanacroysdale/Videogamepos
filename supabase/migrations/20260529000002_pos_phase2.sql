-- ============================================================================
-- Time Lag Gaming POS — phase 2
-- Multi-barcode, repairs, scheduling/clock, price-change review, card login,
-- returns linkage, account merging, and finer per-employee RLS on transactions.
-- ============================================================================

-- Card / NFC quick login -----------------------------------------------------
alter table public.profiles add column if not exists card_code text unique;

-- Multi-barcode (several barcodes per variant, e.g. Target / Walmart SKUs) -----
create table public.product_barcodes (
  id         uuid primary key default gen_random_uuid(),
  variant_id uuid not null references public.product_variants(id) on delete cascade,
  barcode    text not null unique,
  label      text,
  created_at timestamptz not null default now()
);
create index product_barcodes_variant_idx on public.product_barcodes(variant_id);
create index product_barcodes_barcode_idx on public.product_barcodes(barcode);

-- Repairs --------------------------------------------------------------------
create table public.repairs (
  id            uuid primary key default gen_random_uuid(),
  ticket        bigint generated always as identity,
  customer_id   uuid references public.customers(id),
  customer_name text,
  phone         text,
  device_type   text not null,
  serial        text,
  location      text,
  issue         text,
  status        text not null default 'in_queue'
                check (status in ('in_queue','in_progress','completed','picked_up','cancelled')),
  price_cents   integer not null default 0,
  employee_id   uuid references public.profiles(id),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index repairs_status_idx on public.repairs(status);

-- Scheduling + time clock ----------------------------------------------------
create table public.shifts (
  id          uuid primary key default gen_random_uuid(),
  employee_id uuid not null references public.profiles(id) on delete cascade,
  starts_at   timestamptz not null,
  ends_at     timestamptz not null,
  note        text,
  created_at  timestamptz not null default now()
);
create index shifts_emp_idx on public.shifts(employee_id);
create index shifts_start_idx on public.shifts(starts_at);

create table public.time_entries (
  id          uuid primary key default gen_random_uuid(),
  employee_id uuid not null references public.profiles(id) on delete cascade,
  clock_in    timestamptz not null default now(),
  clock_out   timestamptz,
  created_at  timestamptz not null default now()
);
create index time_entries_emp_idx on public.time_entries(employee_id);
-- one open clock-in per employee
create unique index time_entries_open_unique on public.time_entries(employee_id) where clock_out is null;

-- Price-change review (PriceCharting sync) -----------------------------------
create table public.price_changes (
  id              uuid primary key default gen_random_uuid(),
  variant_id      uuid not null references public.product_variants(id) on delete cascade,
  old_cents       integer not null,
  suggested_cents integer not null,
  source          text not null default 'pricecharting',
  status          text not null default 'pending' check (status in ('pending','approved','reverted')),
  created_at      timestamptz not null default now(),
  reviewed_at     timestamptz,
  reviewed_by     uuid references public.profiles(id)
);
create index price_changes_status_idx on public.price_changes(status);

-- Returns linkage + manager approval -----------------------------------------
alter table public.transactions add column if not exists original_transaction_id uuid references public.transactions(id);
alter table public.transactions add column if not exists approved_by uuid references public.profiles(id);

-- Customer account merge -----------------------------------------------------
alter table public.customers add column if not exists merged_into uuid references public.customers(id);

create or replace function public.merge_customers(p_src uuid, p_dst uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_manager() then raise exception 'Only managers can merge customers'; end if;
  if p_src = p_dst then raise exception 'Cannot merge a customer into itself'; end if;

  update public.transactions set customer_id = p_dst where customer_id = p_src;
  update public.repairs      set customer_id = p_dst where customer_id = p_src;

  update public.customers d set
    store_credit_cents = d.store_credit_cents + s.store_credit_cents,
    points             = d.points + s.points,
    email_subscribed   = d.email_subscribed or s.email_subscribed,
    text_subscribed    = d.text_subscribed or s.text_subscribed
  from public.customers s
  where d.id = p_dst and s.id = p_src;

  update public.customers set store_credit_cents = 0, points = 0, merged_into = p_dst where id = p_src;
end; $$;
grant execute on function public.merge_customers(uuid, uuid) to authenticated;

-- ============================================================================
-- RLS for new tables
-- ============================================================================
alter table public.product_barcodes enable row level security;
alter table public.repairs          enable row level security;
alter table public.shifts           enable row level security;
alter table public.time_entries     enable row level security;
alter table public.price_changes    enable row level security;

create policy barcodes_staff on public.product_barcodes for all using (public.is_staff()) with check (public.is_staff());
create policy repairs_staff  on public.repairs          for all using (public.is_staff()) with check (public.is_staff());

-- Shifts: everyone reads the schedule; managers create/change it.
create policy shifts_read   on public.shifts for select using (public.is_staff());
create policy shifts_manage on public.shifts for all    using (public.is_manager()) with check (public.is_manager());

-- Time clock: punch your own; managers see everyone.
create policy time_own on public.time_entries for all
  using (employee_id = auth.uid() or public.is_manager())
  with check (employee_id = auth.uid() or public.is_manager());

-- Price changes: managers only.
create policy price_changes_mgr on public.price_changes for all using (public.is_manager()) with check (public.is_manager());

-- ============================================================================
-- Finer per-employee RLS on transactions (replaces the blanket staff policy):
-- a cashier only sees/edits their own transactions; managers/owners see all.
-- ============================================================================
drop policy if exists transactions_staff on public.transactions;
drop policy if exists items_staff        on public.transaction_items;

create policy tx_select on public.transactions for select using (employee_id = auth.uid() or public.is_manager());
create policy tx_insert on public.transactions for insert with check (employee_id = auth.uid() or public.is_manager());
create policy tx_update on public.transactions for update using (employee_id = auth.uid() or public.is_manager()) with check (employee_id = auth.uid() or public.is_manager());
create policy tx_delete on public.transactions for delete using (public.is_manager());

create policy ti_select on public.transaction_items for select
  using (exists (select 1 from public.transactions t where t.id = transaction_id and (t.employee_id = auth.uid() or public.is_manager())));
create policy ti_insert on public.transaction_items for insert
  with check (exists (select 1 from public.transactions t where t.id = transaction_id and (t.employee_id = auth.uid() or public.is_manager())));
create policy ti_update on public.transaction_items for update
  using (exists (select 1 from public.transactions t where t.id = transaction_id and (t.employee_id = auth.uid() or public.is_manager())))
  with check (exists (select 1 from public.transactions t where t.id = transaction_id and (t.employee_id = auth.uid() or public.is_manager())));
create policy ti_delete on public.transaction_items for delete
  using (exists (select 1 from public.transactions t where t.id = transaction_id and (t.employee_id = auth.uid() or public.is_manager())));

-- ============================================================================
-- Grants for the new tables (RLS still governs rows).
-- ============================================================================
grant select, insert, update, delete on all tables in schema public to authenticated;
grant usage, select on all sequences in schema public to authenticated;
