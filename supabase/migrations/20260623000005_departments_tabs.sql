-- ============================================================================
-- Business departments (the POS spine) + bar-tab gratuity + per-line snapshots.
--
-- TimeLag runs multiple departments from one POS — Retail (game shop), Food &
-- Beverage (bar), Arcade — and the software is licensed to other stores, so the
-- department list is a SETUP-TIME, GOVERNED configuration: the owner customizes
-- it during setup, after which it's locked and only changeable with owner (or
-- company) authorization. Bar vs Kitchen is NOT a department — it's a station
-- *within* Food & Beverage, modeled as menu_items.station.
--
-- Apply in the Supabase SQL editor (no DDL from the app).
-- ============================================================================

-- ---- Business departments (Retail / Food & Beverage / Arcade …) ------------
create table if not exists public.store_departments (
  id          uuid primary key default gen_random_uuid(),
  key         text not null unique,            -- stable slug: retail / food_bev / arcade
  name        text not null,                   -- editable display label
  kind        text not null default 'other'
                check (kind in ('retail','food_bev','arcade','service','other')),
  color       text,
  icon        text,
  is_enabled  boolean not null default true,   -- drives which POS modes are on
  is_system   boolean not null default false,  -- seeded cores (protected from delete)
  sort_order  int not null default 0,
  created_at  timestamptz not null default now()
);
create index if not exists store_departments_order_idx on public.store_departments(sort_order, name);

-- RLS: staff READ only. Department WRITES go EXCLUSIVELY through the service-role
-- API (departments.ts), which enforces the governance: owner-only, the lock, and
-- system-row protection. No authenticated/manager JWT may write directly — that
-- closes a PostgREST privilege-escalation path (a manager could otherwise PATCH/
-- DELETE departments straight against the REST API with their token), matching how
-- guard_profile_role treats RLS/triggers as the real trust boundary, not the API.
alter table public.store_departments enable row level security;
drop policy if exists store_departments_read on public.store_departments;
create policy store_departments_read on public.store_departments for select using (public.is_staff());
drop policy if exists store_departments_write on public.store_departments; -- intentionally NO authenticated write policy
revoke insert, update, delete on public.store_departments from authenticated;
grant select on public.store_departments to authenticated;
grant select, insert, update, delete on public.store_departments to service_role;

-- Defense-in-depth: even the service-role API cannot delete a core (seeded)
-- department or rename its stable key/kind — reports rollups + POS-mode gating
-- depend on those staying stable.
create or replace function public.guard_store_department()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'DELETE' then
    if old.is_system then raise exception 'Core departments cannot be deleted (disable them instead).'; end if;
    return old;
  end if;
  if old.is_system and (new.key <> old.key or new.kind <> old.kind or new.is_system <> old.is_system) then
    raise exception 'A core department''s key/kind cannot be changed.';
  end if;
  return new;
end $$;
drop trigger if exists guard_store_department on public.store_departments;
create trigger guard_store_department before update or delete on public.store_departments
  for each row execute function public.guard_store_department();

-- ---- Seed the core departments (idempotent) --------------------------------
-- Food & Beverage inherits the existing settings.menuEnabled flag so an already-
-- enabled bar stays visible; Arcade starts disabled (future build).
insert into public.store_departments (key, name, kind, icon, sort_order, is_system, is_enabled)
values
  ('retail',   'Retail',          'retail',   '🎮', 0, true, true),
  ('food_bev', 'Food & Beverage', 'food_bev', '🍺', 1, true,
     coalesce((select (settings->>'menuEnabled')::boolean from public.store_settings where id = 1), false)),
  ('arcade',   'Arcade',          'arcade',   '🕹️', 2, true, false)
on conflict (key) do nothing;

-- ---- F&B routing station on each menu item (bar vs kitchen) -----------------
-- The kitchen-vs-bar ticket routing tag. Drinks → 'bar', food → 'kitchen'.
alter table public.menu_items add column if not exists station text not null default 'bar'
  check (station in ('bar','kitchen'));

-- ---- Gratuity / tip on the transaction --------------------------------------
-- Folded into total_cents at settle. NOT a line item, so it stays out of the
-- line-item sales-revenue rollups in Reports (a tip isn't store sales revenue).
alter table public.transactions add column if not exists tip_cents int not null default 0;

-- ---- Per-line department + station snapshot ---------------------------------
-- Stamped at sale time so reporting + kitchen tickets survive later menu edits
-- (menu_item_id is `on delete set null`). department holds the dept KEY
-- ('retail' | 'food_bev' | 'arcade' | 'other'); station holds 'bar'/'kitchen'
-- for F&B lines (null otherwise).
alter table public.transaction_items add column if not exists department text;
alter table public.transaction_items add column if not exists station text;
