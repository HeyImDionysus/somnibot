import { NextResponse, type NextRequest } from 'next/server';
import { recordAdminChange } from '@/lib/admin-changes';
import { checkAdminRateLimit } from '@/lib/api/admin-rate-limit';
import { validateExternalWebhookChannel } from '@/lib/api/live-discord-facts';
import { requireGuildOwner } from '@/lib/api/require-owner';
import { apiError, apiServerError, dbError } from '@/lib/api/response';
import { sendExternalWebhookDiscordMessage } from '@/lib/external-webhook-discord';
import { hashExternalWebhookValue, renderExternalWebhookMessage } from '@/lib/external-webhook-relay';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { getDiscordRuntimeConfig } from '@/lib/discord-runtime-config';

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const limited = await checkAdminRateLimit(request, 'write', 'external-webhook-relays:test');
  if (limited) return limited;
  try {
    const auth = await requireGuildOwner();
    if (!auth.ok) return auth.response;
    const { id } = await context.params;
    const admin = createAdminSupabase();
    const relay = await admin
      .from('external_webhook_relays')
      .select('id, name, source_label, channel_id, message_template, active')
      .eq('id', id)
      .eq('guild_id', auth.ctx.guildId)
      .maybeSingle();
    if (relay.error) return dbError(relay.error, 'POST relay test read');
    if (!relay.data) return apiError('Relay not found.', 404);
    if (!relay.data.active) return apiError('Enable this relay before sending a test.', 409);
    const channel = await validateExternalWebhookChannel(admin, auth.ctx.guildId, relay.data.channel_id);
    if (!channel.ok) return apiError(channel.issues.join(' '), channel.kind === 'unavailable' ? 503 : 409);

    const content = renderExternalWebhookMessage({
      template: relay.data.message_template,
      source: relay.data.source_label,
      event: 'relay.test',
      content: 'SomniBot test delivery succeeded.',
    });
    const discord = await getDiscordRuntimeConfig();
    const result = await sendExternalWebhookDiscordMessage({
      token: discord.botToken,
      channelId: relay.data.channel_id,
      content,
    });
    const now = new Date().toISOString();
    const messageId = result.status === 'delivered' ? result.messageId : null;
    const delivery = await admin.from('external_webhook_deliveries').insert({
      relay_id: id,
      guild_id: auth.ctx.guildId,
      idempotency_key: null,
      request_hash: hashExternalWebhookValue(content),
      event_label: 'relay.test',
      content_preview: 'SomniBot test delivery succeeded.',
      status: result.status,
      discord_message_id: messageId,
      error: result.status === 'delivered' ? null : result.error,
      delivered_at: result.status === 'delivered' ? now : null,
    });
    if (delivery.error) return dbError(delivery.error, 'POST relay test evidence');
    const relayEvidence = await admin.from('external_webhook_relays').update({
      last_received_at: now,
      last_delivery_status: result.status,
      last_error: result.status === 'delivered' ? null : result.error,
    }).eq('id', id).eq('guild_id', auth.ctx.guildId);
    if (relayEvidence.error) return dbError(relayEvidence.error, 'POST relay test relay evidence');
    if (result.status !== 'delivered') {
      return apiError(result.error, result.status === 'retryable' ? 503 : 502);
    }
    await recordAdminChange({
      guildId: auth.ctx.guildId,
      actorId: auth.ctx.discordId,
      action: 'external_webhook_relay.test_sent',
      targetType: 'external webhook relay',
      targetId: id,
      description: `Sent a test message through external webhook relay "${relay.data.name}"`,
      after: { channel_id: relay.data.channel_id, discord_message_id: result.messageId },
      blastRadius: 'low',
      undoReason: 'a message already delivered to Discord cannot be unsent safely from this audit action',
    }, admin);
    return NextResponse.json({ success: true, data: { status: 'delivered', message_id: result.messageId } });
  } catch (error) {
    return apiServerError(error, 'POST /api/external-webhook-relays/[id]/test');
  }
}
