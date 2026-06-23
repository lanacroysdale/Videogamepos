-- File attachments for to-do tasks (photos, docs). Reuses the private
-- 'documents' bucket from the SOP migration. Apply in the Supabase SQL editor.

-- Ensure the private documents bucket exists (idempotent — also created by the
-- SOP migration), so task attachments work even if that one hasn't been run.
insert into storage.buckets (id, name, public, file_size_limit)
values ('documents', 'documents', false, 26214400) -- 25 MB hard cap
on conflict (id) do nothing;

create table if not exists public.task_files (
  id           uuid primary key default gen_random_uuid(),
  task_id      uuid not null references public.tasks(id) on delete cascade,
  file_name    text not null,
  storage_path text not null,
  mime_type    text,
  size_bytes   bigint,
  uploaded_by  uuid references public.profiles(id) on delete set null,
  created_at   timestamptz not null default now()
);
create index if not exists task_files_task_idx on public.task_files(task_id, created_at);

-- The to-do list is a shared, staff-collaborative tool, so attachments follow
-- the same rule as tasks: any staff member can read/add/remove.
alter table public.task_files enable row level security;
drop policy if exists task_files_staff on public.task_files;
create policy task_files_staff on public.task_files for all
  using (public.is_staff()) with check (public.is_staff());

grant select, insert, update, delete on public.task_files to authenticated;
