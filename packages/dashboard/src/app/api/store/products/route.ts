/**
 * /api/store/products — Product CRUD with PayPal Catalog sync.
 *
 * GET: List all products for the guild
 * POST: Create a new product (auto-creates PayPal Catalog Product)
 * PUT: Update a product (syncs PayPal if name/description changed)
 * DELETE: Deactivate a product (soft delete; preserves entitlements)
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireGuildOwner } from '@/lib/api/require-owner';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { notifyBot } from '@/lib/notify-bot';

import { getPayPalRuntimeConfig, getPayPalToken, type PayPalRuntimeConfig } from '@/lib/paypal';
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

// ── PayPal Helpers ─────────────────────────────────────

type PayPalSyncResult =
  | { ok: true; id: string }
  | { ok: false; error: string };

interface PreparedPlan {
  id: string;
  name: string;
  intervalUnit: string;
  intervalCount: number;
  priceCents: number;
  paypalPlanId: string | null;
}

function commerceWriteError(error: { message: string; code?: string }) {
  if (isCommerceIncomeWallConflictError(error)) {
    return apiError(COMMERCE_INCOME_WALL_MESSAGE, 409);
  }
  return dbError(error, 'store/products');
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

/**
 * Create a PayPal Catalog Product.
 * Returns the PayPal product ID.
 */
async function createPayPalCatalogProduct(
  name: string,
  description: string | null,
  type: 'one_time' | 'subscription',
): Promise<PayPalSyncResult> {
  const paypalConfig = await getPayPalRuntimeConfig();
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
        'PayPal-Request-Id': `product-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`,
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
  paypalProductId: string,
  planName: string,
  priceCents: number,
  currency: string,
  intervalUnit: string,
  intervalCount: number,
): Promise<PayPalSyncResult> {
  const paypalConfig = await getPayPalRuntimeConfig();
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
        'PayPal-Request-Id': `plan-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`,
      },
      body: JSON.stringify({
        product_id: paypalProductId,
        name: planName.slice(0, 127),
        status: 'ACTIVE',
        billing_cycles: [
          {
            frequency: {
              interval_unit: intervalUnit.toUpperCase(), // DAY, WEEK, MONTH, YEAR
              interval_count: intervalCount,
            },
            tenure_type: 'REGULAR',
            sequence: 1,
            total_cycles: 0, // Infinite
            pricing_scheme: {
              fixed_price: {
                value: (priceCents / 100).toFixed(2),
                currency_code: currency.toUpperCase(),
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

export async function GET() {
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

  const {
    name,
    description,
    type,
    delivery_type,
    price_cents,
    currency,
    granted_role_ids,
    granted_channel_ids,
    active,
    sort_order,
    metadata,
    plans: planDefs, // Optional: plan definitions for subscription products
  } = body;

  if (!name || !type || !delivery_type || price_cents == null) {
    return NextResponse.json(
      { success: false, error: 'Missing required fields: name, type, delivery_type, price_cents' },
      { status: 400 },
    );
  }

  const normalizedPlanDefs = (type === 'subscription' ? (planDefs ?? []) : []).map(
    (planDef) => ({
      name: planDef.name,
      intervalUnit: planDef.interval_unit ?? 'MONTH',
      intervalCount: planDef.interval_count ?? 1,
      priceCents: planDef.price_cents ?? price_cents,
    }),
  );
  const hasPaidSubscriptionPlan = type === 'subscription'
    && normalizedPlanDefs.some((planDef) => planDef.priceCents > 0);
  const requiresPayPal = type !== 'free' && (price_cents > 0 || hasPaidSubscriptionPlan);

  if (type === 'subscription' && requiresPayPal && normalizedPlanDefs.length === 0) {
    normalizedPlanDefs.push({
      name: `${name} — MONTH`,
      intervalUnit: 'MONTH',
      intervalCount: 1,
      priceCents: price_cents,
    });
  }

  // Freeze stable local plan IDs before the wall check. Every plan that this
  // request will create at PayPal is represented as PayPal-backed now, before
  // any external side effect. This includes an explicit zero-price plan under
  // a positive-price subscription parent.
  const preparedPlans: PreparedPlan[] = normalizedPlanDefs.map((planDef) => {
    const id = crypto.randomUUID();
    return {
      id,
      name: planDef.name ?? `${name} — ${planDef.intervalUnit}`,
      intervalUnit: planDef.intervalUnit,
      intervalCount: planDef.intervalCount,
      priceCents: planDef.priceCents,
      paypalPlanId: requiresPayPal ? `pending-paypal-plan:${id}` : null,
    };
  });

  try {
    const evaluation = evaluateEffectivePostWriteProduct(
      {
        type,
        active: active ?? true,
        price_cents,
        granted_role_ids: granted_role_ids ?? [],
      },
      preparedPlans.map<PlanWallFields>((plan) => ({
        id: plan.id,
        active: true,
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
  if (active !== false) {
    const discordTargetsError = await discordTargetsResponse(
      supabase,
      guildId,
      granted_role_ids ?? [],
      granted_channel_ids ?? [],
    );
    if (discordTargetsError) return discordTargetsError;
  }

  let paypalProductId: string | null = null;
  if (requiresPayPal) {
    const paypalProduct = await createPayPalCatalogProduct(
      name,
      description ?? null,
      type === 'subscription' ? 'subscription' : 'one_time',
    );
    if (!paypalProduct.ok) {
      return paypalNotReadyResponse(paypalProduct.error);
    }
    paypalProductId = paypalProduct.id;
  }

  if (type === 'subscription' && requiresPayPal && paypalProductId) {
    for (const plan of preparedPlans) {
      const paypalPlan = await createPayPalBillingPlan(
        paypalProductId,
        plan.name,
        plan.priceCents,
        currency ?? 'USD',
        plan.intervalUnit,
        plan.intervalCount,
      );
      if (!paypalPlan.ok) {
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
      active: active ?? true,
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
    if (!rail.ok) return apiError(rail.message, 500);
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
          active: true,
        })
        .select('id')
        .single();

      if (planError) {
        return commerceWriteError(planError);
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

  if (
    'granted_role_ids' in updates
    || 'granted_channel_ids' in updates
    || updates.active === true
  ) {
    const { data: currentTargets, error: currentTargetsError } = await supabase
      .from('products')
      .select('granted_role_ids, granted_channel_ids, active')
      .eq('id', id)
      .eq('guild_id', guildId)
      .maybeSingle();
    if (currentTargetsError) return dbError(currentTargetsError, 'store/products/live-targets');
    if (!currentTargets) return apiError('Product not found for this guild', 404);

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
