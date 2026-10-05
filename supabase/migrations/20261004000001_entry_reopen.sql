-- ============================================================================
-- Entries: "Back to draft" for a FINISHED entry (owner request).
--
-- Instead of deleting a finished entry outright, a manager can put it back to
-- a DRAFT to fix it. Its copies STAY IN STOCK the whole time — they are on the
-- shelf with labels, and can still be sold. Each line remembers what it has
-- already put in stock (stocked_qty on stocked_variant_id), and Finish applies
-- only the DIFFERENCE:
--   * same line, same stock row        → add / remove the qty change;
--   * condition or type changed         → the copies move from the old stock
--                                         row to the new one;
--   * line removed (or draft deleted)   → its copies come back out of stock;
--   * lines added after reopening       → added on Finish, like any draft.
-- Anything that would take copies OUT of a stock row is refused when that row
-- no longer holds them (sold or moved since) — never a negative or phantom
-- count. Unchanged lines add nothing, even if copies sold meanwhile.
--
-- Apply in the Supabase SQL editor. Safe to re-run.
-- ============================================================================

-- ---- 1. what a line already put in stock -----------------------------------
alter table public.inventory_entry_items add column if not exists stocked_qty int not null default 0;
alter table public.inventory_entry_items add column if not exists stocked_variant_id uuid
  references public.product_variants(id) on delete set null;

-- ---- 2. Back to draft -------------------------------------------------------
create or replace function public.reopen_entry(p_entry_id uuid)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_entry public.inventory_entries;
  v_lines int;
begin
  if not public.is_manager() then
    raise exception 'Managers only.';
  end if;
  select * into v_entry from public.inventory_entries where id = p_entry_id for update;
  if v_entry.id is null then
    raise exception 'Entry not found';
  end if;
  if v_entry.status <> 'committed' then
    raise exception 'This entry is already a draft.';
  end if;
  update public.inventory_entries set status = 'open', committed_at = null where id = p_entry_id;
  -- Stock untouched: each line just remembers what it already put in stock.
  update public.inventory_entry_items
     set applied = false,
         stocked_qty = case when variant_id is not null and coalesce(kind, 'stock') <> 'non_inventory' then qty_added else 0 end,
         stocked_variant_id = case when coalesce(kind, 'stock') <> 'non_inventory' then variant_id end
   where entry_id = p_entry_id and applied;
  get diagnostics v_lines = row_count;
  return v_lines;
end;
$$;
revoke all on function public.reopen_entry(uuid) from public, anon;
grant execute on function public.reopen_entry(uuid) to authenticated;

-- ---- 3. Finish: apply only what changed ------------------------------------
create or replace function public.commit_entry(p_entry_id uuid)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_entry public.inventory_entries;
  v_applied int := 0;
  v_actor uuid;
  v_on_hand int;
  v_delta int;
  v_title text;
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
  v_actor := coalesce(auth.uid(), v_entry.employee_id);
  for r in
    select * from public.inventory_entry_items
    where entry_id = p_entry_id and applied = false
    order by created_at
  loop
    if r.kind = 'non_inventory' or r.variant_id is null then
      -- Recorded for the books only: no stock row, no ledger movement.
      update public.inventory_entry_items set applied = true, stocked_qty = 0, stocked_variant_id = null where id = r.id;
      v_applied := v_applied + 1;
      continue;
    end if;
    if coalesce(r.stocked_qty, 0) > 0 then
      -- A line of a reopened entry: its stocked_qty copies are already in stock.
      select v.quantity, p.title into v_on_hand, v_title
        from public.product_variants v left join public.products p on p.id = v.product_id
       where v.id = r.stocked_variant_id for update of v;
      if r.stocked_variant_id = r.variant_id then
        v_delta := r.qty_added - r.stocked_qty;
      else
        -- Condition / type changed: the copies move to the new stock row.
        if r.stocked_variant_id is null or coalesce(v_on_hand, 0) < r.stocked_qty then
          raise exception '% — % cop% of it sold or moved since this entry went back to draft, so its condition / type can''t move. Change it back, or fix that stock by hand.',
            coalesce(v_title, 'An item'), r.stocked_qty - least(coalesce(v_on_hand, 0), r.stocked_qty),
            case when r.stocked_qty - least(coalesce(v_on_hand, 0), r.stocked_qty) = 1 then 'y' else 'ies' end;
        end if;
        update public.product_variants set quantity = quantity - r.stocked_qty where id = r.stocked_variant_id;
        insert into public.stock_movements (variant_id, delta, reason, channel, employee_id)
        values (r.stocked_variant_id, -r.stocked_qty, 'adjust', 'in_store', v_actor);
        v_delta := r.qty_added;
      end if;
      if v_delta < 0 then
        select v.quantity, p.title into v_on_hand, v_title
          from public.product_variants v left join public.products p on p.id = v.product_id
         where v.id = r.variant_id for update of v;
        if coalesce(v_on_hand, 0) < -v_delta then
          raise exception '% — only % left in stock, so the line can''t go down by %. Some copies sold since this entry went back to draft.',
            coalesce(v_title, 'An item'), coalesce(v_on_hand, 0), -v_delta;
        end if;
      end if;
      if v_delta <> 0 then
        update public.product_variants set quantity = quantity + v_delta where id = r.variant_id;
        insert into public.stock_movements (variant_id, delta, reason, channel, employee_id)
        values (r.variant_id, v_delta,
                case when v_delta < 0 then 'adjust' when r.was_new_variant then 'initial' else 'receive' end,
                'in_store', v_actor);
      end if;
    else
      update public.product_variants set quantity = quantity + r.qty_added where id = r.variant_id;
      insert into public.stock_movements (variant_id, delta, reason, channel, employee_id)
      values (r.variant_id, r.qty_added,
              case when r.was_new_variant then 'initial' else 'receive' end,
              'in_store', v_actor);
    end if;
    update public.inventory_entry_items set applied = true, stocked_qty = 0, stocked_variant_id = null where id = r.id;
    v_applied := v_applied + 1;
  end loop;
  -- Publish: every stock row this entry touches, and its listing, becomes
  -- visible — plus anything still marked pending for this entry.
  update public.product_variants set pending_entry_id = null
   where pending_entry_id is not null
     and (pending_entry_id = p_entry_id
          or id in (select variant_id from public.inventory_entry_items where entry_id = p_entry_id and variant_id is not null));
  update public.products set pending_entry_id = null
   where pending_entry_id is not null
     and (pending_entry_id = p_entry_id
          or id in (select v.product_id from public.inventory_entry_items i
                      join public.product_variants v on v.id = i.variant_id
                     where i.entry_id = p_entry_id));
  update public.inventory_entries
     set status = 'committed', committed_at = now()
   where id = p_entry_id;
  return v_applied;
end;
$$;
grant execute on function public.commit_entry(uuid) to authenticated;

-- ---- 4. removing a line that is already in stock ---------------------------
-- Removing it from the reopened draft (or deleting the whole draft — lines
-- cascade) takes its copies back out of stock. Refused if the stock row no
-- longer holds them: they sold, so the line is real history.
create or replace function public.entry_item_unstock()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_on_hand int;
  v_title text;
begin
  if coalesce(old.stocked_qty, 0) > 0 and old.stocked_variant_id is not null then
    select v.quantity, p.title into v_on_hand, v_title
      from public.product_variants v left join public.products p on p.id = v.product_id
     where v.id = old.stocked_variant_id for update of v;
    if found then
      if coalesce(v_on_hand, 0) < old.stocked_qty then
        raise exception '% — some of its copies sold since this entry went back to draft, so it can''t be removed. Lower its quantity instead, or Finish.',
          coalesce(v_title, 'An item');
      end if;
      update public.product_variants set quantity = quantity - old.stocked_qty where id = old.stocked_variant_id;
      insert into public.stock_movements (variant_id, delta, reason, channel, employee_id)
      values (old.stocked_variant_id, -old.stocked_qty, 'adjust', 'in_store', auth.uid());
    end if;
  end if;
  return old;
end;
$$;
revoke execute on function public.entry_item_unstock() from public, anon, authenticated;
drop trigger if exists trg_entry_item_unstock on public.inventory_entry_items;
create trigger trg_entry_item_unstock before delete on public.inventory_entry_items
  for each row execute function public.entry_item_unstock();
