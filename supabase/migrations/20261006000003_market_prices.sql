-- ============================================================================
-- Market prices on a listing (owner request): PriceCharting's current
-- averages, saved when a product is added with the 🔖 Send to TimeLag bookmark
-- from its PriceCharting page — Loose / Complete / New (+ Box only, Manual
-- only, Graded), in cents, with the date they were read:
--   { "source": "pricecharting", "id": "7141", "url": "https://…",
--     "loose": 1999, "cib": 6723, "new": 260000, "box": 2397, "manual": 699,
--     "graded": 1441258, "at": "2026-10-06" }
-- The Add form uses them to price a copy by its condition; the edit window
-- shows them. Internal only — the website never reads this column.
--
-- Apply in the Supabase SQL editor. Safe to re-run.
-- ============================================================================

alter table public.products add column if not exists market_prices jsonb;

-- Check: the column is there (expect one row).
select column_name, data_type from information_schema.columns
 where table_schema = 'public' and table_name = 'products' and column_name = 'market_prices';
