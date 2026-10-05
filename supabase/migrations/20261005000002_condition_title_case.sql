-- ============================================================================
-- Condition names in Title Case (owner: "Complete In Box"), everywhere they
-- show: pickers, labels, receipts, the shop. The names live in
-- completeness_levels; every stock row also keeps its condition TEXT
-- ("Complete in box Great"), so that gets the same spelling.
-- Only the old seed spellings change — a name you've edited stays as is.
-- Past sales keep the text they were sold with (history).
-- Apply in the Supabase SQL editor. Safe to re-run.
-- ============================================================================

update public.completeness_levels set label = 'Complete In Box'    where code = 'CIB' and label = 'Complete in box';
update public.completeness_levels set label = 'In Box (No Manual)' where code = 'IB'  and label = 'In box (no manual)';
update public.completeness_levels set label = 'New / Sealed'       where code = 'NEW' and label = 'New / sealed';
update public.completeness_levels set badge_label = 'No Manual'    where code = 'IB'  and badge_label = 'No manual';

update public.product_variants set condition = regexp_replace(condition, '^Complete in box', 'Complete In Box')       where condition like 'Complete in box%';
update public.product_variants set condition = regexp_replace(condition, '^In box \(no manual\)', 'In Box (No Manual)') where condition like 'In box (no manual)%';
update public.product_variants set condition = regexp_replace(condition, '^New / sealed', 'New / Sealed')             where condition like 'New / sealed%';

-- Check: the names now.
select code, label, badge_label from public.completeness_levels order by sort_order;
