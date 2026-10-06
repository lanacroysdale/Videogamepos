-- Listing metadata: the character a piece of merch (or a game) is about
-- ("Pikachu", "Judd & Li'l Judd"). Filled by the eBay importers from eBay's
-- Character aspect; shown / filtered on the store later. Franchise / series,
-- brand, genre and year already have columns.
alter table public.products add column if not exists character text;
