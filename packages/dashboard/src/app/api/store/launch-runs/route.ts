import { randomUUID } from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { checkAdminRateLimit } from '@/lib/api/admin-rate-limit';
import { requireGuildOwner } from '@/lib/api/require-owner';
import { dbError } from '@/lib/api/response';
import { parseBody } from '@/lib/api/validation';
import { createAdminSupabase } from '@/lib/supabase/admin';
import {
  LAUNCH_STAGE_KEYS,
} from '@/lib/store/commerce-operations';
import {
  defaultLaunchStages,
  writeLaunchAudit,
} from '@/lib/store/launch-run-route-helpers';

const launchActionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('create_tutorial') }),
  z.object({ action: z.literal('start'), productId: z.string().uuid(), tutorial: z.boolean().default(false) }),
  z.object({ action: z.literal('restart'), runId: z.string().uuid(), version: z.number().int().positive() }),
  z.object({ action: z.enum(['hide', 'disable', 'remove']), runId: z.string().uuid(), version: z.number().int().positive() }),
]);

const launchStageSchema = z.object({
  runId: z.string().uuid(),
  version: z.number().int().positive(),
  stage: z.enum(LAUNCH_STAGE_KEYS),
  state: z.enum(['pending', 'failed']),
  evidence: z.record(z.unknown()).default({}),
});

export async function GET(request: NextRequest) {
  const rateLimited = await checkAdminRateLimit(request, 'standard');
  if (rateLimited) return rateLimited;
  const auth = await requireGuildOwner();
  if (!auth.ok) return auth.response;
  const admin = createAdminSupabase();
  const { data, error } = await admin
    .from('commerce_product_launch_runs')
    .select('id, product_id, operation_id, is_tutorial, tutorial_visibility, environment, state, stages, launch_receipt, launch_receipt_hash, last_error, version, updated_at, products(name, active, type, delivery_type)')
    .eq('guild_id', auth.ctx.guildId)
    .order('updated_at', { ascending: false })
    .limit(200);
  if (error) return dbError(error, 'store/launch-runs/list');
  return NextResponse.json({ success: true, data: data ?? [] });
}

export async function POST(request: NextRequest) {
  const rateLimited = await checkAdminRateLimit(request, 'write');
  if (rateLimited) return rateLimited;
  const auth = await requireGuildOwner();
  if (!auth.ok) return auth.response;
  const parsed = await parseBody(request, launchActionSchema);
  if (!parsed.ok) return parsed.response;
  const admin = createAdminSupabase();

  if (parsed.data.action === 'create_tutorial') {
    const { data, error } = await admin.rpc('commerce_create_tutorial_launch', {
      p_guild_id: auth.ctx.guildId,
      p_actor_id: auth.ctx.discordId,
    });
    if (error) return dbError(error, 'store/launch-runs/create-tutorial');
    const tutorialRun = z.object({
      id: z.string().uuid(), product_id: z.string().uuid(), operation_id: z.string().uuid(),
    }).safeParse(data);
    if (!tutorialRun.success) return NextResponse.json({ error: 'Tutorial launch result is malformed' }, { status: 503 });
    const { error: auditError } = await admin.from('audit_logs').insert({
      guild_id: auth.ctx.guildId,
      actor_type: 'user',
      actor_id: auth.ctx.discordId,
      action: 'commerce.launch.tutorial_created',
      target_type: 'product',
      target_id: tutorialRun.data.product_id,
      details: { operation_id: tutorialRun.data.operation_id, launch_run_id: tutorialRun.data.id },
    });
    if (auditError) return dbError(auditError, 'store/launch-runs/create-tutorial-audit');
    return NextResponse.json({ success: true, data }, { status: 201 });
  }

  if (parsed.data.action === 'start') {
    const { data: product, error: productError } = await admin
      .from('products')
      .select('id, active')
      .eq('id', parsed.data.productId)
      .eq('guild_id', auth.ctx.guildId)
      .maybeSingle();
    if (productError) return dbError(productError, 'store/launch-runs/product');
    if (!product) return NextResponse.json({ error: 'Product not found' }, { status: 404 });
    if (product.active) return NextResponse.json({ error: 'Deactivate this product before starting a new launch run.' }, { status: 409 });
    if (parsed.data.tutorial) {
      await admin
        .from('commerce_product_launch_runs')
        .update({ is_tutorial: false, updated_at: new Date().toISOString() })
        .eq('guild_id', auth.ctx.guildId)
        .eq('is_tutorial', true);
    }
    const operationId = randomUUID();
    const verificationStartedAt = new Date().toISOString();
    const { data, error } = await admin
      .from('commerce_product_launch_runs')
      .upsert({
        guild_id: auth.ctx.guildId,
        product_id: product.id,
        operation_id: operationId,
        is_tutorial: parsed.data.tutorial,
        tutorial_visibility: 'visible',
        environment: 'sandbox',
        state: 'draft',
        stages: defaultLaunchStages(),
        launch_receipt: null,
        launch_receipt_hash: null,
        last_error: null,
        created_by: auth.ctx.discordId,
        updated_by: auth.ctx.discordId,
        version: 1,
        verification_started_at: verificationStartedAt,
        updated_at: verificationStartedAt,
      }, { onConflict: 'guild_id,product_id' })
      .select('*')
      .single();
    if (error) return dbError(error, 'store/launch-runs/start');
    const { error: auditError } = await writeLaunchAudit(admin, {
      guildId: auth.ctx.guildId,
      actorId: auth.ctx.discordId,
      action: 'commerce.launch.started',
      productId: product.id,
      operationId,
      details: { tutorial: parsed.data.tutorial },
    });
    if (auditError) return dbError(auditError, 'store/launch-runs/start-audit');
    return NextResponse.json({ success: true, data }, { status: 201 });
  }

  const visibility = parsed.data.action === 'hide'
    ? 'hidden'
    : parsed.data.action === 'disable'
      ? 'disabled'
      : null;
  if (parsed.data.action === 'remove') {
    const { data: current, error: currentError } = await admin
      .from('commerce_product_launch_runs')
      .select('id, product_id, operation_id')
      .eq('id', parsed.data.runId)
      .eq('guild_id', auth.ctx.guildId)
      .eq('version', parsed.data.version)
      .maybeSingle();
    if (currentError) return dbError(currentError, 'store/launch-runs/remove-read');
    if (!current) return NextResponse.json({ error: 'Launch run changed; reload before retrying' }, { status: 409 });
    const { data: removed, error } = await admin
      .from('commerce_product_launch_runs')
      .delete()
      .eq('id', parsed.data.runId)
      .eq('guild_id', auth.ctx.guildId)
      .eq('version', parsed.data.version)
      .select('id')
      .maybeSingle();
    if (error) return dbError(error, 'store/launch-runs/remove');
    if (!removed) return NextResponse.json({ error: 'Launch run changed; reload before retrying' }, { status: 409 });
    const { error: auditError } = await writeLaunchAudit(admin, {
      guildId: auth.ctx.guildId, actorId: auth.ctx.discordId,
      action: 'commerce.launch.removed', productId: current.product_id,
      operationId: current.operation_id, details: { launch_run_id: current.id },
    });
    if (auditError) return dbError(auditError, 'store/launch-runs/remove-audit');
    return NextResponse.json({ success: true });
  }

  const reset = parsed.data.action === 'restart';
  const resetAt = new Date().toISOString();
  const { data, error } = await admin
    .from('commerce_product_launch_runs')
    .update(reset ? {
      environment: 'sandbox',
      state: 'draft',
      stages: defaultLaunchStages(),
      launch_receipt: null,
      launch_receipt_hash: null,
      last_error: null,
      verification_started_at: resetAt,
      tutorial_visibility: 'visible',
      updated_by: auth.ctx.discordId,
      version: parsed.data.version + 1,
      updated_at: resetAt,
    } : {
      tutorial_visibility: visibility,
      updated_by: auth.ctx.discordId,
      version: parsed.data.version + 1,
      updated_at: new Date().toISOString(),
    })
    .eq('id', parsed.data.runId)
    .eq('guild_id', auth.ctx.guildId)
    .eq('version', parsed.data.version)
    .select('*')
    .maybeSingle();
  if (error) return dbError(error, 'store/launch-runs/update');
  if (!data) return NextResponse.json({ error: 'Launch run changed; reload before retrying' }, { status: 409 });
  const { error: auditError } = await writeLaunchAudit(admin, {
    guildId: auth.ctx.guildId, actorId: auth.ctx.discordId,
    action: `commerce.launch.${parsed.data.action}`,
    productId: data.product_id, operationId: data.operation_id,
    details: { launch_run_id: data.id, version: data.version },
  });
  if (auditError) return dbError(auditError, 'store/launch-runs/update-audit');
  return NextResponse.json({ success: true, data });
}

export async function PATCH(request: NextRequest) {
  const rateLimited = await checkAdminRateLimit(request, 'write');
  if (rateLimited) return rateLimited;
  const auth = await requireGuildOwner();
  if (!auth.ok) return auth.response;
  const parsed = await parseBody(request, launchStageSchema);
  if (!parsed.ok) return parsed.response;
  const admin = createAdminSupabase();
  const { data: run, error: runError } = await admin
    .from('commerce_product_launch_runs')
    .select('id, product_id, operation_id, stages, version')
    .eq('id', parsed.data.runId)
    .eq('guild_id', auth.ctx.guildId)
    .eq('version', parsed.data.version)
    .maybeSingle();
  if (runError) return dbError(runError, 'store/launch-runs/read');
  if (!run) return NextResponse.json({ error: 'Launch run changed; reload before retrying' }, { status: 409 });
  const existing = z.record(z.enum(['pending', 'verified', 'failed', 'not_applicable'])).safeParse(run.stages);
  if (!existing.success) return NextResponse.json({ error: 'Launch run stage data is invalid' }, { status: 503 });
  const stages = { ...defaultLaunchStages(), ...existing.data, [parsed.data.stage]: parsed.data.state };
  const { data, error } = await admin
    .from('commerce_product_launch_runs')
    .update({
      stages,
      state: parsed.data.state === 'failed' ? 'failed' : 'sandbox_verifying',
      launch_receipt: null,
      launch_receipt_hash: null,
      last_error: parsed.data.state === 'failed' ? String(parsed.data.evidence?.error ?? 'Verification failed') : null,
      verified_at: null,
      updated_by: auth.ctx.discordId,
      version: parsed.data.version + 1,
      updated_at: new Date().toISOString(),
    })
    .eq('id', run.id)
    .eq('guild_id', auth.ctx.guildId)
    .eq('version', parsed.data.version)
    .select('*')
    .maybeSingle();
  if (error) return dbError(error, 'store/launch-runs/stage');
  if (!data) return NextResponse.json({ error: 'Launch run changed; reload before retrying' }, { status: 409 });
  const { error: auditError } = await writeLaunchAudit(admin, {
    guildId: auth.ctx.guildId, actorId: auth.ctx.discordId,
    action: 'commerce.launch.stage_changed', productId: run.product_id,
    operationId: run.operation_id,
    details: {
      launch_run_id: run.id, stage: parsed.data.stage,
      state: parsed.data.state, evidence: parsed.data.evidence,
    },
  });
  if (auditError) return dbError(auditError, 'store/launch-runs/stage-audit');
  return NextResponse.json({ success: true, data });
}
