-- ============================================================================
-- To-do categories ("task lists"), customizable by managers.
--
-- Before: the To-dos page had three hardcoded sections — Daily checklist,
-- Open, Done. Now each section is a row in public.task_lists:
--   * kind = 'tasks'     — one-off tasks (e.g. Open, POS improvements, Management)
--   * kind = 'recurring' — a checklist whose items stay put and get un-checked
--                          every period (daily / weekly / monthly, 4 AM store time)
--   * kind = 'done'      — the "Done" section showing completed one-off tasks.
--                          At most one live. Without it, completed tasks just
--                          disappear from the page (rows are kept for points).
--   * managers_only      — only people with tasks.manage (and the owner) can see
--                          the list or its items. Enforced here in RLS.
--   * removed_at         — soft-remove, so a list's items and points history
--                          survive; re-adding a list by the same name restores it.
--
-- tasks.list_id / daily_task_templates.list_id point items at their list.
-- Existing rows are moved into the seeded Open / Daily checklist lists.
-- daily_task_completions.completed_date now holds the START date of the
-- period (the day, the Monday, or the 1st) the check-off belongs to.
--
-- Apply in the Supabase SQL editor. Safe to re-run.
-- ============================================================================

create table if not exists public.task_lists (
  id             uuid primary key default gen_random_uuid(),
  name           text not null,
  kind           text not null default 'tasks' check (kind in ('tasks','recurring','done')),
  recurrence     text check (recurrence in ('daily','weekly','monthly')),
  managers_only  boolean not null default false,
  sort_order     int not null default 0,
  removed_at     timestamptz,
  created_by     uuid references public.profiles(id) on delete set null,
  created_at     timestamptz not null default now(),
  constraint task_lists_recurrence_chk check ((kind = 'recurring') = (recurrence is not null))
);
create unique index if not exists task_lists_live_name_uq on public.task_lists (lower(name)) where removed_at is null;
create unique index if not exists task_lists_one_done_uq on public.task_lists (kind) where kind = 'done' and removed_at is null;

-- Seed the three sections the page used to hardcode (first run only).
do $$ begin
  if not exists (select 1 from public.task_lists) then
    insert into public.task_lists (name, kind, recurrence, sort_order) values
      ('Daily checklist', 'recurring', 'daily', 0),
      ('Open',            'tasks',     null,    1),
      ('Done',            'done',      null,    2);
  end if;
end $$;

alter table public.tasks add column if not exists list_id uuid references public.task_lists(id) on delete set null;
alter table public.daily_task_templates add column if not exists list_id uuid references public.task_lists(id) on delete set null;
create index if not exists tasks_list_idx on public.tasks(list_id);
create index if not exists daily_task_templates_list_idx on public.daily_task_templates(list_id);

update public.tasks set list_id = (
  select id from public.task_lists where kind = 'tasks' and removed_at is null order by sort_order, created_at limit 1
) where list_id is null;
update public.daily_task_templates set list_id = (
  select id from public.task_lists where kind = 'recurring' and recurrence = 'daily' and removed_at is null order by sort_order, created_at limit 1
) where list_id is null;

-- ---- Visibility -------------------------------------------------------------
-- Can the current user see items in this list? Unassigned (null) items are
-- visible to all staff; a managers-only list needs tasks.manage.
create or replace function public.can_see_task_list(p_list uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select p_list is null
      or public.has_permission('tasks.manage')
      or exists (select 1 from public.task_lists where id = p_list and not managers_only);
$$;

alter table public.task_lists enable row level security;
drop policy if exists task_lists_read on public.task_lists;
create policy task_lists_read on public.task_lists for select
  using (public.is_staff() and (not managers_only or public.has_permission('tasks.manage')));
drop policy if exists task_lists_manage on public.task_lists;
create policy task_lists_manage on public.task_lists for all
  using (public.has_permission('tasks.manage')) with check (public.has_permission('tasks.manage'));
grant select, insert, update, delete on public.task_lists to authenticated;

drop policy if exists tasks_staff on public.tasks;
create policy tasks_staff on public.tasks for all
  using (public.is_staff() and public.can_see_task_list(list_id))
  with check (public.is_staff() and public.can_see_task_list(list_id));

drop policy if exists daily_templates_read on public.daily_task_templates;
create policy daily_templates_read on public.daily_task_templates for select
  using (public.is_staff() and public.can_see_task_list(list_id));
-- Match the app's gate (tasks.manage) so this policy can't re-open reads of a
-- managers-only list to someone who merely has elevated data access.
drop policy if exists daily_templates_manage on public.daily_task_templates;
create policy daily_templates_manage on public.daily_task_templates for all
  using (public.has_permission('tasks.manage')) with check (public.has_permission('tasks.manage'));

drop policy if exists daily_completions_staff on public.daily_task_completions;
create policy daily_completions_staff on public.daily_task_completions for all
  using (public.is_staff() and public.can_see_task_list((select t.list_id from public.daily_task_templates t where t.id = template_id)))
  with check (public.is_staff() and public.can_see_task_list((select t.list_id from public.daily_task_templates t where t.id = template_id)));
