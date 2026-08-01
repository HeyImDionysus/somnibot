/**
 * GET /api/fraud/rules — List fraud detection rules.
 * POST /api/fraud/rules — Create a new rule.
 * PATCH /api/fraud/rules — Update a rule.
 * DELETE /api/fraud/rules — Delete a rule.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { requirePermission, authErrorResponse } from '@/lib/rbac';
import { parseBody } from '@/lib/api/validation';
import { z } from 'zod';
import { checkAdminRateLimit } from '@/lib/api/admin-rate-limit';
import { dbError } from '@/lib/api/response';
import { readRowBefore, recordCrudChange } from '@/lib/admin-changes';
import { velocityRuleConfigSchema } from '@/lib/fraud-rule-config';

// Only expose detectors that production actually evaluates. Historical rows
// of other constrained types remain readable but cannot be presented as live
// controls until their runtime detector exists.
const fraudRuleType = z.literal('velocity_limit');

const fraudRuleCreate = z.object({
  name: z.string().min(1).max(100).trim(),
  description: z.string().max(500).optional().nullable(),
  // MUST mirror the fraud_rules CHECK constraint (20260518200000). A free
  // string accepted here died later as a raw 23514 the owner could not act on.
  rule_type: fraudRuleType,
  enabled: z.boolean().default(true),
  config: velocityRuleConfigSchema,
  auto_action: z.literal('flag').default('flag'),
});

const fraudRuleUpdate = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(100).trim().optional(),
  description: z.string().max(500).optional().nullable(),
  rule_type: fraudRuleType.optional(),
  enabled: z.boolean().optional(),
  config: velocityRuleConfigSchema.optional(),
  auto_action: z.literal('flag').optional(),
});

export async function GET() {
  try {
    const ctx = await requirePermission('dashboard.view_fraud');
    const admin = createAdminSupabase();

    const { data, error } = await admin
      .from('fraud_rules')
      .select('*')
      .eq('guild_id', ctx.guildId)
      .order('created_at', { ascending: false })
      .limit(500);

    if (error) return dbError(error, 'fraud/rules');
    return NextResponse.json({ success: true, data });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Unknown error';
    return NextResponse.json({ error: msg }, { status: msg === 'Unauthorized' ? 401 : 403 });
  }
}

export async function POST(request: NextRequest) {
  const rateLimited = await checkAdminRateLimit(request, 'write');
  if (rateLimited) return rateLimited;

  try {
    const ctx = await requirePermission('dashboard.manage_fraud');
    const parsed = await parseBody(request, fraudRuleCreate);
    if (!parsed.ok) return parsed.response;
    const body = parsed.data;
    const admin = createAdminSupabase();

    const { data, error } = await admin
      .from('fraud_rules')
      .insert({
        guild_id: ctx.guildId,
        name: body.name,
        description: body.description || null,
        rule_type: body.rule_type,
        enabled: body.enabled ?? true,
        config: body.config || {},
        auto_action: body.auto_action || 'flag',
      })
      .select()
      .single();

    if (error && error.code === '23505' && error.message.includes('velocity')) {
      // The partial unique index allows ONE enabled velocity rule per guild:
      // the bot enforces a single velocityThreshold/velocityWindowMs pair, so
      // several enabled rows would silently reduce to an arbitrary winner
      // while all appearing active in the dashboard.
      return NextResponse.json(
        {
          success: false,
          error: 'Only one enabled velocity rule is allowed — disable the existing velocity rule first.',
        },
        { status: 409 },
      );
    }
    if (error) return dbError(error, 'fraud/rules');

    await recordCrudChange({
      guildId: ctx.guildId,
      actorId: ctx.discordId,
      operation: 'created',
      action: 'fraud.rule_created',
      table: 'fraud_rules',
      targetType: 'fraud rule',
      targetId: (data as { id?: string } | null)?.id ?? null,
      label: undefined,
      after: data as Record<string, unknown> | null,
      blastRadius: 'medium',
    }, admin);

    return NextResponse.json({ success: true, data });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Unknown error';
    return NextResponse.json({ error: msg }, { status: msg === 'Unauthorized' ? 401 : 403 });
  }
}

export async function PATCH(request: NextRequest) {
  const rateLimited = await checkAdminRateLimit(request, 'write');
  if (rateLimited) return rateLimited;

  try {
    const ctx = await requirePermission('dashboard.manage_fraud');
    const parsed = await parseBody(request, fraudRuleUpdate);
    if (!parsed.ok) return parsed.response;
    const body = parsed.data;
    const admin = createAdminSupabase();

    const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (body.name !== undefined) updates.name = body.name;
    if (body.description !== undefined) updates.description = body.description;
    if (body.rule_type !== undefined) updates.rule_type = body.rule_type;
    if (body.enabled !== undefined) updates.enabled = body.enabled;
    if (body.config !== undefined) updates.config = body.config;
    if (body.auto_action !== undefined) updates.auto_action = body.auto_action;

    const before = await readRowBefore(admin, 'fraud_rules', { id: body.id, guild_id: ctx.guildId });

    const { data, error } = await admin
      .from('fraud_rules')
      .update(updates)
      .eq('id', body.id)
      .eq('guild_id', ctx.guildId)
      .select()
      .single();

    if (error && error.code === '23505' && error.message.includes('velocity')) {
      return NextResponse.json(
        {
          success: false,
          error: 'Only one enabled velocity rule is allowed — disable the existing velocity rule first.',
        },
        { status: 409 },
      );
    }
    if (error) return dbError(error, 'fraud/rules');

    await recordCrudChange({
      guildId: ctx.guildId,
      actorId: ctx.discordId,
      operation: 'updated',
      action: 'fraud.rule_updated',
      table: 'fraud_rules',
      targetType: 'fraud rule',
      targetId: body.id,
      label: before?.name as string | undefined,
      before,
      after: updates as Record<string, unknown>,
      match: { id: body.id, guild_id: ctx.guildId },
      blastRadius: 'medium',
    }, admin);

    return NextResponse.json({ success: true, data });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Unknown error';
    return NextResponse.json({ error: msg }, { status: msg === 'Unauthorized' ? 401 : 403 });
  }
}

export async function DELETE(request: NextRequest) {
  const rateLimited = await checkAdminRateLimit(request, 'write');
  if (rateLimited) return rateLimited;

  try {
    const ctx = await requirePermission('dashboard.manage_fraud');
    const { searchParams } = new URL(request.url);
    const ruleId = searchParams.get('id');
    if (!ruleId) return NextResponse.json({ error: 'Missing rule ID' }, { status: 400 });

    const admin = createAdminSupabase();
    const before = await readRowBefore(admin, 'fraud_rules', { id: ruleId, guild_id: ctx.guildId });

    const { error } = await admin
      .from('fraud_rules')
      .delete()
      .eq('id', ruleId)
      .eq('guild_id', ctx.guildId);

    if (error) return dbError(error, 'fraud/rules');

    await recordCrudChange({
      guildId: ctx.guildId,
      actorId: ctx.discordId,
      operation: 'deleted',
      action: 'fraud.rule_deleted',
      table: 'fraud_rules',
      targetType: 'fraud rule',
      targetId: ruleId,
      label: before?.name as string | undefined,
      before,
      blastRadius: 'medium',
    }, admin);

    return NextResponse.json({ success: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Unknown error';
    return NextResponse.json({ error: msg }, { status: msg === 'Unauthorized' ? 401 : 403 });
  }
}
