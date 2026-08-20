ALTER TABLE public.guild_config
  ADD COLUMN IF NOT EXISTS brand_logo_url text,
  ADD COLUMN IF NOT EXISTS brand_logo_storage_path text,
  ADD COLUMN IF NOT EXISTS brand_header_url text,
  ADD COLUMN IF NOT EXISTS brand_header_storage_path text,
  ADD COLUMN IF NOT EXISTS brand_background_url text,
  ADD COLUMN IF NOT EXISTS brand_background_storage_path text;

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'brand-assets',
  'brand-assets',
  true,
  5242880,
  ARRAY['image/png', 'image/jpeg', 'image/webp', 'image/gif']
)
ON CONFLICT (id) DO UPDATE
SET public = EXCLUDED.public,
    file_size_limit = EXCLUDED.file_size_limit,
    allowed_mime_types = EXCLUDED.allowed_mime_types;
