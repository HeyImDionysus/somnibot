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

import { getPayPalRuntimeConfig, getPayPalToken } from '@/lib/paypal';
import { parseBody, schemas } from '@/lib/api/validation';
import { checkAdminRateLimit } from '@/lib/api/admin-rate-limit';
import { dbError } from '@/lib/api/response';
// ── PayPal Helpers ─────────────────────────────────────

/**
 * Create a PayPal Catalog Product.
 * Returns the PayPal product ID.
 */
async function createPayPalCatalogProduct(
  name: string,
  description: string | null,
  type: 'one_time' | 'subscription',
): Promise<string | null> {
  const paypalConfig = await getPayPalRuntimeConfig();
  const token = await getPayPalToken(paypalConfig);
  if (!token) return null;

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
      return null;
    }

    const data = await res.json();
    return data.id as string;
  } catch (err) {
    console.error('[Products] PayPal catalog creation error:', err);
    return null;
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
): Promise<string | null> {
  const paypalConfig = await getPayPalRuntimeConfig();
  const token = await getPayPalToken(paypalConfig);
  if (!token) return null;

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
      return null;
    }

    const data = await res.json();
    return data.id as string;
  } catch (err) {
    console.error('[Products] PayPal plan creation error:', err);
    return null;
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

  // 1. Auto-create PayPal Catalog Product
  let paypalProductId: string | null = null;
  paypalProductId = type !== 'free'
    ? await createPayPalCatalogProduct(name, description ?? null, type)
    : null;
  if (!paypalProductId) {
    console.warn('[Products] PayPal catalog product creation failed — continuing without sync');
  }

  // 2. Create product in database
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
    return dbError(error, 'store/products');
  }

  // 3. Auto-create PayPal Billing Plans for subscription products
  const createdPlans: { id: string; paypalPlanId: string | null }[] = [];

  // V11 Re-Audit L-4: Typed plan definition — replaces `as any` cast.
  // The Zod schema already validates planDefs as z.array(z.record(z.unknown())),
  // but property access needs an explicit interface to avoid type escapes.
  interface PlanDefinition {
    name?: string;
    interval_unit?: string;
    interval_count?: number;
    price_cents?: number;
  }

  if (type === 'subscription' && paypalProductId && Array.isArray(planDefs) && planDefs.length > 0) {
    for (const rawPlan of planDefs) {
      const planDef = rawPlan as PlanDefinition;
      const paypalPlanId = await createPayPalBillingPlan(
        paypalProductId,
        planDef.name ?? `${name} — ${planDef.interval_unit ?? 'MONTH'}`,
        planDef.price_cents ?? price_cents,
        currency ?? 'USD',
        planDef.interval_unit ?? 'MONTH',
        planDef.interval_count ?? 1,
      );

      const { data: plan } = await supabase
        .from('plans')
        .insert({
          product_id: data.id,
          guild_id: guildId,
          name: planDef.name ?? `${name} — ${planDef.interval_unit ?? 'MONTH'}`,
          paypal_plan_id: paypalPlanId,
          interval_unit: planDef.interval_unit ?? 'MONTH',
          interval_count: planDef.interval_count ?? 1,
          price_cents: planDef.price_cents ?? price_cents,
          currency: currency ?? 'USD',
          active: true,
        })
        .select('id')
        .single();

      if (plan) {
        createdPlans.push({ id: plan.id, paypalPlanId });
      }
    }
  }

  // Fetch final product with relations
  const { data: fullProduct } = await supabase
    .from('products')
    .select('*, plans(*), product_license_config(*)')
    .eq('id', data.id)
    .single();

  // Notify bot about new product
  await notifyBot('commerce', { product_created: data.id });

  return NextResponse.json({
    success: true,
    data: fullProduct ?? data,
    paypal_synced: !!paypalProductId,
    plans_created: createdPlans.length,
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

  // Remove fields that shouldn't be updated directly
  delete updates.guild_id;
  delete updates.created_at;
  updates.updated_at = new Date().toISOString();

  const { data, error } = await supabase
    .from('products')
    .update(updates)
    .eq('id', id)
    .eq('guild_id', guildId)
    .select()
    .single();

  if (error) {
    return dbError(error, 'store/products');
  }

  // Notify bot so it hot-reloads product changes
  await notifyBot('commerce', { product_updated: id });

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

  // Soft delete — deactivate instead of hard delete to preserve entitlements
  const { error } = await supabase
    .from('products')
    .update({ active: false, updated_at: new Date().toISOString() })
    .eq('id', id)
    .eq('guild_id', guildId);

  if (error) {
    return dbError(error, 'store/products');
  }

  // Notify bot so deactivated product is no longer purchasable
  await notifyBot('commerce', { product_deactivated: id });

  return NextResponse.json({ success: true });
}
