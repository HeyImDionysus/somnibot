-- C2: immutable per-customer delivery evidence for the store control room.
-- product_files.download_count is aggregate analytics and cannot prove which
-- paying customer downloaded which entitlement.
CREATE TABLE IF NOT EXISTS public.commerce_download_deliveries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  guild_id TEXT NOT NULL REFERENCES public.guild(id) ON DELETE CASCADE,
  customer_id UUID NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE,
  product_id UUID NOT NULL REFERENCES public.products(id) ON DELETE CASCADE,
  file_id UUID NOT NULL REFERENCES public.product_files(id) ON DELETE CASCADE,
  entitlement_id UUID REFERENCES public.entitlements(id) ON DELETE SET NULL,
  order_id UUID REFERENCES public.orders(id) ON DELETE SET NULL,
  delivery_nonce_hash TEXT,
  delivered_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT commerce_download_deliveries_nonce_hash_check
    CHECK (
      delivery_nonce_hash IS NULL
      OR delivery_nonce_hash ~ '^[0-9a-f]{64}$'
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_commerce_download_deliveries_nonce
  ON public.commerce_download_deliveries (delivery_nonce_hash)
  WHERE delivery_nonce_hash IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_commerce_download_deliveries_customer_product
  ON public.commerce_download_deliveries
  (guild_id, customer_id, product_id, delivered_at DESC);

CREATE INDEX IF NOT EXISTS idx_commerce_download_deliveries_order
  ON public.commerce_download_deliveries (order_id, delivered_at DESC)
  WHERE order_id IS NOT NULL;

ALTER TABLE public.commerce_download_deliveries ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "service_role_full_access"
  ON public.commerce_download_deliveries;
CREATE POLICY "service_role_full_access"
  ON public.commerce_download_deliveries
  FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);
