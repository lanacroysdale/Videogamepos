-- ============================================================================
-- Roles as data + a permission matrix + soft-remove for employees.
--
-- Before: `profiles.role` was a hardcoded check (owner/manager/cashier) and
-- every gate in the app was an inline "is owner or manager" literal. Now:
--   * public.store_roles holds the roles — display name, whether it's a built-in
--     system role, and the list of permission keys it grants. The owner can
--     rename roles, add custom ones, and edit the matrix from Settings.
--   * `owner` is special-cased everywhere: it ALWAYS has every permission and
--     its row can't be deleted. `developer` is a new built-in role.
--   * public.has_permission(key) is the DB-side check; is_manager() is now an
--     alias for has_permission('data.elevated') so the ~80 existing RLS
--     policies keep working with no rewrite (that permission = "elevated
--     database access", and the owner grants it per role in the matrix).
--   * profiles.removed_at soft-removes an employee: they vanish from the team,
--     lose staff status (is_staff() is false), and their auth login is banned
--     by the API. History (transactions, entries) keeps pointing at the row.
--
-- Apply in the Supabase SQL editor. Safe to re-run.
-- ============================================================================

-- ---- Roles table ----------------------------------------------------------
create table if not exists public.store_roles (
  key          text primary key,
  name         text not null,
  description  text not null default '',
  is_system    boolean not null default false,
  sort_order   int not null default 0,
  permissions  text[] not null default '{}',
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- Built-in roles. Permissions here are the DEFAULTS; the app's registry
-- (src/lib/permissions.ts) is the source of truth for the key list and the
-- Settings UI lets the owner change them afterwards (on conflict = keep edits).
insert into public.store_roles (key, name, description, is_system, sort_order, permissions) values
  ('owner',     'Owner',     'Full access to everything, including the team and this permission matrix.', true, 0, '{}'),
  ('developer', 'Developer', 'Builds and maintains the POS. Everything the owner can do except removing employees (grant it below if needed).', true, 1,
     array['reports.view','pricing.manage','settings.manage','menu.manage','inventory.manage','inventory_config.manage',
           'returns.override','tabs.close_all','customers.merge','shifts.manage','tasks.manage','sops.manage','sops.approve',
           'data.elevated','departments.manage','team.manage','roles.manage']),
  ('manager',   'Manager',   'Runs the floor: reports, pricing, settings, menu, schedule, SOPs.', true, 2,
     array['reports.view','pricing.manage','settings.manage','menu.manage','inventory.manage','inventory_config.manage',
           'returns.override','tabs.close_all','customers.merge','shifts.manage','tasks.manage','sops.manage','data.elevated']),
  ('cashier',   'Cashier',   'Checkout, trade-ins, inventory entry, returns inside the window.', true, 3, '{}')
on conflict (key) do nothing;

-- ---- Profiles: role is now a foreign key; add soft-remove ------------------
alter table public.profiles drop constraint if exists profiles_role_check;
alter table public.profiles add column if not exists removed_at timestamptz;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'profiles_role_fkey') then
    alter table public.profiles
      add constraint profiles_role_fkey foreign key (role) references public.store_roles(key) on update cascade;
  end if;
end $$;
create index if not exists profiles_role_idx on public.profiles(role);

-- ---- Helpers ----------------------------------------------------------------
-- Active staff only: a removed employee is no longer staff.
create or replace function public.is_staff()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where id = auth.uid() and removed_at is null);
$$;

-- The permission check. Owner always passes; everyone else needs the key in
-- their role's list. Removed employees never pass.
create or replace function public.has_permission(p_key text)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1
    from public.profiles pr
    join public.store_roles r on r.key = pr.role
    where pr.id = auth.uid()
      and pr.removed_at is null
      and (pr.role = 'owner' or p_key = any(r.permissions))
  );
$$;

-- Kept for the existing RLS policies: "manager-level" = elevated data access.
create or replace function public.is_manager()
returns boolean language sql stable security definer set search_path = public as $$
  select public.has_permission('data.elevated');
$$;

-- Role changes on profiles: service role (team API) or someone with team.manage.
create or replace function public.guard_profile_role()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if (new.role is distinct from old.role or new.removed_at is distinct from old.removed_at)
     and coalesce(auth.role(), '') <> 'service_role'
     and not public.has_permission('team.manage') then
    raise exception 'Only someone who manages the team can change a role or remove an employee';
  end if;
  return new;
end $$;
drop trigger if exists trg_guard_profile_role on public.profiles;
create trigger trg_guard_profile_role before update on public.profiles
  for each row execute function public.guard_profile_role();

-- ---- RLS: staff read; writes ONLY through the service-role roles API --------
-- Same shape as store_departments: no authenticated write policy at all, so a
-- manager's JWT can't PATCH itself extra permissions via PostgREST.
alter table public.store_roles enable row level security;
drop policy if exists store_roles_read on public.store_roles;
create policy store_roles_read on public.store_roles for select using (public.is_staff());
revoke insert, update, delete on public.store_roles from authenticated;
grant select on public.store_roles to authenticated;
grant select, insert, update, delete on public.store_roles to service_role;

-- Defense-in-depth even against the service-role API: system roles can't be
-- deleted or re-keyed, and the owner role can't be handed a permission list
-- (it's implicit) or demoted from system.
create or replace function public.guard_store_role()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'DELETE' then
    if old.is_system then raise exception 'Built-in role "%" cannot be deleted', old.key; end if;
    if exists (select 1 from public.profiles where role = old.key) then
      raise exception 'Role "%" is still assigned to an employee', old.key;
    end if;
    return old;
  end if;
  if tg_op = 'UPDATE' then
    if new.key <> old.key and old.is_system then raise exception 'Built-in role keys are fixed'; end if;
    if old.is_system and not new.is_system then raise exception 'Built-in roles stay built-in'; end if;
    if new.key = 'owner' then new.permissions := '{}'; end if;
    new.updated_at := now();
  end if;
  return new;
end $$;
drop trigger if exists trg_guard_store_role on public.store_roles;
create trigger trg_guard_store_role before update or delete on public.store_roles
  for each row execute function public.guard_store_role();
