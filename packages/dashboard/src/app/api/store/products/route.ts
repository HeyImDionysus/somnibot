/**
 * /api/store/products — Product CRUD with PayPal Catalog sync.
 *
 * GET: List all products for the guild
 * POST: Create a new product (auto-creates PayPal Catalog Product)
 * PUT: Update a product (syncs PayPal if name/description changed)
 * DELETE: Deactivate a product (soft delete; preserves entitlements)
 */
import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { requireGuildOwner } from '@/lib/api/require-owner';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { notifyBot } from '@/lib/notify-bot';

import { getPayPalRuntimeConfig, getPayPalToken, type PayPalRuntimeConfig } from '@/lib/paypal';
import { applyPayPalPolicyEnvironment, loadPayPalPolicy } from '@/lib/paypal-policy';
import { parseBody, schemas } from '@/lib/api/validation';
import { checkAdminRateLimit } from '@/lib/api/admin-rate-limit';
import { dbError, apiError, apiServerError } from '@/lib/api/response';
import {
  readRowBefore,
  recordAdminChange,
  recordCrudChange,
  undoByRestoring,
} from '@/lib/admin-changes';
import {
  assertProductRolesNotIncomeEarning,
  COMMERCE_INCOME_WALL_MESSAGE,
  evaluateEffectivePostWriteProduct,
  isCommerceIncomeWallConflictError,
  loadProductPlans,
  loadProductTemporaryRoleIds,
  type PlanWallFields,
} from '@/lib/api/commerce-income-wall';
import {
  ensureLicenseDeliveryConfigOrDisable,
  requiresLicenseConfig,
} from '@/lib/api/license-delivery-rail';
import { validateAssignableDiscordTargets } from '@/lib/api/live-discord-facts';
import {
  defaultStoreProductFacets,
  evaluateStoreProductPolicy,
  storeProductFacetsSchema,
  validateStoreProductChoice,
  type StoreProductPolicy,
} from '@/lib/store/store-product-policy';
import {
  metadataWithPlanRecovery,
  readPlanRecovery,
  type CommercePlanRecovery,
} from '@/lib/store/commerce-plan-recovery';
import { ensurePayPalPlanState } from '@/lib/store/paypal-plan-state';
import { writeCommerceAudit } from '@/lib/commerce-audit';
import {
  declaresPendingCompletedProjectPolicy,
  hasPendingCompletedProjectPolicy,
  readCompletedProjectPolicy,
  readCompletedProjectLicensingMetadata,
} from '@/lib/store/licensing-handoff';

// ── PayPal Helpers ─────────────────────────────────────

type PayPalSyncResult =
  | { ok: true; id: string }
  | { ok: false; error: string };

interface PreparedPlan {
  id: string;
  name: string;
  intervalUnit: 'DAY' | 'WEEK' | 'MONTH' | 'YEAR';
  intervalCount: number;
  priceCents: number;
  trialDays: number;
  active: boolean;
  paypalPlanId: string | null;
}

type PayPalPlanCreation = {
  readonly paypalProductId: string;
  readonly name: string;
  readonly priceCents: number;
  readonly currency: string;
  readonly intervalUnit: 'DAY' | 'WEEK' | 'MONTH' | 'YEAR';
  readonly intervalCount: number;
  readonly trialDays: number;
  readonly active: boolean;
};

function commerceWriteError(error: { message: string; code?: string }) {
  if (isCommerceIncomeWallConflictError(error)) {
    return apiError(COMMERCE_INCOME_WALL_MESSAGE, 409);
  }
  return dbError(error, 'store/products');
}

function hasUnresolvedCapabilityPlanGrants(metadata: unknown): boolean {
  const licensing = readCompletedProjectLicensingMetadata(metadata);
  return licensing?.capabilities.some((capability) => (
    capability.grantingPlans.some((plan) => !plan.planId)
  )) ?? false;
}

/**
 * `1999, 'USD'` → `"19.99 USD"`.
 *
 * Written out in full for the admin-changes sentence so an owner reading their
 * change history sees the REAL-MONEY amount a customer is charged. This store
 * is not the in-server coin economy; a bare number there would be ambiguous.
 */
function formatRealMoney(cents: number, currency: string): string {
  const whole = Math.trunc(Math.abs(cents) / 100);
  const fraction = String(Math.abs(cents) % 100).padStart(2, '0');
  return `${cents < 0 ? '-' : ''}${whole}.${fraction} ${currency.toUpperCase()}`;
}

/** Product columns whose change alters what a customer pays or can buy. */
const PRODUCT_MONEY_FIELDS = ['price_cents', 'currency', 'active', 'type'] as const;

function paypalNotReadyResponse(message: string) {
  return NextResponse.json(
    {
      success: false,
      error: message,
    },
    { status: 424 },
  );
}

async function discordTargetsResponse(
  supabase: ReturnType<typeof createAdminSupabase>,
  guildId: string,
  roleIds: string[],
  channelIds: string[],
): Promise<NextResponse | null> {
  const validation = await validateAssignableDiscordTargets(
    supabase,
    guildId,
    roleIds,
    channelIds,
  );
  if (validation.ok) return null;

  return NextResponse.json(
    {
      success: false,
      code: validation.kind === 'unavailable'
        ? 'LIVE_STATE_UNAVAILABLE'
        : 'LIVE_DISCORD_CONFLICT',
      error: validation.issues.join(' '),
      issues: validation.issues,
    },
    { status: validation.kind === 'unavailable' ? 503 : 409 },
  );
}

function paypalReadinessError(config: PayPalRuntimeConfig, target: 'paid products' | 'subscription plans') {
  const missing = [
    !config.clientId ? 'Client ID' : null,
    !config.clientSecret ? 'Client Secret' : null,
    !config.webhookId ? 'Webhook ID' : null,
  ].filter((field): field is string => field !== null);

  if (missing.length === 0) return null;

  return `PayPal is not ready. Configure PayPal ${missing.join(', ')} before creating ${target}.`;
}

async function loadStoreProductPolicy(
  supabase: ReturnType<typeof createAdminSupabase>,
  guildId: string,
): Promise<StoreProductPolicy | NextResponse> {
  const { data, error } = await supabase
    .from('guild_config')
    .select('product_types_enabled')
    .eq('guild_id', guildId)
    .maybeSingle();
  if (error) return dbError(error, 'store/products/policy');
  if (!data) return evaluateStoreProductPolicy(defaultStoreProductFacets);
  const parsedFacets = storeProductFacetsSchema.safeParse(data.product_types_enabled);
  if (!parsedFacets.success) {
    return apiServerError(new Error('stored Storefront product policy is invalid'), 'store/products/policy');
  }
  const facets = parsedFacets.data;
  return evaluateStoreProductPolicy(facets);
}

/**
 * Create a PayPal Catalog Product.
 * Returns the PayPal product ID.
 */
async function createPayPalCatalogProduct(
  name: string,
  description: string | null,
  type: 'one_time' | 'subscription',
  paypalConfig: PayPalRuntimeConfig,
  requestId: string,
): Promise<PayPalSyncResult> {
  const readinessError = paypalReadinessError(paypalConfig, 'paid products');
  if (readinessError) {
    return { ok: false, error: readinessError };
  }

  const token = await getPayPalToken(paypalConfig);
  if (!token) {
    return {
      ok: false,
      error: 'PayPal token request failed. Check the PayPal Client ID, Client Secret, and sandbox/live mode before creating paid products.',
    };
  }

  try {
    const paypalType = type === 'subscription' ? 'SERVICE' : 'DIGITAL';
    const res = await fetch(`${paypalConfig.apiBase}/v1/catalogs/products`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        'PayPal-Request-Id': `store-product-${requestId}`,
      },
      body: JSON.stringify({
        name: name.slice(0, 127), // PayPal max 127 chars
        description: (description ?? name).slice(0, 256), // PayPal max 256 chars
        type: paypalType,
        category: 'SOFTWARE',
      }),
    });

    if (!res.ok) {
      const errorText = await res.text();
      console.error('[Products] PayPal catalog creation failed:', errorText);
      return {
        ok: false,
        error: 'PayPal catalog product creation failed. Check the PayPal app credentials and try again.',
      };
    }

    const data = await res.json();
    if (typeof data.id !== 'string' || data.id.trim() === '') {
      return {
        ok: false,
        error: 'PayPal did not return a catalog product ID. Check the PayPal app and try again.',
      };
    }
    return { ok: true, id: data.id };
  } catch (err) {
    console.error('[Products] PayPal catalog creation error:', err);
    return {
      ok: false,
      error: 'PayPal catalog product creation failed. Check the PayPal app credentials and try again.',
    };
  }
}

/**
 * Create a PayPal Billing Plan for a subscription product.
 */
async function createPayPalBillingPlan(
  input: PayPalPlanCreation,
  paypalConfig: PayPalRuntimeConfig,
  requestId: string,
): Promise<PayPalSyncResult> {
  const readinessError = paypalReadinessError(paypalConfig, 'subscription plans');
  if (readinessError) {
    return { ok: false, error: readinessError };
  }

  const token = await getPayPalToken(paypalConfig);
  if (!token) {
    return {
      ok: false,
      error: 'PayPal token request failed. Check the PayPal Client ID, Client Secret, and sandbox/live mode before creating subscription plans.',
    };
  }

  try {
    const res = await fetch(`${paypalConfig.apiBase}/v1/billing/plans`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        'PayPal-Request-Id': `store-plan-${requestId}`,
      },
      body: JSON.stringify({
        product_id: input.paypalProductId,
        name: input.name.slice(0, 127),
        status: input.active ? 'ACTIVE' : 'INACTIVE',
        billing_cycles: [
          ...(input.trialDays > 0 ? [{
            frequency: { interval_unit: 'DAY', interval_count: 1 },
            tenure_type: 'TRIAL',
            sequence: 1,
            total_cycles: input.trialDays,
            pricing_scheme: {
              fixed_price: { value: '0.00', currency_code: input.currency.toUpperCase() },
            },
          }] : []),
          {
            frequency: {
              interval_unit: input.intervalUnit.toUpperCase(), // DAY, WEEK, MONTH, YEAR
              interval_count: input.intervalCount,
            },
            tenure_type: 'REGULAR',
            sequence: input.trialDays > 0 ? 2 : 1,
            total_cycles: 0, // Infinite
            pricing_scheme: {
              fixed_price: {
                value: (input.priceCents / 100).toFixed(2),
                currency_code: input.currency.toUpperCase(),
              },
            },
          },
        ],
        payment_preferences: {
          auto_bill_outstanding: true,
          payment_failure_threshold: 3,
        },
      }),
    });

    if (!res.ok) {
      const errorText = await res.text();
      console.error('[Products] PayPal plan creation failed:', errorText);
      return {
        ok: false,
        error: 'PayPal billing plan creation failed. Check the PayPal app credentials and try again.',
      };
    }

    const data = await res.json();
    if (typeof data.id !== 'string' || data.id.trim() === '') {
      return {
        ok: false,
        error: 'PayPal did not return a billing plan ID. Check the PayPal app and try again.',
      };
    }
    return { ok: true, id: data.id };
  } catch (err) {
    console.error('[Products] PayPal plan creation error:', err);
    return {
      ok: false,
      error: 'PayPal billing plan creation failed. Check the PayPal app credentials and try again.',
    };
  }
}

// ── Route Handlers ──────────────────────────────────────

export async function GET(req: NextRequest) {
  const auth = await requireGuildOwner();
  if (!auth.ok) return auth.response;
  const { guildId } = auth.ctx;

  const supabase = createAdminSupabase();

  const { data, error } = await supabase
    .from('products')
    .select('*, plans(*), product_license_config(*), product_files(*)')
    .eq('guild_id', guildId)
    .order('sort_order', { ascending: true })
    .limit(500);

  if (error) {
    const occurrenceId = req.headers.get('x-request-id')?.trim() || crypto.randomUUID();
    await writeCommerceAudit(supabase, {
      guildId,
      actorId: auth.ctx.discordId,
      action: 'commerce.store.load_failed',
      targetType: 'store',
      targetId: guildId,
      details: { stage: 'products_query', error_code: error.code ?? null },
      occurrenceKey: `commerce.store.load_failed:${guildId}:${occurrenceId}`,
      success: false,
    });
    return dbError(error, 'store/products');
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
  const parsed = await parseBody(req, schemas.product.create);
  if (!parsed.ok) return parsed.response;
  const body = parsed.data;
  const requestedOperationId = req.headers.get('x-request-id')?.trim();

  const {
    id: requestedProductId,
    name,
    description,
    type,
    delivery_type,
    price_cents,
    currency,
    granted_role_ids,
    granted_channel_ids,
    sort_order,
    metadata,
    plans: planDefs, // Optional: plan definitions for subscription products
  } = body;
  const operationId = requestedProductId ?? (requestedOperationId || crypto.randomUUID());

  if (
    delivery_type === 'license_key'
    && declaresPendingCompletedProjectPolicy(metadata)
    && !readCompletedProjectPolicy(metadata)
  ) {
    return apiError('The requested license policy contains values the Store cannot save.', 400);
  }
  if (requestedProductId) {
    const { data: existing, error: existingError } = await supabase
      .from('products')
      .select('*, plans(*), product_license_config(*)')
      .eq('id', requestedProductId)
      .eq('guild_id', guildId)
      .maybeSingle();
    if (existingError) return dbError(existingError, 'store/products');
    if (existing) {
      const recoveryPlan = readPlanRecovery(existing.metadata);
      if (recoveryPlan) {
        return NextResponse.json({
          success: false,
          code: 'PRODUCT_CREATED_PLAN_SAVE_FAILED',
          error: 'The preserved product still needs its local subscription plan. Resume and verify the saved recovery contract before activation.',
          data: {
            id: existing.id,
            name: existing.name,
            paypal_product_id: existing.paypal_product_id,
            recovery_plan: recoveryPlan,
          },
        }, { status: 409 });
      }
      return NextResponse.json({
        success: true,
        data: existing,
        replayed: true,
      });
    }
  }

  if (!name || !type || !delivery_type || price_cents == null) {
    return NextResponse.json(
      { success: false, error: 'Missing required fields: name, type, delivery_type, price_cents' },
      { status: 400 },
    );
  }

  const storePolicy = await loadStoreProductPolicy(supabase, guildId);
  if (storePolicy instanceof NextResponse) return storePolicy;
  const productChoice = validateStoreProductChoice(storePolicy, {
    type,
    deliveryType: delivery_type,
    grantedRoleIds: granted_role_ids ?? [],
    grantedChannelIds: granted_channel_ids ?? [],
  });
  if (!productChoice.ok) return apiError(productChoice.error, 409);

  const normalizedPlanDefs = (type === 'subscription' ? (planDefs ?? []) : []).map(
    (planDef) => ({
      id: planDef.id,
      name: planDef.name,
      intervalUnit: planDef.interval_unit ?? 'MONTH',
      intervalCount: planDef.interval_count ?? 1,
      priceCents: planDef.price_cents ?? price_cents,
      trialDays: planDef.trial_days ?? 0,
      active: planDef.active ?? true,
    }),
  );
  const hasPaidSubscriptionPlan = type === 'subscription'
    && normalizedPlanDefs.some((planDef) => planDef.priceCents > 0);
  const requiresPayPal = type !== 'free' && (price_cents > 0 || hasPaidSubscriptionPlan);

  if (type === 'subscription' && requiresPayPal && normalizedPlanDefs.length === 0) {
    normalizedPlanDefs.push({
      id: undefined,
      name: `${name} — MONTH`,
      intervalUnit: 'MONTH',
      intervalCount: 1,
      priceCents: price_cents,
      trialDays: 0,
      active: true,
    });
  }

  // Freeze stable local plan IDs before the wall check. Every plan that this
  // request will create at PayPal is represented as PayPal-backed now, before
  // any external side effect. This includes an explicit zero-price plan under
  // a positive-price subscription parent.
  const preparedPlans: PreparedPlan[] = normalizedPlanDefs.map((planDef) => {
    const id = planDef.id ?? crypto.randomUUID();
    return {
      id,
      name: planDef.name ?? `${name} — ${planDef.intervalUnit}`,
      intervalUnit: planDef.intervalUnit,
      intervalCount: planDef.intervalCount,
      priceCents: planDef.priceCents,
      trialDays: planDef.trialDays,
      active: planDef.active,
      paypalPlanId: requiresPayPal ? `pending-paypal-plan:${id}` : null,
    };
  });

  try {
    const evaluation = evaluateEffectivePostWriteProduct(
      {
        type,
        active: false,
        price_cents,
        granted_role_ids: granted_role_ids ?? [],
      },
      preparedPlans.map<PlanWallFields>((plan) => ({
        id: plan.id,
        active: plan.active,
        price_cents: plan.priceCents,
        paypal_plan_id: plan.paypalPlanId,
      })),
      [],
    );
    const wall = await assertProductRolesNotIncomeEarning(
      supabase,
      guildId,
      evaluation,
    );
    if (!wall.ok) return apiError(wall.message, 409);
  } catch (err) {
    return apiServerError(err, 'store/products');
  }

  // Live-target validation applies to products that will actually SELL. A
  // draft (active: false) is not purchasable, the income wall already accounts
  // for its inactive state, and validating here blocked owners from preparing
  // drafts while the bot was offline (503) or before Discord permissions were
  // finished (409). Activation re-validates: the PUT handler checks targets
  // whenever a product becomes active.
  let paypalProductId: string | null = null;
  let tenantPayPalConfig: PayPalRuntimeConfig | null = null;
  if (requiresPayPal) {
    const runtimeConfig = await getPayPalRuntimeConfig();
    const paypalPolicy = await loadPayPalPolicy(supabase, guildId);
    tenantPayPalConfig = applyPayPalPolicyEnvironment(runtimeConfig, paypalPolicy.environment);
    const paypalProduct = await createPayPalCatalogProduct(
      name,
      description ?? null,
      type === 'subscription' ? 'subscription' : 'one_time',
      tenantPayPalConfig,
      operationId,
    );
    if (!paypalProduct.ok) {
      await writeCommerceAudit(supabase, {
        guildId,
        actorId: auth.ctx.discordId,
        action: 'commerce.store.provider_failed',
        targetType: 'product_create',
        targetId: operationId,
        details: { stage: 'paypal_catalog_create', product_type: type },
        occurrenceKey: `commerce.store.provider_failed:${guildId}:${operationId}:catalog`,
        success: false,
      });
      return paypalNotReadyResponse(paypalProduct.error);
    }
    paypalProductId = paypalProduct.id;
  }

  if (type === 'subscription' && requiresPayPal && paypalProductId && tenantPayPalConfig) {
    for (const [planIndex, plan] of preparedPlans.entries()) {
      const paypalPlan = await createPayPalBillingPlan({
        paypalProductId,
        name: plan.name,
        priceCents: plan.priceCents,
        currency: currency ?? 'USD',
        intervalUnit: plan.intervalUnit,
        intervalCount: plan.intervalCount,
        trialDays: plan.trialDays,
        active: plan.active,
      }, tenantPayPalConfig, `${operationId}-${planIndex}`);
      if (!paypalPlan.ok) {
        await writeCommerceAudit(supabase, {
          guildId,
          actorId: auth.ctx.discordId,
          action: 'commerce.store.provider_failed',
          targetType: 'plan_create',
          targetId: plan.id,
          details: { stage: 'paypal_plan_create', operation_id: operationId },
          occurrenceKey: `commerce.store.provider_failed:${guildId}:${operationId}:plan:${plan.id}`,
          success: false,
        });
        return paypalNotReadyResponse(paypalPlan.error);
      }
      plan.paypalPlanId = paypalPlan.id;
    }
  }

  // Create the product only after PayPal and the friendly wall precheck pass.
  // Reserved legacy role metadata has already been rejected by validation.
  const { data, error } = await supabase
    .from('products')
    .insert({
      ...(requestedProductId ? { id: requestedProductId } : {}),
      guild_id: guildId,
      name,
      description: description ?? null,
      type,
      delivery_type,
      paypal_product_id: paypalProductId,
      price_cents,
      currency: currency ?? 'USD',
      granted_role_ids: granted_role_ids ?? [],
      granted_channel_ids: granted_channel_ids ?? [],
      active: false,
      sort_order: sort_order ?? 0,
      metadata: metadata ?? {},
    })
    .select()
    .single();

  if (error) {
    return commerceWriteError(error);
  }
  if (!data) {
    return apiServerError(new Error('product insert returned no row'), 'store/products');
  }

  // Finding 6: a licence-key product with no product_license_config takes the
  // money and delivers no key. The DB trigger provisions it; verify the rail
  // actually held for THIS product before reporting the product as created.
  if (requiresLicenseConfig(delivery_type)) {
    const rail = await ensureLicenseDeliveryConfigOrDisable(supabase, guildId, data.id);
    if (!rail.ok) {
      return NextResponse.json({
        success: false,
        code: 'PRODUCT_CREATED_LICENSE_POLICY_FAILED',
        error: rail.message,
        data: {
          id: data.id,
          name: data.name,
          paypal_product_id: data.paypal_product_id,
        },
      }, { status: 500 });
    }
  }

  // Persist the exact local IDs and PayPal-backed plan set evaluated above.
  const savedPlans: { id: string; paypalPlanId: string }[] = [];

  if (type === 'subscription' && requiresPayPal && paypalProductId) {
    for (const planDef of preparedPlans) {
      const { data: plan, error: planError } = await supabase
        .from('plans')
        .insert({
          id: planDef.id,
          product_id: data.id,
          guild_id: guildId,
          name: planDef.name,
          paypal_plan_id: planDef.paypalPlanId,
          interval_unit: planDef.intervalUnit,
          interval_count: planDef.intervalCount,
          price_cents: planDef.priceCents,
          currency: currency ?? 'USD',
          trial_days: planDef.trialDays,
          active: planDef.active,
        })
        .select('id')
        .single();

      if (planError) {
        const base = commerceWriteError(planError);
        if (!planDef.paypalPlanId || !tenantPayPalConfig) {
          return apiServerError(new Error('plan recovery identity was missing'), 'store/products');
        }
        const recovery: CommercePlanRecovery = {
          id: planDef.id,
          product_id: data.id,
          product_active: false,
          name: planDef.name,
          paypal_plan_id: planDef.paypalPlanId,
          interval_unit: planDef.intervalUnit,
          interval_count: planDef.intervalCount,
          price_cents: planDef.priceCents,
          currency: currency ?? 'USD',
          trial_days: planDef.trialDays,
          active: planDef.active,
        };
        const recoveryMetadata = metadataWithPlanRecovery(data.metadata ?? metadata, recovery);
        const { data: disabledProduct, error: deactivateError } = await supabase
          .from('products')
          .update({
            active: false,
            metadata: recoveryMetadata,
            updated_at: new Date().toISOString(),
          })
          .eq('id', data.id)
          .eq('guild_id', guildId)
          .select('id, active, metadata')
          .single();
        const savedRecovery = readPlanRecovery(disabledProduct?.metadata);
        if (
          deactivateError
          || !disabledProduct
          || disabledProduct.active !== false
          || savedRecovery?.id !== recovery.id
        ) {
          return apiServerError(
            new Error('plan persistence and durable product compensation both failed'),
            'store/products',
          );
        }
        const providerCompensation = await ensurePayPalPlanState(
          tenantPayPalConfig,
          planDef.paypalPlanId,
          false,
        );
        return NextResponse.json({
          success: false,
          code: providerCompensation.ok
            ? 'PRODUCT_CREATED_PLAN_SAVE_FAILED'
            : 'PRODUCT_CREATED_PLAN_COMPENSATION_FAILED',
          error: providerCompensation.ok
            ? 'The product and PayPal plan were made inactive after local plan persistence failed. Retry to reconcile and verify both systems.'
            : `${providerCompensation.error} The local product is inactive and its saved recovery contract remains available for retry.`,
          data: {
            id: data.id,
            name: data.name,
            paypal_product_id: data.paypal_product_id,
            recovery_plan: recovery,
          },
        }, { status: base.status });
      }
      if (!plan || !planDef.paypalPlanId) {
        return apiServerError(new Error('plan insert returned no row'), 'store/products');
      }
      savedPlans.push({ id: plan.id, paypalPlanId: planDef.paypalPlanId });
    }
  }

  // Fetch final product with relations
  const { data: fullProduct } = await supabase
    .from('products')
    .select('*, plans(*), product_license_config(*)')
    .eq('id', data.id)
    .single();

  const { error: launchRunError } = await supabase
    .from('commerce_product_launch_runs')
    .upsert({
      guild_id: guildId,
      product_id: data.id,
      operation_id: randomUUID(),
      is_tutorial: false,
      tutorial_visibility: 'visible',
      environment: 'sandbox',
      state: 'draft',
      created_by: auth.ctx.discordId,
      updated_by: auth.ctx.discordId,
    }, { onConflict: 'guild_id,product_id', ignoreDuplicates: true });
  if (launchRunError) return dbError(launchRunError, 'store/products/launch-run');

  // Notify bot about new product
  await notifyBot(guildId, 'commerce', { product_created: data.id });

  // Recorded only now: the product row, its PayPal catalog entry and every
  // plan are already committed, so this describes something that really exists.
  await recordAdminChange(
    {
      guildId,
      actorId: auth.ctx.discordId,
      action: 'store.product_created',
      targetType: 'store product',
      targetId: data.id,
      description:
        `Created the store product "${name}" — `
        + (price_cents > 0
          ? `customers pay ${formatRealMoney(price_cents, currency ?? 'USD')} in real money for it`
          : 'it is free, so no payment is taken')
        + (savedPlans.length > 0
          ? `, billed on ${savedPlans.length} subscription plan${savedPlans.length === 1 ? '' : 's'}`
          : ''),
      after: data as unknown as Record<string, unknown>,
      blastRadius: 'medium',
      undoReason:
        'a newly created store product cannot be removed by an undo — deactivate it from the Store page instead'
        + (paypalProductId ? ', and its PayPal catalog entry stays in your PayPal account' : ''),
    },
    supabase,
  );

  return NextResponse.json({
    success: true,
    data: fullProduct ?? data,
    paypal_synced: !!paypalProductId,
    plans_created: savedPlans.length,
  });
}

export async function PUT(req: NextRequest) {
  const rateLimited = await checkAdminRateLimit(req, 'write');
  if (rateLimited) return rateLimited;

  const auth = await requireGuildOwner();
  if (!auth.ok) return auth.response;
  const { guildId } = auth.ctx;

  const supabase = createAdminSupabase();
  const parsed = await parseBody(req, schemas.product.update);
  if (!parsed.ok) return parsed.response;
  const body = parsed.data;

  const { id, ...updates } = body;

  if (!id) {
    return NextResponse.json({ success: false, error: 'Missing product id' }, { status: 400 });
  }
  const includesCompletedProjectMetadata = updates.metadata
    && Object.prototype.hasOwnProperty.call(updates.metadata, 'completed_project_licensing');

  if (
    'granted_role_ids' in updates
    || 'granted_channel_ids' in updates
    || 'delivery_type' in updates
    || 'type' in updates
    || 'metadata' in updates
    || updates.active === true
  ) {
    const { data: currentTargets, error: currentTargetsError } = await supabase
      .from('products')
      .select('type, delivery_type, granted_role_ids, granted_channel_ids, active, metadata')
      .eq('id', id)
      .eq('guild_id', guildId)
      .maybeSingle();
    if (currentTargetsError) return dbError(currentTargetsError, 'store/products/live-targets');
    if (!currentTargets) return apiError('Product not found for this guild', 404);
    const convertingToDynamic = updates.delivery_type === 'license_key'
      && currentTargets.delivery_type !== 'license_key';
    if (includesCompletedProjectMetadata) {
      const validConversionLock = convertingToDynamic
        && updates.active === false
        && hasPendingCompletedProjectPolicy(updates.metadata)
        && readCompletedProjectPolicy(updates.metadata) !== null;
      if (!validConversionLock) {
        return apiError('Completed-project licensing recovery metadata is server-managed.', 400);
      }
      updates.metadata = { ...currentTargets.metadata, ...updates.metadata };
    }
    if (convertingToDynamic && !includesCompletedProjectMetadata) {
      return apiError('Dynamic conversion must remain inactive until its requested license policy is saved.', 409);
    }
    if (updates.metadata && hasPendingCompletedProjectPolicy(currentTargets.metadata)) {
      return apiError('Complete license policy recovery before replacing product metadata.', 409);
    }
    if (updates.active === true && hasPendingCompletedProjectPolicy(currentTargets.metadata)) {
      return apiError('Save and verify the requested license policy before activating this product.', 409);
    }
    if (updates.active === true) {
      const { data: launchRun, error: launchRunError } = await supabase
        .from('commerce_product_launch_runs')
        .select('state, launch_receipt_hash')
        .eq('guild_id', guildId)
        .eq('product_id', id)
        .maybeSingle();
      if (launchRunError) return dbError(launchRunError, 'store/products/launch-readiness');
      if (!launchRun) {
        return apiError('Start a Product Launch Run before activation.', 409);
      }
      if (launchRun.state !== 'ready' || !launchRun.launch_receipt_hash) {
        return apiError('Finish the Product Launch Run and verify its sandbox reversal before activation.', 409);
      }
    }
    if (
      updates.active === true
      && hasUnresolvedCapabilityPlanGrants(updates.metadata ?? currentTargets.metadata)
    ) {
      return apiError('Resolve every capability grant to a saved subscription plan before activation.', 409);
    }

    const storePolicy = await loadStoreProductPolicy(supabase, guildId);
    if (storePolicy instanceof NextResponse) return storePolicy;
    const productChoice = validateStoreProductChoice(storePolicy, {
      type: updates.type ?? currentTargets.type,
      deliveryType: updates.delivery_type ?? currentTargets.delivery_type,
      grantedRoleIds: updates.granted_role_ids ?? currentTargets.granted_role_ids ?? [],
      grantedChannelIds: updates.granted_channel_ids ?? currentTargets.granted_channel_ids ?? [],
    });
    if (!productChoice.ok) return apiError(productChoice.error, 409);

    // Drafts stay editable while the bot is offline or Discord permissions
    // are unfinished; the gate that matters is ACTIVATION. Validate whenever
    // the product will be active after this update — which covers both
    // flipping a draft live (explicit active: true) and editing the targets
    // of an already-active product. Editing a draft that stays a draft skips
    // the live check entirely.
    const willBeActive = updates.active === true
      || (updates.active === undefined && currentTargets.active === true);
    if (willBeActive) {
      const roles = 'granted_role_ids' in updates
        ? updates.granted_role_ids ?? []
        : currentTargets.granted_role_ids ?? [];
      const channels = 'granted_channel_ids' in updates
        ? updates.granted_channel_ids ?? []
        : currentTargets.granted_channel_ids ?? [];
      const discordTargetsError = await discordTargetsResponse(
        supabase,
        guildId,
        roles,
        channels,
      );
      if (discordTargetsError) return discordTargetsError;
    }
  }

  const WALL_TRIGGER_FIELDS = [
    'granted_role_ids',
    'type',
    'active',
    'price_cents',
  ] as const;
  if (WALL_TRIGGER_FIELDS.some((f) => f in updates)) {
    const { data: existing, error: existingErr } = await supabase
      .from('products')
      .select('type, granted_role_ids, active, price_cents')
      .eq('id', id)
      .eq('guild_id', guildId)
      .maybeSingle();
    if (existingErr) {
      return dbError(existingErr, 'store/products');
    }
    if (!existing) {
      return apiError('Product not found for this guild', 404);
    }

    const pick = <K extends string>(key: K, fallback: unknown) =>
      (key in updates ? (updates as Record<string, unknown>)[key] : fallback);

    const effectiveType = pick('type', existing.type) as string | undefined;
    const effectiveActive = pick('active', existing.active) as boolean | undefined;
    const effectivePrice = pick('price_cents', existing.price_cents) as number | undefined;
    const effectiveRoles = pick('granted_role_ids', existing.granted_role_ids) as
      | string[]
      | undefined;

    try {
      const plans = effectiveType === 'subscription'
        ? await loadProductPlans(supabase, guildId, id)
        : [];
      const temporaryRoleIds = await loadProductTemporaryRoleIds(supabase, guildId, id);
      const evaluation = evaluateEffectivePostWriteProduct(
        {
          type: effectiveType as string,
          active: effectiveActive as boolean,
          price_cents: effectivePrice as number,
          granted_role_ids: effectiveRoles as string[],
        },
        plans,
        temporaryRoleIds,
      );
      const wall = await assertProductRolesNotIncomeEarning(
        supabase,
        guildId,
        evaluation,
      );
      if (!wall.ok) return apiError(wall.message, 409);
    } catch (err) {
      return apiServerError(err, 'store/products');
    }
  }

  // `updates` contains ONLY the writable product columns: schemas.product.update
  // is a `.strict()` schema, so any other key (paypal_product_id, guild_id,
  // created_at, plans, …) is rejected by parseBody above before we get here.
  // That strict schema — not this handler — is the mass-assignment guard: only
  // the intended columns can ever reach `.update()`. We stamp updated_at
  // ourselves so the client can never spoof it.
  //
  // Read the prior row BEFORE the write: afterwards it is gone, and an undo
  // built from the post-write row would "restore" the values just written.
  const before = await readRowBefore(supabase, 'products', { id, guild_id: guildId });

  const { data, error } = await supabase
    .from('products')
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq('id', id)
    .eq('guild_id', guildId)
    .select()
    .single();

  if (error) {
    return commerceWriteError(error);
  }

  // Finding 6: switching an existing product to licence-key delivery must not
  // leave it unable to deliver a key either.
  if (requiresLicenseConfig(updates.delivery_type)) {
    const rail = await ensureLicenseDeliveryConfigOrDisable(supabase, guildId, id);
    if (!rail.ok) return apiError(rail.message, 500);
  }

  // Notify bot so it hot-reloads product changes
  await notifyBot(guildId, 'commerce', { product_updated: id });

  await recordCrudChange(
    {
      guildId,
      actorId: auth.ctx.discordId,
      operation: 'updated',
      action: 'store.product_updated',
      table: 'products',
      targetType: 'store product',
      targetId: id,
      label: (before?.name as string | undefined)
        ?? (data as { name?: string } | null)?.name,
      before,
      after: updates as Record<string, unknown>,
      match: { id, guild_id: guildId },
      // Price / availability edits change what real customers are charged or
      // can buy, so undoing one is worth a confirmation step.
      blastRadius: PRODUCT_MONEY_FIELDS.some((field) => field in updates)
        ? 'high'
        : 'medium',
    },
    supabase,
  );

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
    return NextResponse.json({ success: false, error: 'Missing product id' }, { status: 400 });
  }

  // Read first: after the write the prior `active` value is unrecoverable, and
  // it is the one thing that makes this change genuinely undoable.
  const { data: before, error: readError } = await supabase
    .from('products')
    .select('id, name, active')
    .eq('id', id)
    .eq('guild_id', guildId)
    .maybeSingle();

  if (readError) {
    return commerceWriteError(readError);
  }

  if (!before) {
    return NextResponse.json(
      { success: false, error: 'Product not found' },
      { status: 404 },
    );
  }

  // Soft delete — deactivate instead of hard delete to preserve entitlements
  const { error } = await supabase
    .from('products')
    .update({ active: false, updated_at: new Date().toISOString() })
    .eq('id', id)
    .eq('guild_id', guildId);

  if (error) {
    return commerceWriteError(error);
  }

  // Notify bot so deactivated product is no longer purchasable
  await notifyBot(guildId, 'commerce', { product_deactivated: id });

  // This is an UPDATE, not a delete — the row still exists with active=false,
  // so restoring the prior flag is a real reversal, not a resurrection.
  await recordAdminChange(
    {
      guildId,
      actorId: auth.ctx.discordId,
      action: 'store.product_deactivated',
      targetType: 'store product',
      targetId: id,
      description:
        `Deactivated the store product "${(before.name as string | null) ?? id}" — `
        + 'customers can no longer buy it. Everyone who already bought it keeps their access.',
      before: { active: before.active },
      after: { active: false },
      blastRadius: 'high',
      undo: undoByRestoring(
        'products',
        { id, guild_id: guildId },
        { active: before.active },
      ),
    },
    supabase,
  );

  return NextResponse.json({ success: true });
}
