/**
 * Payment Handler — Processes purchase button clicks and PayPal checkout flow.
 *
 * When a user clicks "Buy" on a store product:
 * 1. Creates/fetches customer record
 * 2. Creates PayPal order (one-time) or subscription
 * 3. Returns a checkout URL for the user
 *
 * PayPal webhook processing happens in the dashboard API route.
 * The bot handles the Discord interaction side.
 */
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  type ButtonInteraction,
} from 'discord.js';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createLogger } from '@somnibot/shared';
import { brandedEmbed, resolveBrandKit } from '../branding/index.js';

const log = createLogger('PaymentHandler');

/**
 * Branded degradation for a buy click when a checkout READ fails (database
 * outage). A failed read must never be presented as "product not found" or
 * silently skipped past the already-purchased guard (which could double-sell)
 * — check the error FIRST, stop the checkout, and reassure the buyer that no
 * charge happened. The brand read is itself outage-safe (resolveBrandKit never
 * throws; the guild name is the fallback).
 */
async function replyCheckoutUnavailable(
  interaction: ButtonInteraction,
  supabase: SupabaseClient,
  guildId: string,
): Promise<void> {
  const brandKit = await resolveBrandKit(supabase, guildId, { fallbackName: interaction.guild?.name }).catch(() => null);
  const name = brandKit?.brandName ?? interaction.guild?.name ?? 'This server';
  await interaction.editReply({
    content: `⚠️ ${name}'s store is temporarily unavailable — please try again in a moment. You have not been charged.`,
  });
}

interface PayPalTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
}

interface PendingCheckoutOrder {
  id: string;
  customer_id: string;
  guild_id: string;
  product_id: string;
  plan_id: string | null;
  paypal_order_id: string | null;
  paypal_subscription_id: string | null;
  amount_cents: number;
  currency: string;
  status: string;
}

function isExactPendingCheckoutOrder(
  value: unknown,
  expected: Omit<PendingCheckoutOrder, 'id' | 'status'>,
): value is PendingCheckoutOrder {
  if (!value || typeof value !== 'object') return false;
  const order = value as Partial<PendingCheckoutOrder>;
  return (
    typeof order.id === 'string'
    && order.id.length > 0
    && order.status === 'pending'
    && order.customer_id === expected.customer_id
    && order.guild_id === expected.guild_id
    && order.product_id === expected.product_id
    && (order.plan_id ?? null) === expected.plan_id
    && (order.paypal_order_id ?? null) === expected.paypal_order_id
    && (order.paypal_subscription_id ?? null) === expected.paypal_subscription_id
    && order.amount_cents === expected.amount_cents
    && order.currency === expected.currency
  );
}

async function freezeCheckoutGrantSnapshot(
  supabase: SupabaseClient,
  order: PendingCheckoutOrder,
): Promise<boolean> {
  const { data, error } = await supabase.rpc('commerce_freeze_order_grant_snapshot', {
    p_order_id: order.id,
    p_guild_id: order.guild_id,
    p_customer_id: order.customer_id,
    p_product_id: order.product_id,
  });
  if (error) {
    log.error('Failed to freeze checkout grant snapshot:', error.message);
    return false;
  }
  if (
    !data
    || typeof data !== 'object'
    || (data as Record<string, unknown>).order_id !== order.id
    || typeof (data as Record<string, unknown>).grant_snapshot_frozen_at !== 'string'
  ) {
    log.error('Checkout grant snapshot returned malformed identity');
    return false;
  }
  return true;
}

async function cancelUnexposedCheckoutOrder(
  supabase: SupabaseClient,
  orderId: string,
): Promise<void> {
  const { error } = await supabase
    .from('orders')
    .update({ status: 'cancelled', updated_at: new Date().toISOString() })
    .eq('id', orderId)
    .eq('status', 'pending');
  if (error) log.error('Failed to cancel unexposed checkout order:', error.message);
}

/**
 * How long an in-flight checkout blocks a fresh one for the same
 * (customer, product).
 *
 * PayPal Checkout v2 orders stop being approvable well before this — six hours
 * is deliberately past that window, so releasing the block cannot free a link
 * the buyer could still pay. The cost of the conservative bound is that an
 * abandoned checkout keeps that one product unbuyable for the buyer for up to
 * six hours; the alternative is releasing it early and re-opening exactly the
 * double-charge this rail exists to prevent.
 */
const STALE_CHECKOUT_AGE_MS = 6 * 60 * 60 * 1000;

type InFlightCheckout =
  | { state: 'clear' }
  | { state: 'blocked'; orderNumber: string }
  | { state: 'unavailable' };

/**
 * Finding 10: refuse to open a SECOND payment link for a product this customer
 * already has a live checkout for. Two approval links meant two captures, two
 * entitlements, and a refund request.
 *
 * The authoritative rail is the partial unique index
 * `uniq_orders_pending_one_time_checkout`, which makes the second one-time
 * order insert fail atomically. This pre-flight exists to (a) refuse before
 * spending a PayPal round-trip, (b) give the buyer a message that names the
 * order, and (c) cover subscription checkouts, which the index deliberately
 * does not (its recovery insert in the webhook must never be blocked).
 *
 * A read ERROR is not "clear": during an outage the live checkout may exist, so
 * refusing to guess is the only safe answer on the money path.
 */
async function inspectInFlightCheckout(
  supabase: SupabaseClient,
  customerId: string,
  productId: string,
): Promise<InFlightCheckout> {
  const { data, error } = await supabase
    .from('orders')
    .select('id, order_number, created_at')
    .eq('customer_id', customerId)
    .eq('product_id', productId)
    .eq('status', 'pending')
    .order('created_at', { ascending: false })
    .limit(5);

  if (error) {
    log.error('Failed to inspect in-flight checkout:', error.message);
    return { state: 'unavailable' };
  }

  const rows = (data ?? []) as { id: string; order_number: string; created_at: string }[];
  const cutoff = Date.now() - STALE_CHECKOUT_AGE_MS;
  const live = rows.filter((row) => {
    const createdAt = Date.parse(row.created_at);
    // An unparseable timestamp is treated as live: never release a block we
    // cannot prove is safe to release.
    return !Number.isFinite(createdAt) || createdAt > cutoff;
  });

  if (live.length > 0) {
    return { state: 'blocked', orderNumber: live[0].order_number };
  }

  // Everything outstanding is past the point PayPal would still take it — clear
  // it so an abandoned checkout does not lock the buyer out permanently.
  for (const row of rows) {
    await cancelUnexposedCheckoutOrder(supabase, row.id);
  }
  return { state: 'clear' };
}

/** Does this write error mean the pending-checkout unique index rejected it? */
function isDuplicateCheckoutViolation(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false;
  return error.code === '23505'
    || (error.message ?? '').includes('uniq_orders_pending_one_time_checkout');
}

/**
 * Get a PayPal access token using client credentials.
 */
async function getPayPalToken(
  apiBase: string,
  clientId: string,
  clientSecret: string,
): Promise<string | null> {
  try {
    const res = await fetch(`${apiBase}/v1/oauth2/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
      },
      body: 'grant_type=client_credentials',
    });
    if (!res.ok) return null;
    const data = (await res.json()) as PayPalTokenResponse;
    return data.access_token;
  } catch {
    return null;
  }
}

/**
 * Handle a store "Buy" button interaction.
 */
export async function handleBuyButton(
  interaction: ButtonInteraction,
  supabase: SupabaseClient,
  guildId: string,
  paypalApiBase: string,
  paypalClientId: string,
  paypalClientSecret: string,
  dashboardUrl: string,
): Promise<void> {
  await interaction.deferReply({ ephemeral: true });

  const productId = interaction.customId.replace('store:buy:', '');
  const discordId = interaction.user.id;
  const discordUsername = interaction.user.username;

  // Buyer-facing surface: the owner's white-label kit frames every checkout
  // embed AND supplies the PayPal checkout brand_name. Resolved once per
  // handler (cached; never throws).
  const brandKit = await resolveBrandKit(supabase, guildId, {
    fallbackName: interaction.guild?.name ?? 'Store',
  });

  // Fetch product. A failed READ is not a missing product: during a database
  // outage the product may exist and be buyable, so degrade honestly instead
  // of lying with "not found".
  const { data: product, error: productLookupError } = await supabase
    .from('products')
    .select('*')
    .eq('id', productId)
    .eq('guild_id', guildId)
    .eq('active', true)
    .maybeSingle();

  if (productLookupError) {
    await replyCheckoutUnavailable(interaction, supabase, guildId);
    return;
  }

  if (!product) {
    await interaction.editReply({ content: '❌ Product not found or no longer available.' });
    return;
  }

  // BUYABILITY guard — enforce the checkout column of the compliance
  // decision matrix (packages/dashboard/src/lib/api/commerce-income-wall.ts):
  // only priced one-time products and subscription products may start a
  // real-money checkout. Without this, a `free`-typed product would fall into
  // the subscription branch below and could charge real money through an
  // attached PayPal plan, and a zero-price one-time product would attempt a
  // $0.00 PayPal order — both outside what the dashboard's compliance walls
  // model as "buyable", so both are refused at the point of sale.
  if (product.type !== 'one_time' && product.type !== 'subscription') {
    await interaction.editReply({ content: '❌ This product cannot be purchased.' });
    return;
  }
  if (product.type === 'one_time' && (product.price_cents ?? 0) <= 0) {
    await interaction.editReply({ content: '❌ This product cannot be purchased.' });
    return;
  }

  // DELIVERABILITY guard — a licence-key product whose product_license_config
  // row is missing takes the money, grants the entitlement and roles, and
  // delivers NO key (the capture webhook mints a key only when that row
  // exists). The database now auto-provisions the config, but this is the
  // last-mile fence: never open a payment link for a product that provably
  // cannot deliver what it sells. A read ERROR is not "no config" — during an
  // outage the config may exist, so degrade honestly instead of refusing a
  // valid sale.
  if (product.delivery_type === 'license_key') {
    const { data: licenseConfig, error: licenseConfigError } = await supabase
      .from('product_license_config')
      .select('product_id')
      .eq('product_id', productId)
      .maybeSingle();

    if (licenseConfigError) {
      await replyCheckoutUnavailable(interaction, supabase, guildId);
      return;
    }

    if (!licenseConfig) {
      log.error('Refusing checkout for licence product without licence config:', { productId });
      await interaction.editReply({
        embeds: [
          brandedEmbed(brandKit, {
            intent: 'warning',
            title: '⚠️ Temporarily Unavailable',
            description:
              'This product is not ready to be delivered yet, so it cannot be purchased right now. '
              + 'You have not been charged — please contact the server owner.',
          }),
        ],
      });
      return;
    }
  }

  // Check if user already has an active entitlement for this product. These
  // reads GUARD real money: proceeding when they error (rather than when they
  // genuinely return nothing) would let an outage bypass the already-purchased
  // fence and double-sell — so a read error stops the checkout cold.
  const { data: existingCustomer, error: customerLookupError } = await supabase
    .from('customers')
    .select('id')
    .eq('discord_id', discordId)
    .eq('guild_id', guildId)
    .maybeSingle();

  if (customerLookupError) {
    await replyCheckoutUnavailable(interaction, supabase, guildId);
    return;
  }

  if (existingCustomer) {
    const { data: existing, error: entitlementLookupError } = await supabase
      .from('entitlements')
      .select('id')
      .eq('customer_id', existingCustomer.id)
      .eq('product_id', productId)
      .in('status', ['active', 'pending', 'grace_period'])
      .limit(1)
      .maybeSingle();

    if (entitlementLookupError) {
      await replyCheckoutUnavailable(interaction, supabase, guildId);
      return;
    }

    if (existing) {
      await interaction.editReply({
        embeds: [
          brandedEmbed(brandKit, {
            intent: 'warning',
            title: '⚠️ Already Purchased',
            description: 'You already have an active entitlement for this product.',
          }),
        ],
      });
      return;
    }

    // DOUBLE-CHARGE guard — one live checkout per customer per product.
    const inFlight = await inspectInFlightCheckout(supabase, existingCustomer.id, productId);
    if (inFlight.state === 'unavailable') {
      await replyCheckoutUnavailable(interaction, supabase, guildId);
      return;
    }
    if (inFlight.state === 'blocked') {
      await interaction.editReply({
        embeds: [
          brandedEmbed(brandKit, {
            intent: 'warning',
            title: '⏳ Checkout Already In Progress',
            description:
              `You already have a checkout open for this product (**${inFlight.orderNumber}**). `
              + 'Finish paying with the PayPal link you were given, and your purchase will be '
              + 'delivered automatically.\n\n'
              + 'A second link would let you be charged twice for the same thing, so it is not '
              + 'offered. You have not been charged for this click.',
          }),
        ],
      });
      return;
    }
  }

  // Get or create customer
  let customerId: string;
  if (existingCustomer) {
    customerId = existingCustomer.id;
  } else {
    const { data: newCustomer, error: custErr } = await supabase
      .from('customers')
      .insert({
        guild_id: guildId,
        discord_id: discordId,
        discord_username: discordUsername,
      })
      .select('id')
      .single();

    if (custErr || !newCustomer) {
      log.error('Failed to create customer:', custErr?.message);
      await interaction.editReply({ content: '❌ Failed to process. Please try again.' });
      return;
    }
    customerId = newCustomer.id;
  }

  // Get PayPal token
  const token = await getPayPalToken(paypalApiBase, paypalClientId, paypalClientSecret);
  if (!token) {
    await interaction.editReply({ content: '❌ Payment service unavailable. Please try again later.' });
    return;
  }

  const price = (product.price_cents / 100).toFixed(2);
  // Post-checkout destinations MUST be publicly reachable: the buyer is a
  // Discord customer, not a dashboard admin. `/store` lives under
  // app/(dashboard) and is not in the middleware's public-route list, so the
  // old return_url dumped every paying customer on the admin /login page — and
  // nothing ever read the `order_complete` / `order_cancelled` params anyway.
  // `/portal/*` is already sessionless-public, so these pages need no
  // middleware change and expose no admin surface. The guild id rides along so
  // the page can link to the right per-guild portal; it is a public server id,
  // and the pages deliberately show NOTHING customer-specific because these
  // URLs are guessable.
  const portalQuery = `?guild=${encodeURIComponent(guildId)}`;
  const returnUrl = `${dashboardUrl}/portal/order-complete${portalQuery}`;
  const cancelUrl = `${dashboardUrl}/portal/order-cancelled${portalQuery}`;
  // White-label: the PayPal checkout brand must be the owner's store brand.
  const brandName = brandKit.brandName;

  if (product.type === 'one_time') {
    // Create PayPal order
    const orderPayload = {
      intent: 'CAPTURE',
      purchase_units: [
        {
          amount: {
            currency_code: product.currency,
            value: price,
          },
          description: product.name,
          // V5 Audit [2.1]: Use short keys to stay well within PayPal's
          // 127-character custom_id limit. Previous long keys totalled ~110 chars.
          custom_id: JSON.stringify({
            g: guildId,
            p: productId,
            c: customerId,
            d: discordId,
          }),
        },
      ],
      application_context: {
        brand_name: brandName,
        landing_page: 'LOGIN',
        user_action: 'PAY_NOW',
        return_url: returnUrl,
        cancel_url: cancelUrl,
      },
    };

    const orderRes = await fetch(`${paypalApiBase}/v2/checkout/orders`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(orderPayload),
    });

    if (!orderRes.ok) {
      const err = await orderRes.text();
      log.error('PayPal order creation failed:', { error: String(err) });
      await interaction.editReply({ content: '❌ Failed to create payment. Please try again.' });
      return;
    }

    const orderData = await orderRes.json() as { id: string; links?: Array<{ rel: string; href: string }> };
    const approvalLink = orderData.links?.find((l) => l.rel === 'approve');

    if (!approvalLink?.href) {
      await interaction.editReply({ content: '❌ Failed to get checkout URL.' });
      return;
    }

    // Create pending order in DB with sequential order number
    const { data: seqResult } = await supabase.rpc('generate_order_number') as { data: string | null; error: unknown };
    const orderNumber = seqResult || `ORD-${Date.now().toString(36).toUpperCase()}`;

    const expectedOrder = {
      customer_id: customerId,
      guild_id: guildId,
      product_id: productId,
      plan_id: null,
      paypal_order_id: orderData.id,
      paypal_subscription_id: null,
      amount_cents: product.price_cents,
      currency: product.currency,
    };
    const { data: pendingOrder, error: pendingOrderError } = await supabase.from('orders').insert({
      order_number: orderNumber,
      ...expectedOrder,
      status: 'pending',
      source: 'purchase',
    })
      .select('id,customer_id,guild_id,product_id,plan_id,paypal_order_id,paypal_subscription_id,amount_cents,currency,status')
      .single();

    if (pendingOrderError || !isExactPendingCheckoutOrder(pendingOrder, expectedOrder)) {
      // The pending-checkout unique index is the atomic version of the
      // pre-flight guard above: it is what actually stops a genuine
      // double-click, where both clicks read "clear" before either inserted.
      // The link is never exposed, so the losing PayPal order cannot be paid.
      if (isDuplicateCheckoutViolation(pendingOrderError)) {
        log.warn('Refused a concurrent second checkout for the same product', { productId });
        await interaction.editReply({
          embeds: [
            brandedEmbed(brandKit, {
              intent: 'warning',
              title: '⏳ Checkout Already In Progress',
              description:
                'A checkout for this product was just opened. Use that PayPal link to finish — '
                + 'a second one would let you be charged twice. You have not been charged for '
                + 'this click.',
            }),
          ],
        });
        return;
      }
      log.error('Failed to persist one-time checkout order:', pendingOrderError?.message ?? 'identity mismatch');
      await interaction.editReply({
        content: '❌ Checkout could not be safely recorded. No payment link was opened; please try again.',
      });
      return;
    }
    if (!(await freezeCheckoutGrantSnapshot(supabase, pendingOrder))) {
      await cancelUnexposedCheckoutOrder(supabase, pendingOrder.id);
      await interaction.editReply({
        content: '❌ Checkout configuration changed before it could be secured. No payment link was opened; please try again.',
      });
      return;
    }

    await interaction.editReply({
      embeds: [
        brandedEmbed(brandKit, {
          intent: 'primary',
          title: `🛒 Purchase: ${product.name}`,
          description:
            `**Price:** $${price} ${product.currency}\n\nClick the button below to complete your purchase via PayPal.`,
        }),
      ],
      components: [
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder()
            .setLabel('Complete Purchase')
            .setStyle(ButtonStyle.Link)
            .setURL(approvalLink.href)
            .setEmoji('💳'),
        ),
      ],
    });
  } else {
    // The database selector is the single checkout truth: active, guild- and
    // product-scoped, backed by a nonblank PayPal plan, then deterministic by
    // (price_cents ASC, id ASC). In particular, a zero local price remains a
    // valid PayPal-backed subscription rather than falling through to a more
    // expensive row or being mistaken for an unchargeable plan.
    const { data: selectedPlans, error: planError } = await supabase.rpc(
      'commerce_select_checkout_plan',
      {
        p_guild_id: guildId,
        p_product_id: productId,
      },
    );
    if (planError) {
      log.error('Subscription checkout plan selection failed:', planError.message);
      await interaction.editReply({
        content: '❌ Subscription plan verification failed. Please try again.',
      });
      return;
    }

    const plan = Array.isArray(selectedPlans) && selectedPlans.length === 1
      ? selectedPlans[0]
      : null;
    if (
      !plan
      || typeof plan.id !== 'string'
      || typeof plan.paypal_plan_id !== 'string'
      || plan.paypal_plan_id.trim().length === 0
    ) {
      await interaction.editReply({ content: '❌ No active subscription plan found for this product.' });
      return;
    }

    // Create PayPal subscription
    const subPayload = {
      plan_id: plan.paypal_plan_id,
      custom_id: JSON.stringify({
        guild_id: guildId,
        product_id: productId,
        plan_id: plan.id,
        customer_id: customerId,
        discord_id: discordId,
      }),
      application_context: {
        brand_name: brandName,
        locale: 'en-US',
        user_action: 'SUBSCRIBE_NOW',
        return_url: returnUrl,
        cancel_url: cancelUrl,
      },
    };

    const subRes = await fetch(`${paypalApiBase}/v1/billing/subscriptions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(subPayload),
    });

    if (!subRes.ok) {
      const err = await subRes.text();
      log.error('PayPal subscription creation failed:', { error: String(err) });
      await interaction.editReply({ content: '❌ Failed to create subscription. Please try again.' });
      return;
    }

    const subData = await subRes.json() as { id: string; links?: Array<{ rel: string; href: string }> };
    const approvalLink = subData.links?.find((l) => l.rel === 'approve');

    if (!approvalLink?.href) {
      await interaction.editReply({ content: '❌ Failed to get checkout URL.' });
      return;
    }

    // V11 Re-Audit UX-4: Create a pending order record for subscriptions,
    // matching the one-time purchase flow. Without this, subscription attempts
    // that are abandoned have no record in the orders table, and the owner's
    // dashboard shows no trace of the purchase attempt.
    const { data: seqResult } = await supabase.rpc('generate_order_number') as { data: string | null; error: unknown };
    const orderNumber = seqResult || `ORD-${Date.now().toString(36).toUpperCase()}`;

    const expectedOrder = {
      customer_id: customerId,
      guild_id: guildId,
      product_id: productId,
      plan_id: plan.id,
      paypal_order_id: null,
      paypal_subscription_id: subData.id,
      amount_cents: plan.price_cents,
      currency: plan.currency,
    };
    const { data: pendingOrder, error: pendingOrderError } = await supabase.from('orders').insert({
      order_number: orderNumber,
      ...expectedOrder,
      status: 'pending',
      source: 'purchase',
    })
      .select('id,customer_id,guild_id,product_id,plan_id,paypal_order_id,paypal_subscription_id,amount_cents,currency,status')
      .single();

    if (pendingOrderError || !isExactPendingCheckoutOrder(pendingOrder, expectedOrder)) {
      log.error('Failed to persist subscription checkout order:', pendingOrderError?.message ?? 'identity mismatch');
      await interaction.editReply({
        content: '❌ Checkout could not be safely recorded. No subscription link was opened; please try again.',
      });
      return;
    }
    if (!(await freezeCheckoutGrantSnapshot(supabase, pendingOrder))) {
      await cancelUnexposedCheckoutOrder(supabase, pendingOrder.id);
      await interaction.editReply({
        content: '❌ Checkout configuration changed before it could be secured. No subscription link was opened; please try again.',
      });
      return;
    }

    await interaction.editReply({
      embeds: [
        brandedEmbed(brandKit, {
          intent: 'primary',
          title: `🔄 Subscribe: ${product.name}`,
          description:
            `**Plan:** ${plan.name}\n**Price:** $${(plan.price_cents / 100).toFixed(2)} ${plan.currency}/${plan.interval_unit.toLowerCase()}\n\nClick the button below to start your subscription via PayPal.`,
        }),
      ],
      components: [
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder()
            .setLabel('Subscribe')
            .setStyle(ButtonStyle.Link)
            .setURL(approvalLink.href)
            .setEmoji('💳'),
        ),
      ],
    });
  }
}
