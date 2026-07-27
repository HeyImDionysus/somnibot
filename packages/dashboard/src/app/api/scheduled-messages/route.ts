/**
 * /api/scheduled-messages — CRUD for scheduled message configurations.
 *
 * GET: List all scheduled messages for the guild
 * POST: Create a new scheduled message
 * PUT: Update an existing scheduled message
 * DELETE: Delete a scheduled message by ID
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireGuildOwner } from '@/lib/api/require-owner';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { notifyBot } from '@/lib/notify-bot';
import { parseBody, schemas } from '@/lib/api/validation';
import { checkAdminRateLimit } from '@/lib/api/admin-rate-limit';
import { typedPick } from '@/lib/api/typed-pick';
import { dbError } from '@/lib/api/response';
import { recordCrudChange } from '@/lib/admin-changes';

/**
 * [#63] Append-only audit rows for the dashboard scheduled-message CRUD
 * surface (the bot rail only sees deliveries, never these config writes).
 * Best-effort service-role insert — an audit failure never fails the request.
 */
async function writeScheduledMessageAudit(
  supabase: ReturnType<typeof createAdminSupabase>,
  entry: {
    guildId: string;
    actorId: string;
    action: 'scheduled_message.created' | 'scheduled_message.updated' | 'scheduled_message.deleted';
    targetId: string;
    details?: Record<string, unknown>;
    beforeState?: Record<string, unknown> | null;
    afterState?: Record<string, unknown> | null;
  },
): Promise<void> {
  try {
    const { error } = await supabase.from('audit_logs').insert({
      guild_id: entry.guildId,
      actor_type: 'dashboard',
      actor_id: entry.actorId,
      action: entry.action,
      category: 'scheduled_messages',
      target_type: 'scheduled_message',
      target_id: entry.targetId,
      details: entry.details ?? {},
      before_state: entry.beforeState ?? null,
      after_state: entry.afterState ?? null,
      success: true,
    });
    if (error) {
      console.error(`[scheduled-messages] Failed to write ${entry.action} audit row:`, error.message);
    }
  } catch (err) {
    // Audit logging must never break the CRUD flow — but never silently.
    console.error(`[scheduled-messages] Exception writing ${entry.action} audit row:`, err);
  }
}

export async function GET() {
  const auth = await requireGuildOwner();
  if (!auth.ok) return auth.response;
  const { guildId } = auth.ctx;

  const supabase = createAdminSupabase();

  const { data, error } = await supabase
    .from('scheduled_messages')
    .select('*')
    .eq('guild_id', guildId)
    .order('created_at', { ascending: true })
    .limit(500);

  if (error) {
    return dbError(error, 'scheduled-messages');
  }

  return NextResponse.json({ success: true, data: data ?? [] });
}

export async function POST(req: NextRequest) {
  const rateLimited = await checkAdminRateLimit(req, 'write');
  if (rateLimited) return rateLimited;

  const auth = await requireGuildOwner();
  if (!auth.ok) return auth.response;
  const { guildId } = auth.ctx;

  const supabase = createAdminSupabase();
  const parsed = await parseBody(req, schemas.scheduledMessage.create);
  if (!parsed.ok) return parsed.response;
  const body = parsed.data;

  const {
    name,
    channel_id,
    message,
    embed_config_id,
    cron_expression,
    timezone,
    start_date,
    end_date,
    max_sends,
    missed_run_policy,
  } = body;

  if (!name || !channel_id || !cron_expression) {
    return NextResponse.json(
      { success: false, error: 'Missing required fields: name, channel_id, cron_expression' },
      { status: 400 },
    );
  }

  // Max 50 scheduled messages per guild
  const { count } = await supabase
    .from('scheduled_messages')
    .select('id', { count: 'exact', head: true })
    .eq('guild_id', guildId);

  if ((count ?? 0) >= 50) {
    return NextResponse.json(
      { success: false, error: 'Maximum scheduled message limit reached (50)' },
      { status: 400 },
    );
  }

  const { data, error } = await supabase
    .from('scheduled_messages')
    .insert({
      guild_id: guildId,
      name,
      channel_id,
      message: message ?? null,
      embed_config_id: embed_config_id ?? null,
      cron_expression,
      timezone: timezone ?? 'UTC',
      start_date: start_date ?? null,
      end_date: end_date ?? null,
      max_sends: max_sends ?? null,
      missed_run_policy: missed_run_policy ?? 'skip-missed',
      current_sends: 0,
      active: true,
    })
    .select()
    .single();

  if (error) {
    return dbError(error, 'scheduled-messages');
  }

  await writeScheduledMessageAudit(supabase, {
    guildId,
    actorId: auth.ctx.discordId,
    action: 'scheduled_message.created',
    targetId: data.id,
    details: { name: data.name, channelId: data.channel_id, cronExpression: data.cron_expression },
    afterState: typedPick(data, ['name', 'channel_id', 'message', 'embed_config_id', 'cron_expression', 'timezone', 'start_date', 'end_date', 'max_sends', 'missed_run_policy', 'active']),
  });

  await notifyBot('scheduled-messages');

  await recordCrudChange({
    guildId,
    actorId: auth.ctx.discordId,
    operation: 'created',
    action: 'scheduled_message.created',
    table: 'scheduled_messages',
    targetType: 'scheduled message',
    targetId: data.id,
    label: data.name,
    after: data as Record<string, unknown>,
  }, supabase);

  return NextResponse.json({ success: true, data });
}

export async function PUT(req: NextRequest) {
  const rateLimited = await checkAdminRateLimit(req, 'write');
  if (rateLimited) return rateLimited;

  const auth = await requireGuildOwner();
  if (!auth.ok) return auth.response;
  const { guildId } = auth.ctx;

  const supabase = createAdminSupabase();
  const parsed = await parseBody(req, schemas.scheduledMessage.update);
  if (!parsed.ok) return parsed.response;
  const body = parsed.data;

  if (!body.id) {
    return NextResponse.json({ success: false, error: 'Missing scheduled message id' }, { status: 400 });
  }

  const updates = typedPick(body, ['name', 'channel_id', 'message', 'embed_config_id', 'cron_expression', 'timezone', 'start_date', 'end_date', 'max_sends', 'missed_run_policy', 'active']);
  updates.updated_at = new Date().toISOString();

  // Read the row first so the audit diff carries the BEFORE side of exactly
  // the keys this update touches (an honest two-sided diff, no fabrication).
  // A FAILED read is logged and the diff stays one-sided — a null before_state
  // must mean "unavailable, and we said so", never a swallowed error.
  const { data: beforeRow, error: beforeErr } = await supabase
    .from('scheduled_messages')
    .select('*')
    .eq('id', body.id)
    .eq('guild_id', guildId)
    .maybeSingle();
  if (beforeErr) {
    console.error('[scheduled-messages] before-state read failed for scheduled_message.updated audit:', beforeErr.message);
  }

  const { data, error } = await supabase
    .from('scheduled_messages')
    .update(updates)
    .eq('id', body.id)
    .eq('guild_id', guildId)
    .select()
    .single();

  if (error) {
    return dbError(error, 'scheduled-messages');
  }

  const changedKeys = Object.keys(updates).filter((k) => k !== 'updated_at');
  // A no-op PUT (only the id, nothing picked) bumps updated_at but changes no
  // owner-visible field — writing a scheduled_message.updated row with an
  // empty diff would fabricate a mutation.
  if (changedKeys.length > 0) {
    await writeScheduledMessageAudit(supabase, {
      guildId,
      actorId: auth.ctx.discordId,
      action: 'scheduled_message.updated',
      targetId: data.id,
      details: { name: data.name, fields: changedKeys },
      beforeState: beforeRow
        ? Object.fromEntries(changedKeys.map((k) => [k, (beforeRow as Record<string, unknown>)[k] ?? null]))
        : null,
      afterState: Object.fromEntries(changedKeys.map((k) => [k, (data as Record<string, unknown>)[k] ?? null])),
    });
  }

  await notifyBot('scheduled-messages');

  // Same no-op guard as the audit row above: a PUT that changed no
  // owner-visible field must not appear as a change on the page.
  if (changedKeys.length > 0) {
    await recordCrudChange({
      guildId,
      actorId: auth.ctx.discordId,
      operation: 'updated',
      action: 'scheduled_message.updated',
      table: 'scheduled_messages',
      targetType: 'scheduled message',
      targetId: data.id,
      label: data.name,
      before: (beforeRow as Record<string, unknown> | null) ?? undefined,
      after: Object.fromEntries(changedKeys.map((k) => [k, (updates as Record<string, unknown>)[k]])),
      match: { id: body.id, guild_id: guildId },
    }, supabase);
  }

  return NextResponse.json({ success: true, data });
}

export async function DELETE(req: NextRequest) {
  const rateLimited = await checkAdminRateLimit(req, 'write');
  if (rateLimited) return rateLimited;

  const auth = await requireGuildOwner();
  if (!auth.ok) return auth.response;
  const { guildId } = auth.ctx;

  const supabase = createAdminSupabase();
  const { searchParams } = new URL(req.url);
  const id = searchParams.get('id');

  if (!id) {
    return NextResponse.json({ success: false, error: 'Missing scheduled message id' }, { status: 400 });
  }

  const { data: deletedRows, error } = await supabase
    .from('scheduled_messages')
    .delete()
    .eq('id', id)
    .eq('guild_id', guildId)
    .select();

  if (error) {
    return dbError(error, 'scheduled-messages');
  }

  const deleted = (deletedRows ?? [])[0] as Record<string, unknown> | undefined;
  if (deleted) {
    await writeScheduledMessageAudit(supabase, {
      guildId,
      actorId: auth.ctx.discordId,
      action: 'scheduled_message.deleted',
      targetId: id,
      details: { name: deleted.name, channelId: deleted.channel_id },
      beforeState: typedPick(deleted, ['name', 'channel_id', 'message', 'embed_config_id', 'cron_expression', 'timezone', 'start_date', 'end_date', 'max_sends', 'missed_run_policy', 'active']),
    });
  }

  await notifyBot('scheduled-messages');

  await recordCrudChange({
    guildId,
    actorId: auth.ctx.discordId,
    operation: 'deleted',
    action: 'scheduled_message.deleted',
    table: 'scheduled_messages',
    targetType: 'scheduled message',
    targetId: id,
    label: deleted?.name as string | undefined,
    before: deleted,
  }, supabase);

  return NextResponse.json({ success: true });
}
