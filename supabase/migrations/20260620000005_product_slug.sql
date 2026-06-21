-- ============================================================================
-- Product slugs for clean, SEO-friendly product detail URLs (/shop/<slug>).
-- ============================================================================
alter table public.products add column if not exists slug text;

-- Backfill a slug from the title (lowercase, non-alphanumerics -> hyphens).
update public.products
  set slug = trim(both '-' from regexp_replace(lower(title), '[^a-z0-9]+', '-', 'g'))
  where slug is null or slug = '';

create index if not exists products_slug_idx on public.products (slug);
