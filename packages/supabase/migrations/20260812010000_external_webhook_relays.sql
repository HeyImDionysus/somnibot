-- Owner-configured inbound webhook relays. Receiver tokens are only stored as
-- SHA-256 hashes; raw request bodies are never persisted.

CREATE TABLE public.external_webhook_relays (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  guild_id TEXT NOT NULL REFERENCES public.guild(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  source_label TEXT NOT NULL CHECK (char_length(source_label) BETWEEN 1 AND 80),
  channel_id TEXT NOT NULL CHECK (channel_id ~ '^[0-9]{17,20}$'),
  token_hash TEXT NOT NULL UNIQUE CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  message_template TEXT NOT NULL DEFAULT '**{source} — {event}**\n{content}'
    CHECK (char_length(message_template) BETWEEN 1 AND 1900),
  active BOOLEAN NOT NULL DEFAULT true,
  last_received_at TIMESTAMPTZ,
  last_delivery_status TEXT CHECK (last_delivery_status IS NULL OR last_delivery_status IN ('processing', 'delivered', 'failed', 'duplicate', 'retryable')),
  last_error TEXT CHECK (last_error IS NULL OR char_length(last_error) <= 500),
  created_by TEXT NOT NULL CHECK (created_by ~ '^[0-9]{17,20}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (guild_id, name)
);

CREATE TABLE public.external_webhook_deliveries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  relay_id UUID NOT NULL REFERENCES public.external_webhook_relays(id) ON DELETE CASCADE,
  guild_id TEXT NOT NULL REFERENCES public.guild(id) ON DELETE CASCADE,
  idempotency_key TEXT CHECK (idempotency_key IS NULL OR char_length(idempotency_key) BETWEEN 1 AND 200),
  request_hash TEXT NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  event_label TEXT NOT NULL CHECK (char_length(event_label) BETWEEN 1 AND 120),
  content_preview TEXT NOT NULL CHECK (char_length(content_preview) <= 240),
  status TEXT NOT NULL DEFAULT 'processing' CHECK (status IN ('processing', 'delivered', 'failed', 'duplicate', 'retryable')),
  attempt_count INTEGER NOT NULL DEFAULT 1 CHECK (attempt_count BETWEEN 1 AND 20),
  discord_message_id TEXT CHECK (discord_message_id IS NULL OR discord_message_id ~ '^[0-9]{17,20}$'),
  error TEXT CHECK (error IS NULL OR char_length(error) <= 500),
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  delivered_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX external_webhook_deliveries_idempotency_idx
  ON public.external_webhook_deliveries (relay_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE INDEX external_webhook_relays_guild_idx
  ON public.external_webhook_relays (guild_id, created_at DESC);
CREATE INDEX external_webhook_deliveries_relay_idx
  ON public.external_webhook_deliveries (relay_id, received_at DESC);

CREATE TRIGGER external_webhook_relays_updated_at
  BEFORE UPDATE ON public.external_webhook_relays
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

ALTER TABLE public.external_webhook_relays ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.external_webhook_deliveries ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.external_webhook_relays FROM anon, authenticated;
REVOKE ALL ON TABLE public.external_webhook_deliveries FROM anon, authenticated;
GRANT ALL ON TABLE public.external_webhook_relays TO service_role;
GRANT ALL ON TABLE public.external_webhook_deliveries TO service_role;

CREATE OR REPLACE FUNCTION public.claim_external_webhook_delivery(
  p_token_hash TEXT,
  p_idempotency_key TEXT,
  p_request_hash TEXT,
  p_event_label TEXT,
  p_content_preview TEXT
)
RETURNS TABLE (
  delivery_id UUID,
  relay_id UUID,
  guild_id TEXT,
  source_label TEXT,
  channel_id TEXT,
  message_template TEXT,
  claim_outcome TEXT,
  delivery_status TEXT,
  existing_request_hash TEXT,
  discord_message_id TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  v_relay public.external_webhook_relays%ROWTYPE;
  v_delivery public.external_webhook_deliveries%ROWTYPE;
BEGIN
  SELECT relay.*
    INTO v_relay
    FROM public.external_webhook_relays AS relay
   WHERE relay.token_hash = p_token_hash
     AND relay.active = true
   FOR SHARE;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    SELECT delivery.*
      INTO v_delivery
      FROM public.external_webhook_deliveries AS delivery
     WHERE delivery.relay_id = v_relay.id
       AND delivery.idempotency_key = p_idempotency_key
     FOR UPDATE;
    IF FOUND THEN
      IF v_delivery.status = 'retryable'
         AND v_delivery.request_hash = p_request_hash
         AND v_delivery.attempt_count < 20 THEN
        UPDATE public.external_webhook_deliveries AS delivery
           SET status = 'processing',
               attempt_count = delivery.attempt_count + 1,
               error = NULL
         WHERE delivery.id = v_delivery.id
        RETURNING * INTO v_delivery;
        RETURN QUERY SELECT
          v_delivery.id, v_relay.id, v_relay.guild_id, v_relay.source_label,
          v_relay.channel_id, v_relay.message_template, 'claimed'::TEXT,
          v_delivery.status, v_delivery.request_hash, v_delivery.discord_message_id;
        RETURN;
      END IF;
      RETURN QUERY SELECT
        v_delivery.id, v_relay.id, v_relay.guild_id, v_relay.source_label,
        v_relay.channel_id, v_relay.message_template, 'duplicate'::TEXT,
        v_delivery.status, v_delivery.request_hash, v_delivery.discord_message_id;
      RETURN;
    END IF;
  END IF;

  INSERT INTO public.external_webhook_deliveries (
    relay_id, guild_id, idempotency_key, request_hash, event_label, content_preview
  ) VALUES (
    v_relay.id, v_relay.guild_id, p_idempotency_key, p_request_hash,
    p_event_label, p_content_preview
  )
  ON CONFLICT (relay_id, idempotency_key)
    WHERE idempotency_key IS NOT NULL
  DO NOTHING
  RETURNING * INTO v_delivery;

  IF NOT FOUND THEN
    SELECT delivery.*
      INTO STRICT v_delivery
      FROM public.external_webhook_deliveries AS delivery
     WHERE delivery.relay_id = v_relay.id
       AND delivery.idempotency_key = p_idempotency_key;
    RETURN QUERY SELECT
      v_delivery.id, v_relay.id, v_relay.guild_id, v_relay.source_label,
      v_relay.channel_id, v_relay.message_template, 'duplicate'::TEXT,
      v_delivery.status, v_delivery.request_hash, v_delivery.discord_message_id;
    RETURN;
  END IF;

  RETURN QUERY SELECT
    v_delivery.id, v_relay.id, v_relay.guild_id, v_relay.source_label,
    v_relay.channel_id, v_relay.message_template, 'claimed'::TEXT,
    v_delivery.status, v_delivery.request_hash, v_delivery.discord_message_id;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_external_webhook_delivery(TEXT, TEXT, TEXT, TEXT, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_external_webhook_delivery(TEXT, TEXT, TEXT, TEXT, TEXT)
  TO service_role;

COMMENT ON TABLE public.external_webhook_relays IS
  'Service-role-only inbound webhook destinations. token_hash authenticates machine callers.';
COMMENT ON TABLE public.external_webhook_deliveries IS
  'Payload-free delivery evidence and idempotency state for external webhook relays.';
