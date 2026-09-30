-- ============================================================================
-- Game database search (as-you-type) + one shared name normalization.
--
-- 1) public.game_norm(text): how game names are compared. Accents folded
--    ("Pokémon" → "pokemon"), apostrophes joined ("Luigi's" → "luigis"),
--    everything else → a single space, lowercase. Before this, names were
--    stored as "pok mon …" / "luigi s …", so "pokemon" or "luigis mansion"
--    never matched. Existing rows are re-normalized once (the trigram index
--    follows automatically). scripts/launchbox-ingest.mjs normalizes the same
--    way for future re-ingests.
--
-- 2) lookup_box_art() (cover + official-title lookups) normalizes its input
--    with game_norm too.
--
-- 3) search_games(query, platform?) returns the closest official titles,
--    tolerant of typos and partial words ("mario sonic oly", "pokemon plat").
--    Powers "From the game database" in the entry screen's search.
--
-- Apply in the Supabase SQL editor. Safe to re-run.
-- ============================================================================

create or replace function public.game_norm(p text)
returns text
language sql
immutable
as $$
  select lower(btrim(regexp_replace(
    regexp_replace(
      translate(coalesce(p, ''),
        'ÀÁÂÃÄÅàáâãäåÈÉÊËèéêëÌÍÎÏìíîïÒÓÔÕÖØòóôõöøŌōÙÚÛÜùúûüŪūÇçÑñÝýÿ',
        'AAAAAAaaaaaaEEEEeeeeIIIIiiiiOOOOOOooooooOoUUUUuuuuUuCcNnYyy'),
      '[''’`]', '', 'g'),
    '[^a-zA-Z0-9]+', ' ', 'g')));
$$;

update public.game_metadata
   set name_norm = public.game_norm(name)
 where name_norm is distinct from public.game_norm(name);

create or replace function public.lookup_box_art(p_title text, p_platform text default null)
returns table(name text, platform text, box_front text, box_3d text, sim real)
language sql stable security definer set search_path = public as $$
  select g.name, g.platform, g.box_front, g.box_3d,
         similarity(g.name_norm, public.game_norm(p_title)) as sim
  from public.game_metadata g
  where g.box_front is not null
    and (p_platform is null or g.platform = p_platform)
  order by sim desc
  limit 1;
$$;
grant execute on function public.lookup_box_art(text, text) to authenticated;

create or replace function public.search_games(p_query text, p_platform text default null, p_limit int default 8)
returns table(name text, platform text, box_front text, box_3d text, sim real)
language sql
stable
security definer
set search_path = public
as $$
  with q as (select public.game_norm(p_query) as n)
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
