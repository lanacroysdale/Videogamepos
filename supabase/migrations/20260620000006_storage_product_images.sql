-- ============================================================================
-- Public storage bucket for product images. Uploaded by staff via the
-- /api/pos/upload-image endpoint (service-role), served publicly by URL.
-- ============================================================================
insert into storage.buckets (id, name, public)
values ('product-images', 'product-images', true)
on conflict (id) do nothing;
