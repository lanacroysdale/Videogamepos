-- ============================================================================
-- Leads inbox
-- Captures public marketing-site form submissions into the POS so staff can
-- work them after logging in:
--   • 'sell_request' — the "Sell your games" cash-offer / sell-trade form
--   • 'free_club'    — the "Join the Club" newsletter signup
--
-- Privacy: RLS allows staff-only reads. There are NO anon policies, so the
-- public anon key cannot read leads — submissions are invisible to anyone who
-- isn't logged into the POS. Inserts come from the server-side service-role
-- client (which bypasses RLS) in /api/contact and /api/subscribe.
-- ============================================================================

create table if not exists public.leads (
  id          uuid primary key default gen_random_uuid(),
  human_id    bigint generated always as identity,
  type        text not null check (type in ('sell_request', 'free_club')),
  status      text not null default 'new' check (status in ('new', 'contacted', 'closed')),
  first_name  text not null default '',
  last_name   text not null default '',
  email       text,
  phone       text,
  -- sell-request specifics
  condition   text,
  items       text,
  photos      text,
  -- catch-all + free-form
  note        text,
  payload     jsonb not null default '{}'::jsonb,
  source      text,
  -- workflow / linkage
  customer_id uuid references public.customers(id) on delete set null,
  handled_by  uuid references public.profiles(id) on delete set null,
  handled_at  timestamptz,
  created_at  timestamptz not null default now()
);

create index if not exists leads_status_idx on public.leads (status, created_at desc);
create index if not exists leads_type_idx   on public.leads (type, created_at desc);

alter table public.leads enable row level security;

-- Any logged-in employee can read + work leads; only managers/owners can delete.
-- No anon/public policy by design (see header).
create policy "leads_select_staff"  on public.leads for select using (public.is_staff());
create policy "leads_insert_staff"  on public.leads for insert with check (public.is_staff());
create policy "leads_update_staff"  on public.leads for update using (public.is_staff());
create policy "leads_delete_manager" on public.leads for delete using (public.is_manager());
