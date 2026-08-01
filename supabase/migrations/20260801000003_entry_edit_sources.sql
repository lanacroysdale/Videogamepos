-- ============================================================================
-- Entries v3: SOURCES + gated committed-entry DELETE (stock-reversing).
--
-- 1) Sources: where inventory came from — a supplier on the whole entry
--    ("this order came from VideoGamesNewYork") and an optional per-line
--    override. Plain text; the UI suggests previously-used values.
--
-- 2) product_suppliers: per-PRODUCT restock links ("distributors that sell
--    this item") — label + URL. MANAGER-ONLY at the RLS level: staff selects
--    return zero rows, so the data never even reaches their browser.
--
-- 3) revert_entry(): the only way to delete a COMMITTED entry. Managers only,
--    within 24h of commit. It REVERSES what the entry applied — quantities
--    come back down (clamped at 0 if copies already sold; the ledger records
--    what actually moved), compensating 'adjust' movements are written, then
--    the entry is deleted. Atomic. Drafts keep their existing staff delete.
-- Apply in the Supabase SQL editor (no DDL from the app).
-- ============================================================================

alter table public.inventory_entries add column if not exists supplier text;
alter table public.inventory_entry_items add column if not exists supplier text;

create table if not exists public.product_suppliers (
  id         uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products(id) on delete cascade,
  label      text not null,
  url        text,
  created_at timestamptz not null default now()
);
create index if not exists product_suppliers_product_idx on public.product_suppliers(product_id);

alter table public.product_suppliers enable row level security;
drop policy if exists product_suppliers_select on public.product_suppliers;
create policy product_suppliers_select on public.product_suppliers
  for select using (public.is_manager());
drop policy if exists product_suppliers_insert on public.product_suppliers;
create policy product_suppliers_insert on public.product_suppliers
  for insert with check (public.is_manager());
drop policy if exists product_suppliers_update on public.product_suppliers;
create policy product_suppliers_update on public.product_suppliers
  for update using (public.is_manager()) with check (public.is_manager());
drop policy if exists product_suppliers_delete on public.product_suppliers;
create policy product_suppliers_delete on public.product_suppliers
  for delete using (public.is_manager());
grant select, insert, update, delete on public.product_suppliers to authenticated;

-- Reverse + delete a committed entry. Manager-only, 24-hour window.
create or replace function public.revert_entry(p_entry_id uuid)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_entry public.inventory_entries;
  v_reversed int := 0;
  v_old int;
  v_actual int;
  r record;
begin
  if not public.is_manager() then
    raise exception 'Managers only.';
  end if;
  select * into v_entry from public.inventory_entries where id = p_entry_id for update;
  if v_entry.id is null then
    raise exception 'Entry not found';
  end if;
  if v_entry.status <> 'committed' then
    raise exception 'Only committed entries can be reverted — drafts have their own delete.';
  end if;
  if v_entry.committed_at is null or v_entry.committed_at < now() - interval '24 hours' then
    raise exception 'This entry is older than 24 hours and can no longer be deleted.';
  end if;
  for r in
    select * from public.inventory_entry_items
    where entry_id = p_entry_id and applied = true
  loop
    select quantity into v_old from public.product_variants where id = r.variant_id for update;
    if v_old is null then continue; end if;
    -- Clamp: copies sold since the entry can't go negative; the ledger
    -- records what ACTUALLY moved back out.
    v_actual := least(v_old, r.qty_added);
    if v_actual > 0 then
      update public.product_variants set quantity = v_old - v_actual where id = r.variant_id;
      insert into public.stock_movements (variant_id, delta, reason, channel, employee_id)
      values (r.variant_id, -v_actual, 'adjust', 'in_store', auth.uid());
    end if;
    v_reversed := v_reversed + 1;
  end loop;
  delete from public.inventory_entries where id = p_entry_id;
  return v_reversed;
end;
$$;
grant execute on function public.revert_entry(uuid) to authenticated;
