-- Checkout saves as ONE database transaction.
--
-- A sale used to be written in several separate requests (sale row, delete
-- old lines, insert new lines, stock one variant at a time). A dropped
-- connection, a function time-out or two screens saving the same sale could
-- leave a sale with no lines, lines twice, a day recorded twice, or stock
-- taken out twice. save_sale() does the whole save — header, lines and (on
-- completion) stock — atomically, under the caller's own RLS (security
-- invoker), and is safe to retry:
--   * a new cart carries the register's client_ref → a retry after a lost
--     response finds that sale instead of creating a second one;
--   * an already-completed sale is never written again (state 'completed');
--   * p_expected = the line ids the register last loaded / saved → if the
--     sale changed on another screen meanwhile, nothing is overwritten
--     (state 'changed') — unless the newest write is this register's own
--     save whose answer was lost (p_prev_refs = its unanswered save ids).
-- The app falls back to its old path until this is applied.
-- undo_sale() (below) reopens a sale completed the same day.

-- Columns the function writes (all shipped earlier; repeated so the
-- function can never fail on a missing one).
alter table public.transaction_items add column if not exists department text;
alter table public.transaction_items add column if not exists inventory_type text;
alter table public.transaction_items add column if not exists region text;
alter table public.transactions add column if not exists is_tab boolean not null default false;

-- Each line's place in the cart (scan order) — a held sale reopens in the
-- order it was rung up (newest on top), and Sales lists it that way.
alter table public.transaction_items add column if not exists line_no int;

alter table public.transactions add column if not exists client_ref uuid;
alter table public.transactions add column if not exists last_save_ref uuid;
create unique index if not exists transactions_client_ref_key
  on public.transactions (client_ref) where client_ref is not null;

drop function if exists public.save_sale(uuid, uuid, text, jsonb, jsonb, uuid[]);
create or replace function public.save_sale(
  p_id        uuid,     -- the open sale being saved; null = a new one
  p_client_ref uuid,    -- the register's id for this cart (null = none)
  p_status    text,     -- 'open' | 'completed'
  p_fields    jsonb,    -- customer_id, note (the sale's name), subtotal/discount/total/cash/card cents
  p_items     jsonb,    -- lines exactly as stored
  p_expected  uuid[],   -- line ids the register last saw; null = don't check
  p_save_ref  uuid,     -- this save attempt's id
  p_prev_refs uuid[]    -- this register's earlier attempts that got no answer
) returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  t record;
  v_id uuid := p_id;
  v_human bigint;
  cur_ids uuid[];
  exp_ids uuid[];
begin
  if p_status not in ('open', 'completed') then
    raise exception 'save_sale: bad status %', p_status;
  end if;

  if v_id is null and p_client_ref is not null then
    select id into v_id from transactions where client_ref = p_client_ref;
  end if;

  <<again>>
  loop

  if v_id is not null then
    select id, status, is_tab, human_id, last_save_ref into t from transactions where id = v_id for update;
    if not found then
      return jsonb_build_object('ok', false, 'state', 'missing');
    end if;
    if t.is_tab then
      return jsonb_build_object('ok', false, 'state', 'tab', 'human_id', t.human_id);
    end if;
    if t.status <> 'open' then
      return jsonb_build_object('ok', false, 'state', t.status, 'id', t.id, 'human_id', t.human_id);
    end if;
    if p_expected is not null
       and not (t.last_save_ref is not null and t.last_save_ref = any(coalesce(p_prev_refs, '{}'))) then
      select coalesce(array_agg(id order by id), '{}') into cur_ids from transaction_items where transaction_id = v_id;
      select coalesce(array_agg(x order by x), '{}') into exp_ids from unnest(p_expected) as x;
      if cur_ids <> exp_ids then
        return jsonb_build_object('ok', false, 'state', 'changed', 'id', t.id, 'human_id', t.human_id);
      end if;
    end if;
    v_human := t.human_id;
    delete from transaction_items where transaction_id = v_id;
    update transactions set
      customer_id    = nullif(p_fields->>'customer_id', '')::uuid,
      -- The name only when the register sent one (a name set in Sales stays).
      note           = case when p_fields ? 'note' then nullif(p_fields->>'note', '') else note end,
      status         = p_status,
      subtotal_cents = (p_fields->>'subtotal_cents')::int,
      discount_cents = (p_fields->>'discount_cents')::int,
      total_cents    = (p_fields->>'total_cents')::int,
      cash_cents     = (p_fields->>'cash_cents')::int,
      card_cents     = (p_fields->>'card_cents')::int,
      completed_at   = case when p_status = 'completed' then now() else null end,
      -- The cart that saved it last owns the ref (a stale copy elsewhere with
      -- the old ref no longer finds — and overwrites — this sale).
      client_ref     = coalesce(p_client_ref, client_ref),
      last_save_ref  = p_save_ref
    where id = v_id;
    exit again;
  else
    insert into transactions (customer_id, note, employee_id, type, status, subtotal_cents, discount_cents, total_cents, cash_cents, card_cents, completed_at, client_ref, last_save_ref)
    values (
      nullif(p_fields->>'customer_id', '')::uuid, nullif(p_fields->>'note', ''), auth.uid(), 'sale', p_status,
      (p_fields->>'subtotal_cents')::int, (p_fields->>'discount_cents')::int, (p_fields->>'total_cents')::int,
      (p_fields->>'cash_cents')::int, (p_fields->>'card_cents')::int,
      case when p_status = 'completed' then now() else null end, p_client_ref, p_save_ref)
    on conflict (client_ref) where client_ref is not null do nothing
    returning id, human_id into v_id, v_human;
    if v_id is not null then exit again; end if;
    -- That ref already has a sale (another request just made it): use it if
    -- this login can see it, else it's someone else's.
    select id into v_id from transactions where client_ref = p_client_ref;
    if v_id is null then
      return jsonb_build_object('ok', false, 'state', 'hidden');
    end if;
  end if;
  end loop;

  insert into transaction_items (transaction_id, line_no, variant_id, category_id, kind, description, qty, unit_price_cents, discount_cents, department, inventory_type, region)
  select v_id, e.n, x.variant_id, x.category_id, x.kind, x.description, x.qty, x.unit_price_cents, x.discount_cents, x.department, x.inventory_type, x.region
  from jsonb_array_elements(p_items) with ordinality as e(item, n),
       jsonb_to_record(e.item) as x(
         variant_id uuid, category_id uuid, kind text, description text, qty int,
         unit_price_cents int, discount_cents int, department text, inventory_type text, region text);

  -- Sold copies leave stock in one statement (never below 0).
  if p_status = 'completed' then
    update product_variants v
       set quantity = greatest(0, v.quantity - s.q)
      from (select variant_id, sum(qty) as q
              from transaction_items
             where transaction_id = v_id and variant_id is not null
             group by variant_id) s
     where v.id = s.variant_id;
  end if;

  return jsonb_build_object(
    'ok', true, 'id', v_id, 'human_id', v_human,
    'line_ids', (select coalesce(jsonb_agg(id), '[]'::jsonb) from transaction_items where transaction_id = v_id));
end
$$;

grant execute on function public.save_sale(uuid, uuid, text, jsonb, jsonb, uuid[], uuid, uuid[]) to authenticated;

-- Undo a completed sale the same day (before midnight, store time): it goes
-- back to Held sales with its lines (re-complete it after changes), its items
-- go back into stock, and its payment is cleared. Refused once the day has
-- turned, when store credit paid part of it, or when a return points at it.
create or replace function public.undo_sale(p_id uuid, p_tz text default 'America/Los_Angeles')
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  t record;
begin
  select id, human_id, type, status, is_tab, completed_at, store_credit_cents into t
    from transactions where id = p_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'state', 'missing');
  end if;
  if t.type <> 'sale' or t.is_tab then
    return jsonb_build_object('ok', false, 'state', 'not_sale', 'human_id', t.human_id);
  end if;
  if t.status <> 'completed' then
    return jsonb_build_object('ok', false, 'state', t.status, 'human_id', t.human_id);
  end if;
  if t.completed_at is null or (t.completed_at at time zone p_tz)::date <> (now() at time zone p_tz)::date then
    return jsonb_build_object('ok', false, 'state', 'past_midnight', 'human_id', t.human_id);
  end if;
  if coalesce(t.store_credit_cents, 0) > 0 then
    return jsonb_build_object('ok', false, 'state', 'store_credit', 'human_id', t.human_id);
  end if;
  if exists (select 1 from transactions r where r.original_transaction_id = p_id) then
    return jsonb_build_object('ok', false, 'state', 'returned', 'human_id', t.human_id);
  end if;

  update product_variants v
     set quantity = v.quantity + s.q
    from (select variant_id, sum(qty) as q
            from transaction_items
           where transaction_id = p_id and variant_id is not null and kind = 'sale'
           group by variant_id) s
   where v.id = s.variant_id;

  update transactions
     set status = 'open', completed_at = null, cash_cents = 0, card_cents = 0, last_save_ref = null
   where id = p_id;

  return jsonb_build_object('ok', true, 'id', t.id, 'human_id', t.human_id);
end
$$;

grant execute on function public.undo_sale(uuid, text) to authenticated;
