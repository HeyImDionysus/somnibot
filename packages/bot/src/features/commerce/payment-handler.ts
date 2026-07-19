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
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  type ButtonInteraction,
  type Guild,
} from 'discord.js';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createLogger } from '@somnibot/shared';

const log = createLogger('PaymentHandler');

const HOT_PINK = 0xFF1493;

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

  // Fetch product
  const { data: product } = await supabase
    .from('products')
    .select('*')
    .eq('id', productId)
    .eq('guild_id', guildId)
    .eq('active', true)
    .single();

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

  // Check if user already has an active entitlement for this product
  const { data: existingCustomer } = await supabase
    .from('customers')
    .select('id')
    .eq('discord_id', discordId)
    .eq('guild_id', guildId)
    .single();

  if (existingCustomer) {
    const { data: existing } = await supabase
      .from('entitlements')
      .select('id')
      .eq('customer_id', existingCustomer.id)
      .eq('product_id', productId)
      .in('status', ['active', 'pending', 'grace_period'])
      .limit(1)
      .single();

    if (existing) {
      await interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(0xFEE75C)
            .setTitle('⚠️ Already Purchased')
            .setDescription('You already have an active entitlement for this product.'),
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
  const returnUrl = `${dashboardUrl}/store?order_complete=true`;
  const cancelUrl = `${dashboardUrl}/store?order_cancelled=true`;

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
        brand_name: 'SomniBot Store',
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
        new EmbedBuilder()
          .setColor(HOT_PINK)
          .setTitle(`🛒 Purchase: ${product.name}`)
          .setDescription(
            `**Price:** $${price} ${product.currency}\n\nClick the button below to complete your purchase via PayPal.`,
          ),
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
        brand_name: 'SomniBot Store',
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
        new EmbedBuilder()
          .setColor(HOT_PINK)
          .setTitle(`🔄 Subscribe: ${product.name}`)
          .setDescription(
            `**Plan:** ${plan.name}\n**Price:** $${(plan.price_cents / 100).toFixed(2)} ${plan.currency}/${plan.interval_unit.toLowerCase()}\n\nClick the button below to start your subscription via PayPal.`,
          ),
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
