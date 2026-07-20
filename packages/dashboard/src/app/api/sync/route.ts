/**
 * GET  /api/sync — Get current drift status
 * POST /api/sync — Trigger actions on drift items (repair/accept/ignore)
 */
import { NextResponse, type NextRequest } from 'next/server';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { requireGuildOwner } from '@/lib/api/require-owner';
import { notifyBot } from '@/lib/notify-bot';
import { z } from 'zod';
import { parseBody } from '@/lib/api/validation';
import { checkAdminRateLimit } from '@/lib/api/admin-rate-limit';
import { dbError } from '@/lib/api/response';

const syncConfigAction = z.object({
  action: z.literal('update_config'),
  syncEnabled: z.boolean(),
  syncIntervalMinutes: z.number().int().min(1).max(1440),
  autoRepair: z.boolean(),
  autoRepairEveryone: z.boolean(),
});

const syncDriftAction = z.object({
  action: z.enum(['repair', 'accept', 'ignore']),
  entityType: z.string().max(64).optional(),
  entityId: z.string().max(128).optional().nullable(),
  driftType: z.string().max(64).optional(),
  entityName: z.string().max(256).optional(),
});

const syncAction = z.discriminatedUnion('action', [syncConfigAction, syncDriftAction]);

function isPermissionOverwriteDrift(input: {
  action?: string;
  entityType?: string | null;
  driftType?: string | null;
}) {
  return input.action === 'accept'
    && input.driftType === 'PERMISSION_DRIFT'
    && (input.entityType === 'channel' || input.entityType === 'category');
}

export async function GET() {
  const auth = await requireGuildOwner();
  if (!auth.ok) return auth.response;
  const { guildId } = auth.ctx;

  const admin = createAdminSupabase();

  // Get drift status
  const { data: desiredState } = await admin
    .from('guild_desired_state')
    .select('drift_detected, drift_details, last_sync_at')
    .eq('guild_id', guildId)
    .single();

  // Get sync config
  const { data: config } = await admin
    .from('guild_config')
    .select('sync_enabled, sync_interval_minutes, sync_auto_repair, sync_auto_repair_everyone')
    .eq('guild_id', guildId)
    .single();

  // Get recent sync events
  const { data: recentEvents } = await admin
    .from('audit_logs')
    .select('*')
    .eq('guild_id', guildId)
    .in('action', ['drift.detected', 'sync.completed', 'drift.repaired', 'drift.accepted'])
    .order('timestamp', { ascending: false })
    .limit(20);

  return NextResponse.json({
    driftDetected: desiredState?.drift_detected ?? false,
    driftItems: desiredState?.drift_details ?? [],
    lastSyncAt: desiredState?.last_sync_at ?? null,
    config: {
      syncEnabled: config?.sync_enabled ?? true,
      syncIntervalMinutes: config?.sync_interval_minutes ?? 15,
      autoRepair: config?.sync_auto_repair ?? false,
      autoRepairEveryone: config?.sync_auto_repair_everyone ?? false,
    },
    recentEvents: recentEvents ?? [],
  });
}

export async function POST(request: NextRequest) {
  const rateLimited = await checkAdminRateLimit(request, 'write');
  if (rateLimited) return rateLimited;

  const auth = await requireGuildOwner();
  if (!auth.ok) return auth.response;
  const { guildId } = auth.ctx;

  const parsed = await parseBody(request, syncAction);
  if (!parsed.ok) return parsed.response;
  const body = parsed.data;
  const admin = createAdminSupabase();

  if (body.action === 'update_config') {
    const { error } = await admin
      .from('guild_config')
      .upsert({ guild_id: guildId,
        sync_enabled: body.syncEnabled,
        sync_interval_minutes: body.syncIntervalMinutes,
        sync_auto_repair: body.autoRepair,
        sync_auto_repair_everyone: body.autoRepairEveryone,
       }, { onConflict: 'guild_id' });

    if (error) return dbError(error, 'sync');

    // Notify bot so it hot-reloads sync config immediately
    await notifyBot('settings');

    return NextResponse.json({ success: true });
  }

  if (body.action === 'repair' || body.action === 'accept' || body.action === 'ignore') {
    if (isPermissionOverwriteDrift(body)) {
      return NextResponse.json(
        {
          success: false,
          error: 'Channel/category permission drift accept requires manual review',
        },
        { status: 400 },
      );
    }

    // Log the action — the bot picks it up and executes
    await admin.from('audit_logs').insert({
      guild_id: guildId,
      actor_type: 'user',
      actor_id: auth.ctx.discordId ?? 'dashboard',
      action: `drift.${body.action}`,
      target_type: body.entityType ?? 'unknown',
      target_id: body.entityId ?? null,
      details: {
        driftType: body.driftType,
        entityName: body.entityName,
      },
    });

    return NextResponse.json({ success: true, message: `${body.action} queued` });
  }

  return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
}
