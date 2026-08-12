import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { recordAdminChange, recordCrudChange } from '@/lib/admin-changes';
import { checkAdminRateLimit } from '@/lib/api/admin-rate-limit';
import { validateExternalWebhookChannel } from '@/lib/api/live-discord-facts';
import { requireGuildOwner } from '@/lib/api/require-owner';
import { apiError, apiServerError, dbConflictOr500, dbError } from '@/lib/api/response';
import { parseBody } from '@/lib/api/validation';
import {
  buildExternalWebhookReceiverUrl,
  createExternalWebhookToken,
  DEFAULT_EXTERNAL_WEBHOOK_TEMPLATE,
  templateUsesOnlySupportedVariables,
} from '@/lib/external-webhook-relay';
import { createAdminSupabase } from '@/lib/supabase/admin';

const snowflake = z.string().regex(/^\d{17,20}$/u, 'Must be a Discord channel ID');
const template = z.string().trim().min(1).max(1_900).refine(
  templateUsesOnlySupportedVariables,
  'Only {source}, {event}, and {content} template variables are supported',
);
const createRelay = z.object({
  name: z.string().trim().min(1).max(80),
  source_label: z.string().trim().min(1).max(80),
  channel_id: snowflake,
  message_template: template.default(DEFAULT_EXTERNAL_WEBHOOK_TEMPLATE),
}).strict();
const updateRelay = z.object({
  id: z.string().uuid(),
  name: z.string().trim().min(1).max(80).optional(),
  source_label: z.string().trim().min(1).max(80).optional(),
  channel_id: snowflake.optional(),
  message_template: template.optional(),
  active: z.boolean().optional(),
}).strict().refine(
  (value) => Object.keys(value).some((key) => key !== 'id'),
  'At least one relay field is required',
);

function configuredPublicAppUrl(): string {
  return process.env.NEXT_PUBLIC_APP_URL ?? process.env.APP_URL ?? '';
}

export async function GET() {
  try {
    const auth = await requireGuildOwner();
    if (!auth.ok) return auth.response;
    const admin = createAdminSupabase();
    const { data: relays, error } = await admin
      .from('external_webhook_relays')
      .select('id, guild_id, name, source_label, channel_id, message_template, active, last_received_at, last_delivery_status, last_error, created_at, updated_at')
      .eq('guild_id', auth.ctx.guildId)
      .order('created_at', { ascending: false })
      .limit(100);
    if (error) return dbError(error, 'GET /api/external-webhook-relays');

    let deliveries: unknown[] = [];
    if ((relays ?? []).length > 0) {
      const recent = await admin.rpc('list_recent_external_webhook_deliveries', {
        p_guild_id: auth.ctx.guildId,
        p_per_relay: 3,
      });
      if (recent.error) return dbError(recent.error, 'GET /api/external-webhook-relays deliveries');
      deliveries = recent.data ?? [];
    }
    return NextResponse.json({ success: true, data: { relays: relays ?? [], deliveries } });
  } catch (error) {
    return apiServerError(error, 'GET /api/external-webhook-relays');
  }
}

export async function POST(request: NextRequest) {
  const limited = await checkAdminRateLimit(request, 'write', 'external-webhook-relays:create');
  if (limited) return limited;
  try {
    const auth = await requireGuildOwner();
    if (!auth.ok) return auth.response;
    const parsed = await parseBody(request, createRelay);
    if (!parsed.ok) return parsed.response;
    const admin = createAdminSupabase();
    const channel = await validateExternalWebhookChannel(admin, auth.ctx.guildId, parsed.data.channel_id);
    if (!channel.ok) {
      return apiError(channel.issues.join(' '), channel.kind === 'unavailable' ? 503 : 409);
    }

    const credential = createExternalWebhookToken();
    let receiverUrl: string;
    try {
      receiverUrl = buildExternalWebhookReceiverUrl(configuredPublicAppUrl(), credential.token);
    } catch {
      return apiError('The public app URL must be configured before creating a receiver.', 503);
    }
    const { data, error } = await admin
      .from('external_webhook_relays')
      .insert({
        guild_id: auth.ctx.guildId,
        name: parsed.data.name,
        source_label: parsed.data.source_label,
        channel_id: parsed.data.channel_id,
        token_hash: credential.tokenHash,
        message_template: parsed.data.message_template,
        created_by: auth.ctx.discordId,
      })
      .select('id, guild_id, name, source_label, channel_id, message_template, active, created_at, updated_at')
      .single();
    if (error) {
      return dbConflictOr500(
        error,
        'POST /api/external-webhook-relays',
        'external_webhook_relays_guild_id_name_key',
        'A relay with that name already exists.',
      );
    }
    await recordCrudChange({
      guildId: auth.ctx.guildId,
      actorId: auth.ctx.discordId,
      operation: 'created',
      action: 'external_webhook_relay.created',
      table: 'external_webhook_relays',
      targetType: 'external webhook relay',
      targetId: data.id,
      label: data.name,
      after: data,
      blastRadius: 'medium',
    }, admin);
    return NextResponse.json({
      success: true,
      data: { relay: data, receiver_url: receiverUrl },
      warning: 'Copy this receiver URL now. It will not be shown again.',
    }, { status: 201 });
  } catch (error) {
    return apiServerError(error, 'POST /api/external-webhook-relays');
  }
}

export async function PATCH(request: NextRequest) {
  const limited = await checkAdminRateLimit(request, 'write', 'external-webhook-relays:update');
  if (limited) return limited;
  try {
    const auth = await requireGuildOwner();
    if (!auth.ok) return auth.response;
    const parsed = await parseBody(request, updateRelay);
    if (!parsed.ok) return parsed.response;
    const admin = createAdminSupabase();
    if (parsed.data.channel_id) {
      const channel = await validateExternalWebhookChannel(admin, auth.ctx.guildId, parsed.data.channel_id);
      if (!channel.ok) return apiError(channel.issues.join(' '), channel.kind === 'unavailable' ? 503 : 409);
    }
    const { id, ...updates } = parsed.data;
    const beforeResult = await admin
      .from('external_webhook_relays')
      .select('id, name, source_label, channel_id, message_template, active')
      .eq('id', id)
      .eq('guild_id', auth.ctx.guildId)
      .maybeSingle();
    if (beforeResult.error) return dbError(beforeResult.error, 'PATCH /api/external-webhook-relays read');
    if (!beforeResult.data) return apiError('Relay not found.', 404);
    const { data, error } = await admin
      .from('external_webhook_relays')
      .update(updates)
      .eq('id', id)
      .eq('guild_id', auth.ctx.guildId)
      .select('id, guild_id, name, source_label, channel_id, message_template, active, last_received_at, last_delivery_status, last_error, created_at, updated_at')
      .single();
    if (error) {
      return dbConflictOr500(
        error,
        'PATCH /api/external-webhook-relays',
        'external_webhook_relays_guild_id_name_key',
        'A relay with that name already exists.',
      );
    }
    await recordCrudChange({
      guildId: auth.ctx.guildId,
      actorId: auth.ctx.discordId,
      operation: 'updated',
      action: 'external_webhook_relay.updated',
      table: 'external_webhook_relays',
      targetType: 'external webhook relay',
      targetId: id,
      label: data.name,
      before: beforeResult.data,
      after: updates,
      match: { id, guild_id: auth.ctx.guildId },
      blastRadius: updates.active === false ? 'medium' : 'low',
    }, admin);
    return NextResponse.json({ success: true, data });
  } catch (error) {
    return apiServerError(error, 'PATCH /api/external-webhook-relays');
  }
}

export async function DELETE(request: NextRequest) {
  const limited = await checkAdminRateLimit(request, 'bulk', 'external-webhook-relays:delete');
  if (limited) return limited;
  try {
    const auth = await requireGuildOwner();
    if (!auth.ok) return auth.response;
    const id = request.nextUrl.searchParams.get('id');
    if (!id || !z.string().uuid().safeParse(id).success) return apiError('A valid relay id is required.', 400);
    const admin = createAdminSupabase();
    const before = await admin
      .from('external_webhook_relays')
      .select('id, name, source_label, channel_id, message_template, active')
      .eq('id', id)
      .eq('guild_id', auth.ctx.guildId)
      .maybeSingle();
    if (before.error) return dbError(before.error, 'DELETE /api/external-webhook-relays read');
    if (!before.data) return apiError('Relay not found.', 404);
    const removed = await admin
      .from('external_webhook_relays')
      .delete()
      .eq('id', id)
      .eq('guild_id', auth.ctx.guildId);
    if (removed.error) return dbError(removed.error, 'DELETE /api/external-webhook-relays');
    await recordAdminChange({
      guildId: auth.ctx.guildId,
      actorId: auth.ctx.discordId,
      action: 'external_webhook_relay.deleted',
      targetType: 'external webhook relay',
      targetId: id,
      description: `Deleted the external webhook relay "${before.data.name}" and invalidated its receiver URL`,
      before: before.data,
      blastRadius: 'medium',
      undoReason: 'deletion permanently removes the token hash, so the old receiver URL cannot be restored',
    }, admin);
    return NextResponse.json({ success: true });
  } catch (error) {
    return apiServerError(error, 'DELETE /api/external-webhook-relays');
  }
}
