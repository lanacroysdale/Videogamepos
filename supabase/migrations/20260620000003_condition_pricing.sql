-- ============================================================================
-- Condition-based pricing engine
-- Settings-gated (store_settings.condition_pricing_enabled) + rules-as-data
-- (price multipliers on the configurable completeness × grade taxonomy).
-- When ON, setting one condition's price re-prices the product's other
-- conditions via the multipliers. License-ready: a licensee edits the
-- multipliers, or leaves the feature off.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Link variants to the structured taxonomy (the axes the engine prices on)
-- ---------------------------------------------------------------------------
alter table public.product_variants
  add column if not exists completeness_code text references public.completeness_levels(code) on delete set null,
  add column if not exists grade_code        text references public.condition_grades(code) on delete set null;

-- Best-effort backfill from the existing free-text condition/completeness.
update public.product_variants pv set completeness_code = cl.code
from public.completeness_levels cl
where pv.completeness_code is null
  and (lower(pv.condition) = any(cl.aliases)
       or lower(coalesce(pv.completeness, '')) = any(cl.aliases)
       or lower(pv.condition) = lower(cl.label));

update public.product_variants pv set grade_code = cg.code
from public.condition_grades cg
where pv.grade_code is null
  and (lower(pv.condition) = any(cg.aliases) or lower(pv.condition) = lower(cg.label));

-- Default any still-unset grade to the reference grade (store can change per item).
update public.product_variants set grade_code = '3' where grade_code is null;

-- ---------------------------------------------------------------------------
-- 2. Price multipliers (rules-as-data) on the taxonomy. Reference = 1.0.
-- ---------------------------------------------------------------------------
alter table public.completeness_levels add column if not exists price_multiplier numeric(6,3) not null default 1.0;
alter table public.condition_grades   add column if not exists price_multiplier numeric(6,3) not null default 1.0;

update public.completeness_levels set price_multiplier = case code
  when 'L' then 0.55 when 'IB' then 0.85 when 'CIB' then 1.0 when 'NEW' then 1.6 else price_multiplier end;
update public.condition_grades set price_multiplier = case code
  when '1' then 0.50 when '2' then 0.75 when '3' then 1.0 when 'MINT' then 1.25 else price_multiplier end;

-- Turn the feature ON for THIS store (column default stays false for licensees).
update public.store_settings set condition_pricing_enabled = true where id = 1;

-- ---------------------------------------------------------------------------
-- 3. Reprice function — set one condition's price, the siblings follow.
--    price = base × completeness_multiplier × grade_multiplier, where
--    base is derived from the edited (anchor) variant's price.
-- ---------------------------------------------------------------------------
drop function if exists public.reprice_product(uuid);
create or replace function public.reprice_product(p_variant_id uuid)
returns table(variant_id uuid, new_price_cents int)
language plpgsql security definer set search_path = public as $$
declare
  v_enabled boolean;
  v_prod uuid;
  v_anchor_price int;
  v_anchor_mult numeric;
  v_base numeric;
begin
  if not public.is_staff() then raise exception 'unauthorized'; end if;

  select condition_pricing_enabled into v_enabled from public.store_settings where id = 1;
  if not coalesce(v_enabled, false) then return; end if;   -- feature off → no-op

  select pv.product_id, pv.price_cents,
         coalesce(cl.price_multiplier, 1) * coalesce(cg.price_multiplier, 1)
    into v_prod, v_anchor_price, v_anchor_mult
  from public.product_variants pv
  left join public.completeness_levels cl on cl.code = pv.completeness_code
  left join public.condition_grades cg on cg.code = pv.grade_code
  where pv.id = p_variant_id;

  if v_prod is null or coalesce(v_anchor_mult, 0) = 0 then return; end if;
  v_base := v_anchor_price / v_anchor_mult;

  -- Reprice every sibling that has at least one structured axis. A missing
  -- axis is treated as the reference (multiplier 1.0) so completeness-only
  -- variants still re-price.
  return query
  update public.product_variants pv
  set price_cents = round(v_base
      * coalesce((select price_multiplier from public.completeness_levels where code = pv.completeness_code), 1)
      * coalesce((select price_multiplier from public.condition_grades where code = pv.grade_code), 1))::int
  where pv.product_id = v_prod
    and pv.id <> p_variant_id
    and (pv.completeness_code is not null or pv.grade_code is not null)
  returning pv.id, pv.price_cents;
end; $$;
grant execute on function public.reprice_product(uuid) to authenticated;
