-- ============================================================================
-- Numeric LABEL CODES for barcode printing.
--
-- The 12-char alphanumeric internal_code needs ~47mm of Code 128 — nearly the
-- whole tag. A pure-numeric, even-length code encodes in Code 128 SUBSET C
-- (two digits per symbol) at ~27mm: the compact barcode a wrap tag wants.
-- Every variant gets a unique 10-digit label_code (sequence-based, zero
-- collisions); labels encode it and checkout scanning matches it. internal_code
-- stays for existing labels/back-compat.
-- Apply in the Supabase SQL editor (no DDL from the app).
-- ============================================================================

create sequence if not exists public.variant_label_code_seq start 1000000001;

alter table public.product_variants add column if not exists label_code text unique;

-- Auto-assign on insert (mirrors gen_variant_internal_code).
create or replace function public.gen_variant_label_code()
returns trigger language plpgsql as $$
begin
  if new.label_code is null then
    new.label_code := lpad(nextval('public.variant_label_code_seq')::text, 10, '0');
  end if;
  return new;
end $$;
drop trigger if exists gen_variant_label_code on public.product_variants;
create trigger gen_variant_label_code before insert on public.product_variants
  for each row execute function public.gen_variant_label_code();

-- Backfill every existing variant (idempotent: only fills nulls).
update public.product_variants
   set label_code = lpad(nextval('public.variant_label_code_seq')::text, 10, '0')
 where label_code is null;
