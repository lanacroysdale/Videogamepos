-- SOP approval workflow: a manager's SOP (new or edited) goes to the owner for
-- sign-off before it's "official". Owners' own edits are auto-approved. Existing
-- SOPs are grandfathered as approved. Apply in the Supabase SQL editor.

alter table public.sops add column if not exists status text not null default 'approved'
  check (status in ('pending', 'approved'));
alter table public.sops add column if not exists approved_by uuid references public.profiles(id) on delete set null;
alter table public.sops add column if not exists approved_at timestamptz;
create index if not exists sops_status_idx on public.sops(status);

-- Grandfather: every SOP that predates this workflow counts as already approved
-- (so nothing the staff already relies on suddenly disappears).
update public.sops set approved_at = coalesce(approved_at, updated_at) where approved_at is null;

-- Visibility: managers/owners see all SOPs; cashiers see only ones that have been
-- approved at least once (approved_at is not null). The app uses the service-role
-- client and ALSO enforces this in code; this policy is the backstop.
drop policy if exists sops_read on public.sops;
create policy sops_read on public.sops for select
  using (public.is_staff() and (public.is_manager() or approved_at is not null));
