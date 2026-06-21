-- Add a "Certified Open Box" completeness level. Idempotent — safe to re-run.
-- (Applied to the live DB via scripts/add-completeness-levels.mjs since the
--  cloud project has no migration runner wired up.)
insert into public.completeness_levels
  (code, label, aliases, sort_order, badge_label, banner_on_thumbnail, use_as_filter, is_active)
values
  ('COB', 'Certified Open Box',
   array['cob','certified open box','open box','openbox','open-box'],
   5, 'Open Box', false, true, true)
on conflict (code) do update set
  label = excluded.label,
  aliases = excluded.aliases,
  badge_label = excluded.badge_label,
  is_active = true;
