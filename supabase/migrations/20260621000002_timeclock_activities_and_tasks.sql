-- Activity-tagged clock-in + a shared to-do list.
-- Apply in the Supabase SQL editor (no DDL access from the app).

-- 1) What the employee was working on while clocked in.
alter table public.time_entries add column if not exists activity text;

-- 2) Shared store to-do list.
create table if not exists public.tasks (
  id           uuid primary key default gen_random_uuid(),
  title        text not null,
  notes        text,
  status       text not null default 'open' check (status in ('open','done')),
  assignee_id  uuid references public.profiles(id) on delete set null,
  due_date     date,
  sort_order   int not null default 0,
  created_by   uuid references public.profiles(id) on delete set null,
  created_at   timestamptz not null default now(),
  completed_at timestamptz
);
create index if not exists tasks_status_idx on public.tasks(status, sort_order, created_at);

alter table public.tasks enable row level security;
drop policy if exists tasks_staff on public.tasks;
create policy tasks_staff on public.tasks for all
  using (public.is_staff()) with check (public.is_staff());

grant select, insert, update, delete on public.tasks to authenticated;
