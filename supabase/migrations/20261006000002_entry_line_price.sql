-- ============================================================================
-- 1) Entries: a price typed on a DRAFT line belongs to that line until Finish.
--
--    Before, the line's Price $ was written straight onto the stock row the
--    line pointed at. Scan a game (the line lands on its Great copy), type a
--    lower price, THEN change the line to Fair: the Great copies on the shelf
--    had already been re-priced. Now the typed price waits on the line
--    (price_set_cents, typed at price_set_at) and travels with the line when
--    its condition changes. Finish gives each stock row the price typed LAST
--    on any of its lines — inside Finish's own transaction, so a Finish that
--    is refused (copies sold since…) changes no price at all. A line moved
--    to a condition the listing doesn't have yet starts that new row at its
--    typed price. Finish clears them (applied once; a later Back to draft
--    never re-applies them).
--
-- 2) ⚡ Quick adds: stock added outside an entry (＋ Add product, Receive…)
--    is recorded on the employee's finished "⚡ Quick adds" entry for the day.
--    record_quick_add() finds-or-creates that entry and adds the line in ONE
--    transaction, serialized per employee + day — two stations can't create
--    two entries for the day, and a failed line leaves nothing behind.
--
-- Apply in the Supabase SQL editor. Safe to re-run.
-- ============================================================================

-- ---- 1. the typed line price ------------------------------------------------
alter table public.inventory_entry_items add column if not exists price_set_cents int;
alter table public.inventory_entry_items add column if not exists price_set_at timestamptz;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'inventory_entry_items_price_set_nonneg') then
    alter table public.inventory_entry_items
      add constraint inventory_entry_items_price_set_nonneg check (price_set_cents is null or price_set_cents >= 0);
  end if;
end $$;

-- Finish (from 20261004000001) + the typed prices.
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
  v_price int;
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
    for update
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
          raise exception '% — % cop% of it sold or moved since this entry was finished, so its condition / type can''t move. Change it back, or fix that stock by hand.',
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
          raise exception '% — only % left in stock, so the line can''t go down by % (copies sold since this entry was finished).',
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
    -- The stock row's new price: the one typed LAST on any of this draft's
    -- lines on that row (they're cleared only after the loop, so every line
    -- of the row sees the same answer).
    select i.price_set_cents into v_price
      from public.inventory_entry_items i
     where i.entry_id = p_entry_id and i.variant_id = r.variant_id and i.price_set_cents is not null
     order by i.price_set_at desc nulls last, i.created_at desc
     limit 1;
    if v_price is not null then
      update public.product_variants set price_cents = v_price where id = r.variant_id;
    end if;
    update public.inventory_entry_items
       set applied = true, stocked_qty = 0, stocked_variant_id = null,
           -- The batch's price. Copies of a reopened line that moved to
           -- another row get fresh labels: that row's price. One whose copies
           -- already carry labels on this same row keeps the old one, so
           -- 📥 Entries flags "price changed since this batch" for re-labelling.
           price_cents_at_entry = case
             when coalesce(r.stocked_qty, 0) > 0 and r.stocked_variant_id is distinct from r.variant_id
               then (select v.price_cents from public.product_variants v where v.id = r.variant_id)
             when v_price is null or (coalesce(r.stocked_qty, 0) > 0 and r.stocked_variant_id = r.variant_id)
               then price_cents_at_entry
             else v_price end
     where id = r.id;
    v_applied := v_applied + 1;
  end loop;
  -- Typed prices are applied: the lines forget them.
  update public.inventory_entry_items set price_set_cents = null, price_set_at = null
   where entry_id = p_entry_id and price_set_cents is not null;
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
     set status = 'committed', committed_at = now(), reopened_at = null
   where id = p_entry_id;
  return v_applied;
end;
$$;
grant execute on function public.commit_entry(uuid) to authenticated;

-- ---- 2. ⚡ Quick adds --------------------------------------------------------
-- One call per quick add: the stock itself was already applied by the app.
-- p_variant null + p_kind 'non_inventory' + p_description = a bulk lot etc.
create or replace function public.record_quick_add(
  p_day date,
  p_variant uuid,
  p_qty int,
  p_cost int,
  p_price int,
  p_was_new boolean,
  p_kind text default 'stock',
  p_description text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_day date := coalesce(p_day, current_date);
  v_entry public.inventory_entries;
begin
  if v_uid is null or not public.is_staff() then
    raise exception 'staff only';
  end if;
  if coalesce(p_qty, 0) <= 0 then
    raise exception 'Nothing to record (quantity must be at least 1).';
  end if;
  -- One at a time per employee + day: no duplicate "⚡ Quick adds" entries.
  perform pg_advisory_xact_lock(hashtext('quick-add:' || v_uid::text || ':' || v_day::text));
  select * into v_entry from public.inventory_entries
   where employee_id = v_uid and status = 'committed' and note = '⚡ Quick adds' and received_on = v_day
   order by created_at desc
   limit 1
   for update;
  if v_entry.id is null then
    insert into public.inventory_entries (employee_id, source, note, status, committed_at, received_on)
    values (v_uid, 'manual', '⚡ Quick adds', 'committed', now(), v_day)
    returning * into v_entry;
  end if;
  insert into public.inventory_entry_items
    (entry_id, variant_id, kind, description, qty_added, unit_cost_cents, price_cents_at_entry, was_new_variant, applied)
  values
    (v_entry.id, p_variant, coalesce(p_kind, 'stock'), p_description, p_qty,
     case when p_cost is null then null else greatest(0, p_cost) end, greatest(0, coalesce(p_price, 0)), coalesce(p_was_new, false), true);
  return jsonb_build_object('id', v_entry.id, 'human_id', v_entry.human_id);
end;
$$;
revoke all on function public.record_quick_add(date, uuid, int, int, int, boolean, text, text) from public, anon;
grant execute on function public.record_quick_add(date, uuid, int, int, int, boolean, text, text) to authenticated;

-- Check: the column and the function are there (expect 2 rows).
select 'column' as what, column_name as name from information_schema.columns
 where table_schema = 'public' and table_name = 'inventory_entry_items' and column_name = 'price_set_cents'
union all
select 'function', proname from pg_proc where proname = 'record_quick_add';
