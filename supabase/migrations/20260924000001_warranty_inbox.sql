-- ============================================================================
-- Warranty registration + POS inbox
--
--   • warranty_plans          — the store's warranty products as DATA (name,
--                               length, what's covered / not, registration
--                               window). Managers edit them in Settings; a
--                               licensee defines their own.
--   • warranty_registrations  — one row per warranted item. Born 'pending' when
--                               staff print a QR sticker at the counter (the
--                               token in the QR is the customer's way in),
--                               'active' once the customer registers, 'review'
--                               when someone self-registers from the public
--                               /warranty page without a sticker. The plan's
--                               terms are FROZEN into plan_snapshot at creation
--                               so later edits never change an existing warranty.
--   • notifications           — the POS inbox. Every event (warranty registered,
--                               new lead, club signup…) is a row addressed to a
--                               set of ROLES (resolved from Settings → Inbox at
--                               creation time). Owner sees everything.
--   • notification_reads      — per-user read state.
--   • customers.auth_user_id  — the hook for customer accounts: registering a
--                               warranty creates/links a customers row now; a
--                               later "set up my account" flow attaches an
--                               auth user to it (no password at registration).
--
-- Apply in the Supabase SQL editor. Safe to re-run.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Customers: account link (nullable — most customers never log in)
-- ---------------------------------------------------------------------------
alter table public.customers add column if not exists auth_user_id uuid unique references auth.users(id) on delete set null;
create index if not exists customers_email_lower_idx on public.customers (lower(email)) where email is not null;

-- ---------------------------------------------------------------------------
-- Warranty plans
-- ---------------------------------------------------------------------------
create table if not exists public.warranty_plans (
  id                        uuid primary key default gen_random_uuid(),
  key                       text not null unique,               -- short slug used in URLs/QR presets, e.g. '1yr'
  name                      text not null,                      -- "1 Year Limited Warranty"
  months                    int  not null check (months between 1 and 120),
  summary                   text not null default '',           -- one-liner shown on the label + top of the page
  coverage                  text not null default '',           -- what's covered — one item per line
  exclusions                text not null default '',           -- what's not — one item per line
  terms                     text not null default '',           -- fine print (plain text / markdown-ish)
  registration_window_days  int  not null default 60 check (registration_window_days between 1 and 3650),
  is_active                 boolean not null default true,
  is_default                boolean not null default false,
  sort_order                int not null default 0,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now()
);

-- Seed the store's first plan (edit it in Settings → Warranty).
insert into public.warranty_plans (key, name, months, summary, coverage, exclusions, terms, is_default, sort_order)
values (
  '1yr',
  '1 Year Limited Warranty',
  12,
  'Covers defects in materials and workmanship for one year from the date of purchase.',
  E'Hardware faults that appear under normal use\nRepair or replacement at our discretion\nParts and labor for covered repairs',
  E'Physical damage, liquid damage, or misuse\nUnauthorized modification or repair\nNormal wear (controller sticks, cosmetic scuffs)\nSoftware, saves, or data',
  E'Bring or ship the item to us with your warranty number. We will repair or replace it with an equivalent item. If neither is possible we will refund the purchase price as store credit.',
  true,
  0
) on conflict (key) do nothing;

alter table public.warranty_plans enable row level security;
grant select, insert, update, delete on public.warranty_plans to authenticated;
drop policy if exists warranty_plans_read on public.warranty_plans;
create policy warranty_plans_read on public.warranty_plans for select using (public.is_staff());
drop policy if exists warranty_plans_write on public.warranty_plans;
create policy warranty_plans_write on public.warranty_plans for all
  using (public.has_permission('warranty.manage')) with check (public.has_permission('warranty.manage'));

-- ---------------------------------------------------------------------------
-- Warranty registrations
-- ---------------------------------------------------------------------------
create sequence if not exists public.warranty_no_seq start 100001;

create table if not exists public.warranty_registrations (
  id              uuid primary key default gen_random_uuid(),
  human_id        bigint generated always as identity,
  warranty_no     text not null unique,                    -- W-100001 (printed + emailed)
  token           text not null unique,                    -- the QR payload; unguessable, single-use for registration
  status          text not null default 'pending' check (status in ('pending','active','review','void')),
  source          text not null default 'label' check (source in ('label','public','pos')),
  -- the plan, frozen
  plan_id         uuid references public.warranty_plans(id) on delete set null,
  plan_snapshot   jsonb not null default '{}'::jsonb,
  -- the item
  item_title      text not null,
  item_platform   text not null default '',
  item_condition  text not null default '',
  serial          text not null default '',
  variant_id      uuid references public.product_variants(id) on delete set null,
  transaction_id  uuid references public.transactions(id) on delete set null,
  sale_date       date not null,
  coverage_start  date not null,
  coverage_end    date not null,
  -- the customer (filled at registration)
  customer_id     uuid references public.customers(id) on delete set null,
  first_name      text not null default '',
  last_name       text not null default '',
  email           text,
  phone           text,
  -- workflow
  notes           text not null default '',
  payload         jsonb not null default '{}'::jsonb,
  created_by      uuid references public.profiles(id) on delete set null,
  created_at      timestamptz not null default now(),
  registered_at   timestamptz,
  voided_at       timestamptz,
  void_reason     text
);

create index if not exists warranty_reg_status_idx   on public.warranty_registrations (status, created_at desc);
create index if not exists warranty_reg_customer_idx on public.warranty_registrations (customer_id);
create index if not exists warranty_reg_email_idx    on public.warranty_registrations (lower(email)) where email is not null;

create or replace function public.gen_warranty_no()
returns trigger language plpgsql as $$
begin
  if new.warranty_no is null or new.warranty_no = '' then
    new.warranty_no := 'W-' || nextval('public.warranty_no_seq')::text;
  end if;
  return new;
end; $$;
drop trigger if exists gen_warranty_no on public.warranty_registrations;
create trigger gen_warranty_no before insert on public.warranty_registrations
  for each row execute function public.gen_warranty_no();

alter table public.warranty_registrations enable row level security;
grant select, insert, update on public.warranty_registrations to authenticated;
-- Any employee can print stickers and see registrations; voiding needs the
-- permission (enforced in the API — RLS allows staff updates so the counter
-- can link a customer / add notes).
drop policy if exists warranty_reg_staff on public.warranty_registrations;
create policy warranty_reg_staff on public.warranty_registrations for all
  using (public.is_staff()) with check (public.is_staff());
-- No anon policy: the public registration page goes through the server-side
-- service-role client and only ever exposes ONE row by its token.

-- ---------------------------------------------------------------------------
-- POS inbox
-- ---------------------------------------------------------------------------
create table if not exists public.notifications (
  id              uuid primary key default gen_random_uuid(),
  human_id        bigint generated always as identity,
  type            text not null,                         -- registry in src/lib/notifications.ts
  title           text not null,
  body            text not null default '',
  href            text not null default '',              -- clean POS path to open, e.g. /warranties?reg=<id>
  payload         jsonb not null default '{}'::jsonb,
  audience_roles  text[] not null default '{}',          -- role keys; owner always sees everything
  created_at      timestamptz not null default now()
);
create index if not exists notifications_created_idx on public.notifications (created_at desc);
create index if not exists notifications_roles_idx on public.notifications using gin (audience_roles);

create table if not exists public.notification_reads (
  notification_id uuid not null references public.notifications(id) on delete cascade,
  user_id         uuid not null references public.profiles(id) on delete cascade,
  read_at         timestamptz not null default now(),
  primary key (notification_id, user_id)
);

-- Can the signed-in employee see this notification? Owner: always. Otherwise
-- their role must be in the audience.
create or replace function public.can_see_notification(roles text[])
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.removed_at is null
      and (p.role = 'owner' or p.role = any(roles))
  );
$$;

alter table public.notifications enable row level security;
alter table public.notification_reads enable row level security;
grant select on public.notifications to authenticated;
grant select, insert, delete on public.notification_reads to authenticated;
drop policy if exists notifications_read on public.notifications;
create policy notifications_read on public.notifications for select using (public.can_see_notification(audience_roles));
drop policy if exists notification_reads_own on public.notification_reads;
create policy notification_reads_own on public.notification_reads for all
  using (user_id = auth.uid()) with check (user_id = auth.uid());
-- Inserts come from the server (service role) — public forms and POS events.

-- ---------------------------------------------------------------------------
-- Permission seed: the new warranty.manage key goes to the roles that already
-- run the store (the app's DEFAULT_ROLES carry it for fresh installs).
-- ---------------------------------------------------------------------------
update public.store_roles
   set permissions = array_append(permissions, 'warranty.manage')
 where key in ('manager', 'developer')
   and not ('warranty.manage' = any(permissions));
