import { NextResponse, type NextRequest } from 'next/server';
import { getClientIp } from '@/lib/api/client-ip';
import { checkRateLimit } from '@/lib/api/rate-limit';
import { apiError, apiServerError, dbError } from '@/lib/api/response';
import { sendExternalWebhookDiscordMessage } from '@/lib/external-webhook-discord';
import {
  extractExternalWebhookEvent,
  hashExternalWebhookValue,
  readExternalWebhookBody,
  renderExternalWebhookMessage,
} from '@/lib/external-webhook-relay';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { getDiscordBotRuntimeConfig } from '@/lib/discord-runtime-config';

const RECEIVER_TOKEN = /^[A-Za-z0-9_-]{43}$/u;
const IDEMPOTENCY_HEADERS = [
  'idempotency-key',
  'x-idempotency-key',
  'x-webhook-id',
  'x-event-id',
  'x-github-delivery',
  'x-request-id',
] as const;

interface ClaimedDelivery {
  deliveryId: string;
  relayId: string;
  guildId: string;
  sourceLabel: string;
  channelId: string;
  messageTemplate: string;
  claimOutcome: 'claimed' | 'duplicate';
  deliveryStatus: string;
  existingRequestHash: string;
  discordMessageId: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function claimedDelivery(value: unknown): ClaimedDelivery | null {
  if (!isRecord(value)) return null;
  if (
    typeof value.delivery_id !== 'string'
    || typeof value.relay_id !== 'string'
    || typeof value.guild_id !== 'string'
    || typeof value.source_label !== 'string'
    || typeof value.channel_id !== 'string'
    || typeof value.message_template !== 'string'
    || (value.claim_outcome !== 'claimed' && value.claim_outcome !== 'duplicate')
    || typeof value.delivery_status !== 'string'
    || typeof value.existing_request_hash !== 'string'
    || (value.discord_message_id !== null && typeof value.discord_message_id !== 'string')
  ) return null;
  return {
    deliveryId: value.delivery_id,
    relayId: value.relay_id,
    guildId: value.guild_id,
    sourceLabel: value.source_label,
    channelId: value.channel_id,
    messageTemplate: value.message_template,
    claimOutcome: value.claim_outcome,
    deliveryStatus: value.delivery_status,
    existingRequestHash: value.existing_request_hash,
    discordMessageId: value.discord_message_id,
  };
}

function idempotencyKey(request: Request): { ok: true; value: string | null } | { ok: false } {
  for (const header of IDEMPOTENCY_HEADERS) {
    const raw = request.headers.get(header);
    if (raw === null) continue;
    const value = raw.trim();
    if (value.length === 0 || value.length > 200 || /[\u0000-\u001F\u007F]/u.test(value)) return { ok: false };
    return { ok: true, value };
  }
  return { ok: true, value: null };
}

function acceptedContentType(request: Request): boolean {
  const raw = request.headers.get('content-type');
  if (raw === null || raw.trim() === '') return true;
  const mediaType = raw.split(';', 1)[0]?.trim().toLowerCase();
  return mediaType === 'text/plain' || mediaType === 'application/json' || mediaType?.endsWith('+json') === true;
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ token: string }> },
) {
  try {
    const { token } = await context.params;
    if (!RECEIVER_TOKEN.test(token)) return apiError('Receiver not found.', 404);
    const tokenHash = hashExternalWebhookValue(token);
    const ip = getClientIp(request);
    const [relayLimit, ipLimit] = await Promise.all([
      checkRateLimit(`external-webhook:relay:${tokenHash}`, 60, 60_000),
      checkRateLimit(`external-webhook:ip:${ip}`, 120, 60_000),
    ]);
    const limited = relayLimit.limited ? relayLimit : ipLimit;
    if (limited.limited) {
      return NextResponse.json(
        { success: false, status: 'retryable', error: 'Too many webhook requests.' },
        { status: 429, headers: { 'Retry-After': String(Math.ceil(limited.retryAfterMs / 1_000)) } },
      );
    }
    if (!acceptedContentType(request)) return apiError('Only JSON and plain-text webhook bodies are supported.', 415);
    const key = idempotencyKey(request);
    if (!key.ok) return apiError('The idempotency header is invalid.', 400);
    const bodyResult = await readExternalWebhookBody(request);
    if (!bodyResult.ok) return apiError(
      bodyResult.reason === 'too_large' ? 'Webhook body exceeds 256 KiB.' : 'Webhook body could not be read.',
      bodyResult.reason === 'too_large' ? 413 : 400,
    );

    const requestHash = hashExternalWebhookValue(bodyResult.body);
    const event = extractExternalWebhookEvent(bodyResult.body, request.headers.get('content-type'));
    const admin = createAdminSupabase();
    const claim = await admin.rpc('claim_external_webhook_delivery', {
      p_token_hash: tokenHash,
      p_idempotency_key: key.value,
      p_request_hash: requestHash,
      p_event_label: event.event,
      p_content_preview: Array.from(event.content).slice(0, 240).join(''),
    });
    if (claim.error) return dbError(claim.error, 'POST /api/inbound-webhooks claim');
    const row = claimedDelivery(Array.isArray(claim.data) ? claim.data[0] : null);
    if (!row) return apiError('Receiver not found.', 404);
    if (row.claimOutcome === 'duplicate') {
      if (row.existingRequestHash !== requestHash) {
        return apiError('That idempotency key was already used for a different payload.', 409);
      }
      if (row.deliveryStatus === 'delivered') {
        return NextResponse.json({
          success: true,
          status: 'duplicate',
          original_status: 'delivered',
          message_id: row.discordMessageId,
        });
      }
      if (row.deliveryStatus === 'failed') {
        return NextResponse.json(
          { success: false, status: 'failed', error: 'The original webhook delivery failed.' },
          { status: 502 },
        );
      }
      return NextResponse.json(
        { success: false, status: 'retryable', error: 'The original webhook delivery is not complete.' },
        { status: 503, headers: { 'Retry-After': '5' } },
      );
    }

    const content = renderExternalWebhookMessage({
      template: row.messageTemplate,
      source: row.sourceLabel,
      event: event.event,
      content: event.content,
    });
    const discord = await getDiscordBotRuntimeConfig();
    const result = await sendExternalWebhookDiscordMessage({
      token: discord.botToken,
      channelId: row.channelId,
      content,
    });
    const messageId = result.status === 'delivered' ? result.messageId : null;
    const error = result.status === 'delivered' ? null : result.error;
    const finalized = await admin.rpc('finalize_external_webhook_delivery', {
      p_delivery_id: row.deliveryId,
      p_relay_id: row.relayId,
      p_guild_id: row.guildId,
      p_status: result.status,
      p_discord_message_id: messageId,
      p_error: error,
    });
    if (finalized.error) {
      return dbError(finalized.error, 'POST /api/inbound-webhooks finalize');
    }
    if (finalized.data !== true) {
      return apiError('The webhook delivery could not be finalized.', 503);
    }

    if (result.status === 'delivered') {
      return NextResponse.json({ success: true, status: 'delivered', message_id: result.messageId });
    }
    if (result.status === 'retryable') {
      return NextResponse.json(
        { success: false, status: 'retryable', error: result.error },
        { status: 503, headers: { 'Retry-After': String(Math.ceil(result.retryAfterMs / 1_000)) } },
      );
    }
    return NextResponse.json({ success: false, status: 'failed', error: result.error }, { status: 502 });
  } catch (error) {
    return apiServerError(error, 'POST /api/inbound-webhooks/[token]');
  }
}
