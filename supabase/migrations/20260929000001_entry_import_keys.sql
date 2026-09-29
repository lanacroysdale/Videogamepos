-- ============================================================================
-- Entries: safe CSV-import retries + lines only on OPEN drafts.
--
-- 1) inventory_entry_import_keys: every spreadsheet row the collection importer
--    stages carries a stable key (the file + the row's contents). A row is CLAIMED before it's
--    staged. If the network drops after the server wrote a batch and the
--    employee presses Import again, already-staged rows replay instead of
--    being added a second time (no doubled quantities, no twin listings).
--
-- 2) inventory_entry_items INSERT now requires the parent entry to be open —
--    same as the update/delete policies. Before, a line could still land on a
--    draft another station finished mid-import. A BEFORE INSERT trigger also
--    takes a share lock on the entry, so an insert racing "Finish" waits for
--    it and then sees the draft is closed (a policy alone reads a stale
--    snapshot and could still let the line through, stranded and unapplied).
--
-- Apply in the Supabase SQL editor (no DDL from the app). The importer works
-- without it (just without replay protection).
-- ============================================================================

create table if not exists public.inventory_entry_import_keys (
  entry_id   uuid not null references public.inventory_entries(id) on delete cascade,
  import_key text not null,
  item_id    uuid references public.inventory_entry_items(id) on delete cascade,
  variant_id uuid references public.product_variants(id) on delete set null,
  product_id uuid references public.products(id) on delete set null,
  created    text not null default '' check (created in ('', 'product', 'variant')),
  created_at timestamptz not null default now(),
  primary key (entry_id, import_key)
);

alter table public.inventory_entry_import_keys enable row level security;
grant select, insert, update, delete on public.inventory_entry_import_keys to authenticated;

drop policy if exists entry_import_keys_read on public.inventory_entry_import_keys;
create policy entry_import_keys_read on public.inventory_entry_import_keys
  for select using (public.is_staff());

-- Claims / updates / releases only while the draft is open.
drop policy if exists entry_import_keys_write on public.inventory_entry_import_keys;
create policy entry_import_keys_write on public.inventory_entry_import_keys
  for all using (
    public.is_staff() and exists (select 1 from public.inventory_entries e where e.id = entry_id and e.status = 'open')
  ) with check (
    public.is_staff() and exists (select 1 from public.inventory_entries e where e.id = entry_id and e.status = 'open')
  );

drop policy if exists inventory_entry_items_insert on public.inventory_entry_items;
create policy inventory_entry_items_insert on public.inventory_entry_items
  for insert with check (
    public.is_staff() and exists (select 1 from public.inventory_entries e where e.id = entry_id and e.status = 'open')
  );

create or replace function public.entry_items_require_open()
returns trigger language plpgsql as $$
begin
  -- Service-role / owner writes (backups, admin repair) are not staff imports.
  if current_user in ('service_role', 'postgres', 'supabase_admin') then return new; end if;
  perform 1 from public.inventory_entries where id = new.entry_id and status = 'open' for share;
  if not found then
    raise exception 'That draft was finished on another station — nothing was added.' using errcode = 'P0001';
  end if;
  return new;
end $$;

drop trigger if exists trg_entry_items_require_open on public.inventory_entry_items;
create trigger trg_entry_items_require_open before insert on public.inventory_entry_items
  for each row execute function public.entry_items_require_open();

