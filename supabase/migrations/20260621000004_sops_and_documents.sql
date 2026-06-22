-- Internal SOP library: written procedures (markdown) + uploaded reference
-- documents (PDFs, images, spreadsheets). Apply in the Supabase SQL editor
-- (no DDL access from the app).

-- ============================================================================
-- 1) Private storage bucket for SOP attachments / reference documents.
--    PRIVATE on purpose: there are no storage.objects policies, so only the
--    service-role client can read/write it. All access is mediated by the
--    auth-checked /api/pos/sop-* endpoints, which hand out short-lived signed
--    URLs. Nothing here is ever world-readable by URL.
-- ============================================================================
insert into storage.buckets (id, name, public, file_size_limit)
values ('documents', 'documents', false, 26214400) -- 25 MB hard cap
on conflict (id) do nothing;

-- ============================================================================
-- 2) SOP documents. A SOP is a titled, categorized procedure with a markdown
--    body; it may also carry uploaded file attachments (see sop_files).
-- ============================================================================
create table if not exists public.sops (
  id          uuid primary key default gen_random_uuid(),
  title       text not null,
  category    text not null default 'General',
  body_md     text not null default '',
  pinned      boolean not null default false,
  created_by  uuid references public.profiles(id) on delete set null,
  updated_by  uuid references public.profiles(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists sops_category_idx on public.sops(category, title);

alter table public.sops enable row level security;
-- Everyone on staff can read SOPs; only managers/owners can author or edit.
drop policy if exists sops_read on public.sops;
create policy sops_read on public.sops for select using (public.is_staff());
drop policy if exists sops_write on public.sops;
create policy sops_write on public.sops for all
  using (public.is_manager()) with check (public.is_manager());

grant select on public.sops to authenticated;
grant insert, update, delete on public.sops to authenticated;

-- ============================================================================
-- 3) Files attached to a SOP. storage_path is the key inside the (private)
--    'documents' bucket; the row is metadata for listing + download.
-- ============================================================================
create table if not exists public.sop_files (
  id           uuid primary key default gen_random_uuid(),
  sop_id       uuid not null references public.sops(id) on delete cascade,
  file_name    text not null,
  storage_path text not null,
  mime_type    text,
  size_bytes   bigint,
  uploaded_by  uuid references public.profiles(id) on delete set null,
  created_at   timestamptz not null default now()
);
create index if not exists sop_files_sop_idx on public.sop_files(sop_id, created_at);

alter table public.sop_files enable row level security;
drop policy if exists sop_files_read on public.sop_files;
create policy sop_files_read on public.sop_files for select using (public.is_staff());
drop policy if exists sop_files_write on public.sop_files;
create policy sop_files_write on public.sop_files for all
  using (public.is_manager()) with check (public.is_manager());

grant select on public.sop_files to authenticated;
grant insert, update, delete on public.sop_files to authenticated;
