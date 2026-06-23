-- SOP external documentation links: a list of titled URLs on each SOP, shown as
-- buttons in the viewer. Stored inline (edited with the SOP, no upload needed).
alter table public.sops add column if not exists links jsonb not null default '[]'::jsonb;
