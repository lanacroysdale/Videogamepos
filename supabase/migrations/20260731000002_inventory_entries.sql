-- ============================================================================
-- Inventory ENTRIES: receiving sessions with reprintable history.
--
-- An entry is a lazy session — created on the first receive, lines append as
-- staff enter stock, and "Finish & print" commits it and opens the label print
-- dialog. Committed entries power the Entries history page ("what arrived in
-- Entry #142?") and label REPRINTS, and price_cents_at_entry powers the
-- "price changed since this batch" hint without a price-history table.
-- The receive paths also start writing stock_movements (the ledger existed but
-- nothing wrote it until now).
-- Apply in the Supabase SQL editor (no DDL from the app).
-- ============================================================================

create table if not exists public.inventory_entries (
  id           uuid primary key default gen_random_uuid(),
  human_id     bigint generated always as identity,   -- "Entry #142"
  employee_id  uuid references public.profiles(id) on delete set null,
  source       text not null default 'manual' check (source in ('manual','trade_in','ebay_import','adjustment')),
  status       text not null default 'open' check (status in ('open','committed')),
  note         text,
  created_at   timestamptz not null default now(),
  committed_at timestamptz
);
create index if not exists inventory_entries_status_idx on public.inventory_entries(status, created_at desc);

create table if not exists public.inventory_entry_items (
  id                   uuid primary key default gen_random_uuid(),
  entry_id             uuid not null references public.inventory_entries(id) on delete cascade,
  variant_id           uuid not null references public.product_variants(id) on delete cascade,
  qty_added            int not null check (qty_added > 0),
  unit_cost_cents      int,                            -- optional cost at receive
  price_cents_at_entry int not null default 0,         -- price snapshot (history display)
  was_new_variant      boolean not null default false, -- first stock vs restock
  created_at           timestamptz not null default now()
);
create index if not exists inv_entry_items_entry_idx   on public.inventory_entry_items(entry_id);
create index if not exists inv_entry_items_variant_idx on public.inventory_entry_items(variant_id, created_at desc);

-- RLS: any staff can create/read/append entries (receiving is a floor task);
-- no deletes below manager. Same shape as the menu tables.
do $$
declare t text;
begin
  foreach t in array array['inventory_entries','inventory_entry_items'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists %I on public.%I', t||'_read', t);
    execute format('create policy %I on public.%I for select using (public.is_staff())', t||'_read', t);
    execute format('drop policy if exists %I on public.%I', t||'_insert', t);
    execute format('create policy %I on public.%I for insert with check (public.is_staff())', t||'_insert', t);
    execute format('drop policy if exists %I on public.%I', t||'_update', t);
    execute format('drop policy if exists %I on public.%I', t||'_delete', t);
    execute format('create policy %I on public.%I for delete using (public.is_manager())', t||'_delete', t);
    execute format('grant select, insert, update, delete on public.%I to authenticated', t);
  end loop;
end $$;

-- Committed history is immutable to staff: entries may only be UPDATED while
-- still open (that's how commitEntry flips open→committed; USING evaluates the
-- OLD row). Entry ITEMS get no staff update at all — receiving is append-only,
-- so a cashier can't rewrite qty/cost on past entries via PostgREST.
create policy inventory_entries_update on public.inventory_entries
  for update using (public.is_staff() and status = 'open') with check (public.is_staff());

-- Atomic stock increment for receiving. supabase-js can't express relative
-- updates, and read-then-write from two stations (the entries feature actively
-- encourages sharing one open entry across devices) would lose receives while
-- the ledger recorded both. SECURITY INVOKER: the caller's own RLS applies
-- (staff already manage product_variants).
create or replace function public.receive_stock(p_variant_id uuid, p_qty int)
returns int language sql as $$
  update public.product_variants
     set quantity = quantity + greatest(1, p_qty)
   where id = p_variant_id
   returning quantity;
$$;
grant execute on function public.receive_stock(uuid, int) to authenticated;

-- stock_movements was already staff-insertable at creation; the receive paths
-- start writing it now (this re-grant is a harmless no-op kept for clarity).
drop policy if exists stock_movements_insert_staff on public.stock_movements;
create policy stock_movements_insert_staff on public.stock_movements for insert with check (public.is_staff());
grant insert on public.stock_movements to authenticated;
