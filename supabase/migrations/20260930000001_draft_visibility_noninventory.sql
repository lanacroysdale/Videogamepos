-- ============================================================================
-- Entry drafts: (1) nothing a draft creates is visible until Finish;
--               (2) non-inventory lines (bulk lots etc.) for the books.
--
-- 1) products / product_variants get pending_entry_id: set when a DRAFT creates
--    the listing or stock row (CSV import, "New product" on the entry screen,
--    a condition change). The app hides pending rows everywhere (inventory,
--    search, trade-in, checkout, website). commit_entry clears it for every
--    row the entry touches — in the same transaction that adds the stock.
--    Deleting a draft, or removing a line, deletes the pending rows that only
--    existed for it (never a row with stock, sales, or another entry's lines).
--    Plain uuid, NOT a foreign key: a cascading FK action could clear it (and
--    publish a scrapped draft's rows) before the cleanup runs.
--
-- 2) inventory_entry_items.kind: 'stock' (as before) | 'non_inventory' — a
--    description + qty + what was paid, no stock row. Finish records it and
--    skips the stock step; it counts in the entry's Paid total and history.
--    stage_import_noninventory() stages one from a CSV import with the same
--    replay-safe import key as stock rows.
--
-- Also backfills: listings / stock rows that currently OPEN drafts created
-- (and nothing else uses) become pending, so they disappear until Finish.
-- Apply in the Supabase SQL editor (no DDL from the app). Safe to re-run.
-- ============================================================================

-- ---- 1. columns -------------------------------------------------------------
alter table public.products         add column if not exists pending_entry_id uuid;
alter table public.product_variants add column if not exists pending_entry_id uuid;
create index if not exists products_pending_idx on public.products(pending_entry_id) where pending_entry_id is not null;
create index if not exists variants_pending_idx on public.product_variants(pending_entry_id) where pending_entry_id is not null;

alter table public.inventory_entry_items add column if not exists kind text not null default 'stock';
alter table public.inventory_entry_items add column if not exists description text;
alter table public.inventory_entry_items alter column variant_id drop not null;
alter table public.inventory_entry_items drop constraint if exists inventory_entry_items_kind_check;
alter table public.inventory_entry_items add constraint inventory_entry_items_kind_check check (
  (kind = 'stock' and variant_id is not null)
  or (kind = 'non_inventory' and variant_id is null and coalesce(btrim(description), '') <> '')
);

-- ---- 2. backfill: hide what open drafts created ----------------------------
update public.product_variants v
   set pending_entry_id = i.entry_id
  from public.inventory_entry_items i
  join public.inventory_entries e on e.id = i.entry_id and e.status = 'open'
 where i.variant_id = v.id
   and i.was_new_variant
   and v.quantity = 0
   and v.pending_entry_id is null
   and not exists (select 1 from public.inventory_entry_items o where o.variant_id = v.id and o.entry_id <> i.entry_id)
   and not exists (select 1 from public.transaction_items t where t.variant_id = v.id);

update public.products p
   set pending_entry_id = x.entry_id
  from (
    select v.product_id, min(v.pending_entry_id::text)::uuid as entry_id
      from public.product_variants v
     group by v.product_id
    having bool_and(v.pending_entry_id is not null)
       and count(distinct v.pending_entry_id) = 1
  ) x
 where p.id = x.product_id
   and p.pending_entry_id is null;

-- ---- 3. Finish: skip non-inventory stock, then publish ---------------------
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
    if r.kind = 'non_inventory' or r.variant_id is null then
      -- Recorded for the books only: no stock row, no ledger movement.
      update public.inventory_entry_items set applied = true where id = r.id;
      v_applied := v_applied + 1;
      continue;
    end if;
    update public.product_variants set quantity = quantity + r.qty_added where id = r.variant_id;
    insert into public.stock_movements (variant_id, delta, reason, channel, employee_id)
    values (r.variant_id, r.qty_added,
            case when r.was_new_variant then 'initial' else 'receive' end,
            'in_store', coalesce(auth.uid(), v_entry.employee_id));
    update public.inventory_entry_items set applied = true where id = r.id;
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

-- ---- 4. cleanup of pending rows nobody uses any more -----------------------
-- A pending stock row is disposable when: pending for THIS entry, no stock,
-- no line on any other entry, never sold.
create or replace function public.discard_pending_for_entry(p_entry uuid, p_variant uuid default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_prod uuid;
begin
  -- For a single removed line, only ITS stock row and ITS listing are
  -- candidates — never another listing this draft is creating right now.
  if p_variant is not null then
    select product_id into v_prod from public.product_variants where id = p_variant;
  end if;
  delete from public.product_variants v
   where v.pending_entry_id = p_entry
     and (p_variant is null or v.id = p_variant)
     and v.quantity = 0
     and not exists (select 1 from public.inventory_entry_items o where o.variant_id = v.id and o.entry_id <> p_entry)
     and not exists (select 1 from public.inventory_entry_items o where o.variant_id = v.id and o.entry_id = p_entry and p_variant is not null)
     and not exists (select 1 from public.transaction_items t where t.variant_id = v.id);
  delete from public.products p
   where p.pending_entry_id = p_entry
     and (p_variant is null or p.id = v_prod)
     and not exists (select 1 from public.product_variants v where v.product_id = p.id);
end;
$$;

-- Only the triggers below may run it (functions are callable by everyone by default).
revoke execute on function public.discard_pending_for_entry(uuid, uuid) from public, anon, authenticated;

-- Removing a line from a draft: its pending stock row goes if nothing else uses it.
create or replace function public.entry_item_deleted_cleanup()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.variant_id is not null and not old.applied then
    perform public.discard_pending_for_entry(old.entry_id, old.variant_id);
  end if;
  return old;
end;
$$;
drop trigger if exists trg_entry_item_deleted_cleanup on public.inventory_entry_items;
create trigger trg_entry_item_deleted_cleanup after delete on public.inventory_entry_items
  for each row execute function public.entry_item_deleted_cleanup();

-- Deleting a draft: everything pending for it that nothing else uses goes too
-- (runs BEFORE the cascade, while pending_entry_id still says whose it was).
create or replace function public.entry_deleted_cleanup()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.status = 'open' then
    perform public.discard_pending_for_entry(old.id, null);
  end if;
  return old;
end;
$$;
drop trigger if exists trg_entry_deleted_cleanup on public.inventory_entries;
create trigger trg_entry_deleted_cleanup before delete on public.inventory_entries
  for each row execute function public.entry_deleted_cleanup();

-- ---- 5. CSV import of a non-inventory line (replay-safe, one transaction) ---
create or replace function public.stage_import_noninventory(
  p_entry uuid, p_key text, p_description text, p_qty int, p_cost int
) returns jsonb
language plpgsql
as $$
declare
  v_prev public.inventory_entry_import_keys;
  v_line_id uuid;
begin
  select * into v_prev from public.inventory_entry_import_keys where entry_id = p_entry and import_key = p_key;
  if found and v_prev.item_id is not null then
    return jsonb_build_object('replay', true, 'item_id', v_prev.item_id);
  end if;
  if found then
    delete from public.inventory_entry_import_keys where entry_id = p_entry and import_key = p_key;
  end if;
  insert into public.inventory_entry_import_keys (entry_id, import_key) values (p_entry, p_key);
  insert into public.inventory_entry_items
    (entry_id, variant_id, kind, description, qty_added, unit_cost_cents, price_cents_at_entry, was_new_variant, applied)
  values (p_entry, null, 'non_inventory', left(btrim(p_description), 200), greatest(1, coalesce(p_qty, 1)), p_cost, 0, false, false)
  returning id into v_line_id;
  update public.inventory_entry_import_keys set item_id = v_line_id where entry_id = p_entry and import_key = p_key;
  return jsonb_build_object('replay', false, 'item_id', v_line_id);
end;
$$;
grant execute on function public.stage_import_noninventory(uuid, text, text, int, int) to authenticated;
