-- Soft-delete for products: bulk "Delete" on the inventory page stamps
-- deleted_at instead of destroying rows. Deleted products sit in the
-- "Recently deleted" list for 7 days (restorable), then the inventory page
-- purges them for good. Live queries filter on deleted_at is null.
alter table public.products add column if not exists deleted_at timestamptz;

create index if not exists products_deleted_at_idx
  on public.products (deleted_at) where deleted_at is not null;
