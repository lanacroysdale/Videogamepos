-- ============================================================================
-- LaunchBox game metadata — local copy of retail box-art references (front +
-- 3D), ingested from the LaunchBox metadata dump by scripts/launchbox-ingest.mjs.
-- Used to pull the real retail case image when enriching a product.
-- ============================================================================
create table if not exists public.game_metadata (
  database_id int primary key,           -- LaunchBox DatabaseID
  name        text not null,
  name_norm   text not null,             -- lowercased, alphanumeric+spaces (for fuzzy match)
  platform    text not null,             -- LaunchBox platform name
  box_front   text,                      -- image GUID filename (images.launchbox-app.com/<file>)
  box_3d      text
);
create index if not exists game_metadata_norm_trgm on public.game_metadata using gin (name_norm gin_trgm_ops);
create index if not exists game_metadata_platform_idx on public.game_metadata (platform);

alter table public.game_metadata enable row level security;
grant select, insert, update, delete on public.game_metadata to authenticated;
create policy game_metadata_read on public.game_metadata for select using (public.is_staff());

-- Best box-art match for a title (+ optional mapped LaunchBox platform).
create or replace function public.lookup_box_art(p_title text, p_platform text default null)
returns table(name text, platform text, box_front text, box_3d text, sim real)
language sql stable security definer set search_path = public as $$
  select g.name, g.platform, g.box_front, g.box_3d,
         similarity(g.name_norm, lower(regexp_replace(coalesce(p_title, ''), '[^a-zA-Z0-9]+', ' ', 'g'))) as sim
  from public.game_metadata g
  where g.box_front is not null
    and (p_platform is null or g.platform = p_platform)
  order by sim desc
  limit 1;
$$;
grant execute on function public.lookup_box_art(text, text) to authenticated;
