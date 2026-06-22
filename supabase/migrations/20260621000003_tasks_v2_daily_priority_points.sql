-- To-dos v2: priority + points + who-completed on one-off tasks, a recurring
-- daily checklist (shared, resets each day), and per-day completion logging.
-- Apply in the Supabase SQL editor.

-- One-off tasks: priority, points, and who completed it.
alter table public.tasks add column if not exists priority text not null default 'normal';
alter table public.tasks add column if not exists points int not null default 0;
alter table public.tasks add column if not exists completed_by uuid references public.profiles(id) on delete set null;

-- Recurring daily checklist templates (managed by managers).
create table if not exists public.daily_task_templates (
  id          uuid primary key default gen_random_uuid(),
  title       text not null,
  notes       text,
  priority    text not null default 'normal',
  points      int not null default 0,
  active      boolean not null default true,
  sort_order  int not null default 0,
  created_by  uuid references public.profiles(id) on delete set null,
  created_at  timestamptz not null default now()
);
alter table public.daily_task_templates enable row level security;
drop policy if exists daily_templates_read on public.daily_task_templates;
create policy daily_templates_read on public.daily_task_templates for select using (public.is_staff());
drop policy if exists daily_templates_manage on public.daily_task_templates;
create policy daily_templates_manage on public.daily_task_templates for all using (public.is_manager()) with check (public.is_manager());

-- One shared completion per template per day (records who + when + points).
create table if not exists public.daily_task_completions (
  id             uuid primary key default gen_random_uuid(),
  template_id    uuid not null references public.daily_task_templates(id) on delete cascade,
  completed_date date not null,
  completed_by   uuid references public.profiles(id) on delete set null,
  points         int not null default 0,
  created_at     timestamptz not null default now(),
  unique (template_id, completed_date)
);
create index if not exists daily_completions_date_idx on public.daily_task_completions(completed_date);
alter table public.daily_task_completions enable row level security;
drop policy if exists daily_completions_staff on public.daily_task_completions;
create policy daily_completions_staff on public.daily_task_completions for all using (public.is_staff()) with check (public.is_staff());

grant select, insert, update, delete on public.daily_task_templates to authenticated;
grant select, insert, update, delete on public.daily_task_completions to authenticated;
