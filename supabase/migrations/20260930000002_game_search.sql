-- ============================================================================
-- Game database search (as-you-type), over the local LaunchBox copy.
--
-- search_games(query, platform?) returns the closest official game titles,
-- tolerant of typos and partial words ("mario sonic oly", "links aweakening").
-- Powers "From the game database" in the entry screen's search, so a game the
-- store has never stocked can be added under its official name and box art.
-- Uses the existing trigram index on game_metadata.name_norm.
-- Apply in the Supabase SQL editor. Safe to re-run.
-- ============================================================================

create or replace function public.search_games(p_query text, p_platform text default null, p_limit int default 8)
returns table(name text, platform text, box_front text, box_3d text, sim real)
language sql
stable
security definer
set search_path = public
as $$
  with q as (
    select lower(btrim(regexp_replace(coalesce(p_query, ''), '[^a-zA-Z0-9]+', ' ', 'g'))) as n
  )
  select g.name, g.platform, g.box_front, g.box_3d,
         greatest(similarity(g.name_norm, q.n), word_similarity(q.n, g.name_norm)) as sim
    from public.game_metadata g, q
   where length(q.n) >= 2
     and (p_platform is null or g.platform = p_platform)
     and (q.n <% g.name_norm or g.name_norm % q.n)
   order by sim desc, length(g.name), g.name
   limit least(greatest(coalesce(p_limit, 8), 1), 25);
$$;

revoke execute on function public.search_games(text, text, int) from public, anon;
grant execute on function public.search_games(text, text, int) to authenticated;
