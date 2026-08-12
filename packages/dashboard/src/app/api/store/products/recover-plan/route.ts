import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { checkAdminRateLimit } from '@/lib/api/admin-rate-limit';
import { requireGuildOwner } from '@/lib/api/require-owner';
import { apiError, apiServerError, dbError } from '@/lib/api/response';
import { parseBody } from '@/lib/api/validation';
import { notifyBot } from '@/lib/notify-bot';
import { getPayPalRuntimeConfig } from '@/lib/paypal';
import { applyPayPalPolicyEnvironment, loadPayPalPolicy } from '@/lib/paypal-policy';
import { createAdminSupabase } from '@/lib/supabase/admin';
import {
  metadataWithoutPlanRecovery,
  readPlanRecovery,
  type CommercePlanRecovery,
} from '@/lib/store/commerce-plan-recovery';
import { ensurePayPalPlanState } from '@/lib/store/paypal-plan-state';

const requestSchema = z.object({ product_id: z.string().uuid() }).strict();
const productSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1),
  active: z.boolean(),
  metadata: z.unknown(),
  plans: z.array(z.object({ paypal_plan_id: z.string().nullable() }).passthrough()).optional(),
}).passthrough();
const planSchema = z.object({
  id: z.string().uuid(),
  product_id: z.string().uuid(),
  name: z.string(),
  paypal_plan_id: z.string(),
  interval_unit: z.string(),
  interval_count: z.number(),
  price_cents: z.number(),
  currency: z.string(),
  trial_days: z.number(),
  active: z.boolean(),
}).passthrough();

function planMatchesRecovery(plan: z.infer<typeof planSchema>, recovery: CommercePlanRecovery): boolean {
  return plan.id === recovery.id
    && plan.product_id === recovery.product_id
    && plan.name === recovery.name
    && plan.paypal_plan_id === recovery.paypal_plan_id
    && plan.interval_unit === recovery.interval_unit
    && plan.interval_count === recovery.interval_count
    && plan.price_cents === recovery.price_cents
    && plan.currency === recovery.currency
    && plan.trial_days === recovery.trial_days
    && plan.active === recovery.active;
}

export async function POST(request: NextRequest) {
  const rateLimited = await checkAdminRateLimit(request, 'write');
  if (rateLimited) return rateLimited;
  const auth = await requireGuildOwner();
  if (!auth.ok) return auth.response;
  const parsedRequest = await parseBody(request, requestSchema);
  if (!parsedRequest.ok) return parsedRequest.response;

  const supabase = createAdminSupabase();
  const { data: rawProduct, error: productError } = await supabase
    .from('products')
    .select('*, plans(*)')
    .eq('id', parsedRequest.data.product_id)
    .eq('guild_id', auth.ctx.guildId)
    .maybeSingle();
  if (productError) return dbError(productError, 'store/products/recover-plan');
  const parsedProduct = productSchema.safeParse(rawProduct);
  if (!parsedProduct.success) return apiError('Recovery product was not found for this server.', 404);
  const product = parsedProduct.data;
  const recovery = readPlanRecovery(product.metadata);
  if (!recovery) {
    const recovered = product.plans?.some((plan) => Boolean(plan.paypal_plan_id)) ?? false;
    return recovered
      ? NextResponse.json({ success: true, data: product, already_recovered: true })
      : apiError('This product has no pending subscription-plan recovery.', 409);
  }
  if (recovery.product_id !== product.id) {
    return apiServerError(new Error('plan recovery product identity mismatch'), 'store/products/recover-plan');
  }

  const { data: rawExistingPlan, error: existingPlanError } = await supabase
    .from('plans')
    .select('*')
    .eq('id', recovery.id)
    .eq('product_id', product.id)
    .eq('guild_id', auth.ctx.guildId)
    .maybeSingle();
  if (existingPlanError) return dbError(existingPlanError, 'store/products/recover-plan');
  if (rawExistingPlan) {
    const existingPlan = planSchema.safeParse(rawExistingPlan);
    if (!existingPlan.success || !planMatchesRecovery(existingPlan.data, recovery)) {
      return apiError('The saved recovery plan conflicts with an existing plan. The product remains inactive.', 409);
    }
  } else {
    const { data: rawInsertedPlan, error: insertError } = await supabase
      .from('plans')
      .insert({
        id: recovery.id,
        product_id: recovery.product_id,
        guild_id: auth.ctx.guildId,
        name: recovery.name,
        paypal_plan_id: recovery.paypal_plan_id,
        interval_unit: recovery.interval_unit,
        interval_count: recovery.interval_count,
        price_cents: recovery.price_cents,
        currency: recovery.currency,
        trial_days: recovery.trial_days,
        active: recovery.active,
      })
      .select('*')
      .single();
    const insertedPlan = planSchema.safeParse(rawInsertedPlan);
    if (insertError || !insertedPlan.success || !planMatchesRecovery(insertedPlan.data, recovery)) {
      return insertError
        ? dbError(insertError, 'store/products/recover-plan')
        : apiServerError(new Error('inserted plan failed authoritative verification'), 'store/products/recover-plan');
    }
  }

  const runtime = await getPayPalRuntimeConfig();
  const policy = await loadPayPalPolicy(supabase, auth.ctx.guildId);
  const paypal = applyPayPalPolicyEnvironment(runtime, policy.environment);
  const provider = await ensurePayPalPlanState(paypal, recovery.paypal_plan_id, recovery.active);
  if (!provider.ok) return apiError(provider.error, 502);

  const { data: rawRecoveredProduct, error: recoveryError } = await supabase
    .from('products')
    .update({
      active: recovery.product_active,
      metadata: metadataWithoutPlanRecovery(product.metadata),
      updated_at: new Date().toISOString(),
    })
    .eq('id', product.id)
    .eq('guild_id', auth.ctx.guildId)
    .select('*, plans(*)')
    .single();
  const recoveredProduct = productSchema.safeParse(rawRecoveredProduct);
  if (
    recoveryError
    || !recoveredProduct.success
    || recoveredProduct.data.active !== recovery.product_active
    || readPlanRecovery(recoveredProduct.data.metadata)
  ) {
    if (recovery.active) await ensurePayPalPlanState(paypal, recovery.paypal_plan_id, false);
    return recoveryError
      ? dbError(recoveryError, 'store/products/recover-plan')
      : apiServerError(new Error('product reactivation failed authoritative verification'), 'store/products/recover-plan');
  }

  await notifyBot(auth.ctx.guildId, 'commerce', { product_updated: product.id });
  return NextResponse.json({ success: true, data: recoveredProduct.data });
}
