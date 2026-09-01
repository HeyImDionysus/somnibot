import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { checkAdminRateLimit } from '@/lib/api/admin-rate-limit';
import { requireGuildOwner } from '@/lib/api/require-owner';
import { dbError } from '@/lib/api/response';
import { parseBody } from '@/lib/api/validation';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { LAUNCH_STAGE_KEYS } from '@/lib/store/commerce-operations';

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
      p_guild_id: auth.ctx.guildId, p_actor_id: auth.ctx.discordId,
    });
    if (error) return dbError(error, 'store/launch-runs/create-tutorial');
    const tutorialRun = z.object({
      id: z.string().uuid(), product_id: z.string().uuid(), operation_id: z.string().uuid(),
    }).safeParse(data);
    if (!tutorialRun.success) return NextResponse.json({ error: 'Tutorial launch result is malformed' }, { status: 503 });
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
    const { data, error } = await admin.rpc('commerce_start_product_launch', {
      p_guild_id: auth.ctx.guildId, p_actor_id: auth.ctx.discordId,
      p_product_id: parsed.data.productId, p_tutorial: parsed.data.tutorial,
    });
    if (error) return dbError(error, 'store/launch-runs/start');
    if (!data) return NextResponse.json({ error: 'Product changed; reload before retrying' }, { status: 409 });
    return NextResponse.json({ success: true, data }, { status: 201 });
  }

  const { data, error } = await admin.rpc('commerce_mutate_product_launch', {
    p_guild_id: auth.ctx.guildId, p_actor_id: auth.ctx.discordId,
    p_launch_run_id: parsed.data.runId, p_expected_version: parsed.data.version, p_action: parsed.data.action,
  });
  if (error) return dbError(error, 'store/launch-runs/update');
  if (!data) return NextResponse.json({ error: 'Launch run changed; reload before retrying' }, { status: 409 });
  return parsed.data.action === 'remove'
    ? NextResponse.json({ success: true })
    : NextResponse.json({ success: true, data });
}

export async function PATCH(request: NextRequest) {
  const rateLimited = await checkAdminRateLimit(request, 'write');
  if (rateLimited) return rateLimited;
  const auth = await requireGuildOwner();
  if (!auth.ok) return auth.response;
  const parsed = await parseBody(request, launchStageSchema);
  if (!parsed.ok) return parsed.response;
  const admin = createAdminSupabase();
  const { data, error } = await admin.rpc('commerce_mutate_product_launch', {
    p_guild_id: auth.ctx.guildId, p_actor_id: auth.ctx.discordId,
    p_launch_run_id: parsed.data.runId, p_expected_version: parsed.data.version,
    p_action: 'stage', p_stage: parsed.data.stage, p_stage_state: parsed.data.state, p_evidence: parsed.data.evidence,
  });
  if (error) return dbError(error, 'store/launch-runs/stage');
  if (!data) return NextResponse.json({ error: 'Launch run changed; reload before retrying' }, { status: 409 });
  return NextResponse.json({ success: true, data });
}
