-- ============================================================================
-- Entries: stage an imported row ATOMICALLY + lock merges against "Finish".
--
-- 1) stage_import_line(): claims the row's import key, inserts (or merges into)
--    the draft line, and records what the key became, all in ONE transaction.
--    Before, those were separate requests: a serverless timeout landing between
--    "line written" and "key recorded" left a claim that a later retry had to
--    guess about, and could re-stage the row (doubled qty). Now a retry sees
--    either nothing (redo) or the recorded line (replay).
--
-- 2) The open-draft guard trigger from 20260929000001 now also runs on UPDATE,
--    so an import merging extra copies into a line waits for a concurrent
--    Finish and is refused afterwards (instead of raising qty on a line that
--    was already applied to stock). Finish itself runs as the owner and is
--    exempt, as before.
--
-- Apply in the Supabase SQL editor (no DDL from the app). Safe to re-run.
-- ============================================================================

drop trigger if exists trg_entry_items_require_open on public.inventory_entry_items;
create trigger trg_entry_items_require_open before insert or update on public.inventory_entry_items
  for each row execute function public.entry_items_require_open();

create or replace function public.stage_import_line(
  p_entry uuid, p_key text, p_variant uuid, p_product uuid, p_created text,
  p_qty int, p_cost int, p_price int, p_was_new boolean
) returns jsonb
language plpgsql
as $$
declare
  v_prev public.inventory_entry_import_keys;
  v_qty int := greatest(1, coalesce(p_qty, 1));
  v_line_id uuid;
  v_line_qty int;
  v_line_cost int;
  v_merged boolean := false;
  v_n int;
begin
  select * into v_prev from public.inventory_entry_import_keys where entry_id = p_entry and import_key = p_key;
  if found and v_prev.item_id is not null then
    return jsonb_build_object('replay', true, 'item_id', v_prev.item_id, 'variant_id', v_prev.variant_id,
                              'product_id', v_prev.product_id, 'created', v_prev.created);
  end if;
  -- A claim with no line can only be left by the old two-step path: take it over.
  if found then
    delete from public.inventory_entry_import_keys where entry_id = p_entry and import_key = p_key;
  end if;
  -- Concurrent duplicate → unique violation → this call rolls back; the
  -- caller's retry then replays.
  insert into public.inventory_entry_import_keys (entry_id, import_key) values (p_entry, p_key);

  select id, qty_added, unit_cost_cents into v_line_id, v_line_qty, v_line_cost
    from public.inventory_entry_items
   where entry_id = p_entry and variant_id = p_variant
   order by created_at limit 1
   for update;
  if found then
    update public.inventory_entry_items
       set qty_added = v_line_qty + v_qty,
           unit_cost_cents = case
             when p_cost is null then v_line_cost
             when v_line_cost is null then p_cost
             else round((v_line_cost::numeric * v_line_qty + p_cost::numeric * v_qty) / (v_line_qty + v_qty))::int
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
    values (p_entry, p_variant, v_qty, p_cost, coalesce(p_price, 0), coalesce(p_was_new, false), false)
    returning id into v_line_id;
  end if;

  update public.inventory_entry_import_keys
     set item_id = v_line_id, variant_id = p_variant, product_id = p_product, created = coalesce(p_created, '')
   where entry_id = p_entry and import_key = p_key;

  return jsonb_build_object('replay', false, 'item_id', v_line_id, 'merged', v_merged);
end;
$$;

grant execute on function public.stage_import_line(uuid, text, uuid, uuid, text, int, int, int, boolean) to authenticated;
