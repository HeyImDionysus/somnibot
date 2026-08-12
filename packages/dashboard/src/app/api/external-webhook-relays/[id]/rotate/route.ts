import { NextResponse, type NextRequest } from 'next/server';
import { recordAdminChange } from '@/lib/admin-changes';
import { checkAdminRateLimit } from '@/lib/api/admin-rate-limit';
import { requireGuildOwner } from '@/lib/api/require-owner';
import { apiError, apiServerError, dbError } from '@/lib/api/response';
import { buildExternalWebhookReceiverUrl, createExternalWebhookToken } from '@/lib/external-webhook-relay';
import { createAdminSupabase } from '@/lib/supabase/admin';

function configuredPublicAppUrl(): string {
  return process.env.NEXT_PUBLIC_APP_URL ?? process.env.APP_URL ?? '';
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const limited = await checkAdminRateLimit(request, 'bulk', 'external-webhook-relays:rotate');
  if (limited) return limited;
  try {
    const auth = await requireGuildOwner();
    if (!auth.ok) return auth.response;
    const { id } = await context.params;
    const admin = createAdminSupabase();
    const before = await admin
      .from('external_webhook_relays')
      .select('id, name, active')
      .eq('id', id)
      .eq('guild_id', auth.ctx.guildId)
      .maybeSingle();
    if (before.error) return dbError(before.error, 'POST relay rotate read');
    if (!before.data) return apiError('Relay not found.', 404);

    const credential = createExternalWebhookToken();
    let receiverUrl: string;
    try {
      receiverUrl = buildExternalWebhookReceiverUrl(configuredPublicAppUrl(), credential.token);
    } catch {
      return apiError('The public app URL must be configured before rotating a receiver.', 503);
    }
    const rotated = await admin
      .from('external_webhook_relays')
      .update({ token_hash: credential.tokenHash, last_received_at: null, last_delivery_status: null, last_error: null })
      .eq('id', id)
      .eq('guild_id', auth.ctx.guildId)
      .select('id, name, active, updated_at')
      .single();
    if (rotated.error) return dbError(rotated.error, 'POST relay rotate');
    await recordAdminChange({
      guildId: auth.ctx.guildId,
      actorId: auth.ctx.discordId,
      action: 'external_webhook_relay.rotated',
      targetType: 'external webhook relay',
      targetId: id,
      description: `Rotated the receiver URL for external webhook relay "${before.data.name}"; the previous URL stopped working immediately`,
      before: { active: before.data.active },
      after: { active: rotated.data.active, token_rotated: true },
      blastRadius: 'high',
      undoReason: 'the previous raw token was never stored and cannot be restored',
    }, admin);
    return NextResponse.json({
      success: true,
      data: { relay: rotated.data, receiver_url: receiverUrl },
      warning: 'Copy this receiver URL now. It will not be shown again.',
    });
  } catch (error) {
    return apiServerError(error, 'POST /api/external-webhook-relays/[id]/rotate');
  }
}
