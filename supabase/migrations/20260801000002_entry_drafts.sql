-- ============================================================================
-- Inventory entry DRAFTS: entries become staged drafts that touch NOTHING
-- until committed.
--
-- New model (owner spec, 2026-07-31): starting an entry opens a clean
-- trade-in-style screen; added lines are STAGED (applied=false) — no quantity
-- bump, no ledger write, nothing published. The draft autosaves (rows land in
-- inventory_entry_items immediately), survives leaving the page, and shows in
-- /entries with Resume / Delete. "Finish" runs commit_entry(), which applies
-- every staged line (quantity + stock_movements) and commits — atomically.
--
-- Back-compat: legacy lines were applied AT RECEIVE TIME, so `applied`
-- defaults TRUE — commit_entry() only applies applied=false rows, and a
-- mixed-history entry can never double-apply stock.
--
-- Also: order_total_cents on the entry (owner enters the invoice/order total;
-- the screen shows how much of it is still unassigned to line costs).
-- Apply in the Supabase SQL editor (no DDL from the app).
-- ============================================================================

alter table public.inventory_entries add column if not exists order_total_cents int;

alter table public.inventory_entry_items add column if not exists applied boolean not null default true;

-- Drafts are editable: staff may UPDATE/DELETE lines while the parent entry is
-- still open. Committed history stays frozen (no row matches these policies;
-- the manager-only delete policy from the entries migration still applies).
drop policy if exists inventory_entry_items_update on public.inventory_entry_items;
create policy inventory_entry_items_update on public.inventory_entry_items
  for update using (
    public.is_staff() and exists (
      select 1 from public.inventory_entries e where e.id = entry_id and e.status = 'open'
    )
  ) with check (public.is_staff());

drop policy if exists inventory_entry_items_delete_open on public.inventory_entry_items;
create policy inventory_entry_items_delete_open on public.inventory_entry_items
  for delete using (
    public.is_staff() and exists (
      select 1 from public.inventory_entries e where e.id = entry_id and e.status = 'open'
    )
  );

-- Staff may delete their OPEN drafts (lines cascade). Committed entries remain
-- manager-delete-only via the existing policy.
drop policy if exists inventory_entries_delete_open on public.inventory_entries;
create policy inventory_entries_delete_open on public.inventory_entries
  for delete using (public.is_staff() and status = 'open');

-- Apply a draft atomically: bump quantities, write the ledger, flip the lines
-- to applied, commit the entry. SECURITY DEFINER with an explicit staff guard
-- so the whole batch succeeds or fails as one — two stations can't half-apply.
create or replace function public.commit_entry(p_entry_id uuid)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_entry public.inventory_entries;
  v_applied int := 0;
  r record;
begin
  if not public.is_staff() then
    raise exception 'staff only';
  end if;
  select * into v_entry from public.inventory_entries where id = p_entry_id for update;
  if v_entry.id is null then
    raise exception 'Entry not found';
  end if;
  if v_entry.status <> 'open' then
    raise exception 'Entry already committed.';
  end if;
  for r in
    select * from public.inventory_entry_items
    where entry_id = p_entry_id and applied = false
    order by created_at
  loop
    update public.product_variants set quantity = quantity + r.qty_added where id = r.variant_id;
    insert into public.stock_movements (variant_id, delta, reason, channel, employee_id)
    values (r.variant_id, r.qty_added,
            case when r.was_new_variant then 'initial' else 'receive' end,
            'in_store', coalesce(auth.uid(), v_entry.employee_id));
    update public.inventory_entry_items set applied = true where id = r.id;
    v_applied := v_applied + 1;
  end loop;
  update public.inventory_entries
     set status = 'committed', committed_at = now()
   where id = p_entry_id;
  return v_applied;
end;
$$;
grant execute on function public.commit_entry(uuid) to authenticated;
