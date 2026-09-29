-- ============================================================================
-- Entries: RECEIVED ON — the date the business received the stock.
--
-- Every inventory entry records the day its items came into the business,
-- separate from when the entry was created or committed (a Monday entry can
-- log a Saturday estate-sale haul). New entries default to the day they're
-- started; the entry screen lets staff change it. For stock transferred from
-- the owner's personal collection, this IS the transfer date.
--
-- Existing entries are backfilled with their creation date (store-local).
-- Apply in the Supabase SQL editor (no DDL from the app).
-- ============================================================================

alter table public.inventory_entries add column if not exists received_on date;

update public.inventory_entries
   set received_on = (created_at at time zone 'America/Los_Angeles')::date
 where received_on is null;
