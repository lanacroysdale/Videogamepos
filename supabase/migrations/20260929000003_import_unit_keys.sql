-- ============================================================================
-- Collection import: one key PER COPY, so a re-import adds only what's new.
--
-- stage_import_line() (20260929000002) keyed a sheet row as a whole, including
-- its quantity. Re-importing an edited sheet where a row went from qty 1 to 2
-- then looked like a brand-new row and added BOTH copies again (draft: 3).
--
-- Now each copy has its own key (<row key>#1, #2, …). The function claims only
-- the copies not already on the draft and adds exactly that many: qty 1 → 2
-- adds 1; a plain retry adds 0 (replay). Same signature, drop-in replacement,
-- still one transaction.
--
-- Apply in the Supabase SQL editor (no DDL from the app). Safe to re-run.
-- ============================================================================

create or replace function public.stage_import_line(
  p_entry uuid, p_key text, p_variant uuid, p_product uuid, p_created text,
  p_qty int, p_cost int, p_price int, p_was_new boolean
) returns jsonb
language plpgsql
as $$
declare
  v_qty int := greatest(1, coalesce(p_qty, 1));
  v_new int := 0;
  v_first public.inventory_entry_import_keys;
  v_have boolean := false;
  v_line_id uuid;
  v_line_qty int;
  v_line_cost int;
  v_merged boolean := false;
  v_n int;
  k int;
begin
  -- Claim each copy's key that isn't on the draft yet. A key left without a
  -- line (only the old non-atomic path could do that) is taken over.
  for k in 1..v_qty loop
    delete from public.inventory_entry_import_keys
     where entry_id = p_entry and import_key = p_key || '#' || k and item_id is null;
    insert into public.inventory_entry_import_keys (entry_id, import_key)
    values (p_entry, p_key || '#' || k)
    on conflict (entry_id, import_key) do nothing;
    get diagnostics v_n = row_count;
    v_new := v_new + v_n;
  end loop;

  if v_new = 0 then
    -- Every copy was already staged: replay the first one's record.
    select * into v_first from public.inventory_entry_import_keys
     where entry_id = p_entry and import_key = p_key || '#1';
    return jsonb_build_object('replay', true, 'item_id', v_first.item_id, 'variant_id', v_first.variant_id,
                              'product_id', v_first.product_id, 'created', v_first.created, 'staged', 0, 'already', v_qty);
  end if;

  select id, qty_added, unit_cost_cents into v_line_id, v_line_qty, v_line_cost
    from public.inventory_entry_items
   where entry_id = p_entry and variant_id = p_variant
   order by created_at limit 1
   for update;
  v_have := found;
  if v_have then
    update public.inventory_entry_items
       set qty_added = v_line_qty + v_new,
           unit_cost_cents = case
             when p_cost is null then v_line_cost
             when v_line_cost is null then p_cost
             else round((v_line_cost::numeric * v_line_qty + p_cost::numeric * v_new) / (v_line_qty + v_new))::int
           end
     where id = v_line_id;
    get diagnostics v_n = row_count;
    if v_n = 0 then
      raise exception 'That draft was finished on another station — nothing was added.' using errcode = 'P0001';
    end if;
    v_merged := true;
  else
    insert into public.inventory_entry_items
      (entry_id, variant_id, qty_added, unit_cost_cents, price_cents_at_entry, was_new_variant, applied)
    values (p_entry, p_variant, v_new, p_cost, coalesce(p_price, 0), coalesce(p_was_new, false), false)
    returning id into v_line_id;
  end if;

  -- Record every copy claimed in THIS call (still null) against the line.
  update public.inventory_entry_import_keys
     set item_id = v_line_id, variant_id = p_variant, product_id = p_product, created = coalesce(p_created, '')
   where entry_id = p_entry and item_id is null
     and import_key in (select p_key || '#' || g from generate_series(1, v_qty) g);

  return jsonb_build_object('replay', false, 'item_id', v_line_id, 'merged', v_merged, 'staged', v_new, 'already', v_qty - v_new);
end;
$$;

grant execute on function public.stage_import_line(uuid, text, uuid, uuid, text, int, int, int, boolean) to authenticated;
