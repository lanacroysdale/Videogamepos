-- SECURITY: the profiles_update policy lets a user update their OWN row (for
-- name edits), with no column restriction — so a cashier could PATCH their own
-- `role` to 'manager' (directly via the REST API with their token) and pass
-- every manager gate. This trigger blocks any change to `role` unless the caller
-- is the service role (the admin/team-management API) or already a manager/owner.
-- Apply in the Supabase SQL editor.
create or replace function public.guard_profile_role()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.role is distinct from old.role
     and coalesce(auth.role(), '') <> 'service_role'   -- allow the admin client (team management)
     and not public.is_manager() then                  -- allow an existing manager/owner
    raise exception 'Only a manager can change a profile role';
  end if;
  return new;
end $$;

drop trigger if exists trg_guard_profile_role on public.profiles;
create trigger trg_guard_profile_role before update on public.profiles
  for each row execute function public.guard_profile_role();
