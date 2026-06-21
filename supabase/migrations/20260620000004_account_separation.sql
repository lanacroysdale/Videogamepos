-- ============================================================================
-- Account separation: POS employees vs. website customers
-- Closes the privilege-escalation hole where EVERY new auth signup became a
-- staff `cashier`. Now a staff profile is created ONLY when the signup is
-- explicitly flagged as an employee (owner/admin provisioning). Any other
-- signup (e.g. future customer self-registration) gets NO profile, so
-- is_staff() stays false and they can never reach the POS.
-- ============================================================================

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  -- Not an employee → no profile → not staff (customers stay customers).
  if coalesce(new.raw_user_meta_data->>'account_type', '') <> 'employee' then
    return new;
  end if;
  insert into public.profiles (id, full_name, role)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'full_name', split_part(new.email, '@', 1)),
    coalesce(new.raw_user_meta_data->>'role', 'cashier')
  )
  on conflict (id) do nothing;
  return new;
end; $$;
