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
--     (state 'changed').
-- The app falls back to its old path until this is applied.

alter table public.transactions add column if not exists client_ref uuid;
create unique index if not exists transactions_client_ref_key
  on public.transactions (client_ref) where client_ref is not null;

create or replace function public.save_sale(
  p_id        uuid,     -- the open sale being saved; null = a new one
  p_client_ref uuid,    -- the register's id for this cart (null = none)
  p_status    text,     -- 'open' | 'completed'
  p_fields    jsonb,    -- customer_id, subtotal/discount/total/cash/card cents
  p_items     jsonb,    -- lines exactly as stored
  p_expected  uuid[]    -- line ids the register last saw; null = don't check
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

  if v_id is not null then
    select id, status, is_tab, human_id into t from transactions where id = v_id for update;
    if not found then
      return jsonb_build_object('ok', false, 'state', 'missing');
    end if;
    if t.is_tab then
      return jsonb_build_object('ok', false, 'state', 'tab', 'human_id', t.human_id);
    end if;
    if t.status <> 'open' then
      return jsonb_build_object('ok', false, 'state', t.status, 'id', t.id, 'human_id', t.human_id);
    end if;
    if p_expected is not null then
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
      status         = p_status,
      subtotal_cents = (p_fields->>'subtotal_cents')::int,
      discount_cents = (p_fields->>'discount_cents')::int,
      total_cents    = (p_fields->>'total_cents')::int,
      cash_cents     = (p_fields->>'cash_cents')::int,
      card_cents     = (p_fields->>'card_cents')::int,
      completed_at   = case when p_status = 'completed' then now() else null end,
      client_ref     = coalesce(client_ref, p_client_ref)
    where id = v_id;
  else
    insert into transactions (customer_id, employee_id, type, status, subtotal_cents, discount_cents, total_cents, cash_cents, card_cents, completed_at, client_ref)
    values (
      nullif(p_fields->>'customer_id', '')::uuid, auth.uid(), 'sale', p_status,
      (p_fields->>'subtotal_cents')::int, (p_fields->>'discount_cents')::int, (p_fields->>'total_cents')::int,
      (p_fields->>'cash_cents')::int, (p_fields->>'card_cents')::int,
      case when p_status = 'completed' then now() else null end, p_client_ref)
    returning id, human_id into v_id, v_human;
  end if;

  insert into transaction_items (transaction_id, variant_id, category_id, kind, description, qty, unit_price_cents, discount_cents, department, inventory_type, region)
  select v_id, x.variant_id, x.category_id, x.kind, x.description, x.qty, x.unit_price_cents, x.discount_cents, x.department, x.inventory_type, x.region
  from jsonb_to_recordset(p_items) as x(
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

grant execute on function public.save_sale(uuid, uuid, text, jsonb, jsonb, uuid[]) to authenticated;
