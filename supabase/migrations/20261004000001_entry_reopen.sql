-- ============================================================================
-- Entries: "Back to draft" for a FINISHED entry (owner request).
--
-- Instead of deleting a finished entry outright, a manager can put it back to
-- a DRAFT within 24 hours of finishing it:
--   * every copy it added comes back OUT of stock (ledger: an 'adjust' row);
--   * its lines are staged again (applied = false) — fix them and Finish
--     again, or delete the draft (which discards what it created, like any
--     draft);
--   * the stock rows / listings it CREATED are hidden again until Finish.
-- Refused if any copy it added has been sold or moved since (a draft would
-- add it again on Finish).
--
-- Apply in the Supabase SQL editor. Safe to re-run.
-- ============================================================================

create or replace function public.reopen_entry(p_entry_id uuid)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_entry public.inventory_entries;
  v_lines int := 0;
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
    raise exception 'This entry is already a draft.';
  end if;
  if v_entry.committed_at is null or v_entry.committed_at < now() - interval '24 hours' then
    raise exception 'This entry was finished more than 24 hours ago and can no longer go back to a draft.';
  end if;

  -- Lock the stock rows it touched, then check every copy is still there.
  perform 1 from public.product_variants
   where id in (select variant_id from public.inventory_entry_items where entry_id = p_entry_id and applied and variant_id is not null)
   for update;
  for r in
    select i.variant_id, sum(i.qty_added)::int as qty, max(v.quantity) as on_hand
      from public.inventory_entry_items i
      join public.product_variants v on v.id = i.variant_id
     where i.entry_id = p_entry_id and i.applied and i.variant_id is not null
       and coalesce(i.kind, 'stock') <> 'non_inventory'
     group by i.variant_id
  loop
    if coalesce(r.on_hand, 0) < r.qty then
      raise exception 'Some of the copies on this entry were sold or moved since it was finished — it can''t go back to a draft.';
    end if;
  end loop;

  -- A draft again first (its lines may then be edited), then take the stock back out.
  update public.inventory_entries set status = 'open', committed_at = null where id = p_entry_id;
  for r in
    select * from public.inventory_entry_items where entry_id = p_entry_id and applied order by created_at
  loop
    if r.variant_id is not null and coalesce(r.kind, 'stock') <> 'non_inventory' then
      update public.product_variants set quantity = quantity - r.qty_added where id = r.variant_id;
      insert into public.stock_movements (variant_id, delta, reason, channel, employee_id)
      values (r.variant_id, -r.qty_added, 'adjust', 'in_store', auth.uid());
    end if;
    update public.inventory_entry_items set applied = false where id = r.id;
    v_lines := v_lines + 1;
  end loop;

  -- Hide again what it created: a stock row it made that now holds nothing
  -- and nothing else uses; a listing whose every row is now hidden for it.
  update public.product_variants v set pending_entry_id = p_entry_id
   where v.quantity = 0
     and v.id in (select variant_id from public.inventory_entry_items
                   where entry_id = p_entry_id and was_new_variant and variant_id is not null)
     and not exists (select 1 from public.inventory_entry_items o where o.variant_id = v.id and o.entry_id <> p_entry_id)
     and not exists (select 1 from public.transaction_items t where t.variant_id = v.id);
  update public.products p set pending_entry_id = p_entry_id
   where p.id in (select v.product_id from public.product_variants v where v.pending_entry_id = p_entry_id)
     and not exists (select 1 from public.product_variants v
                      where v.product_id = p.id and v.pending_entry_id is distinct from p_entry_id);
  return v_lines;
end;
$$;

revoke all on function public.reopen_entry(uuid) from public, anon;
grant execute on function public.reopen_entry(uuid) to authenticated;
