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
import { createHmac, randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createLogger } from '@somnibot/shared';
import { brandedEmbed, resolveBrandKit } from '../branding/index.js';
import { raiseOwnerAlert } from '../../services/alert-service.js';
import { deterministicUuidV8 } from '../../utils/deterministic-uuid.js';

const log = createLogger('PaymentHandler');
const PAYPAL_FETCH_TIMEOUT_MS = 15_000;

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
  disposition: 'created' | 'replay';
  id: string;
  order_number: string;
  customer_id: string;
  guild_id: string;
  product_id: string;
  plan_id: string | null;
  paypal_order_id: string | null;
  paypal_subscription_id: string | null;
  amount_cents: number;
  currency: string;
  status: string;
  checkout_active: boolean;
  checkout_approval_url: string;
  delivery_type_snapshot: string;
  granted_role_ids_snapshot: string[];
  granted_channel_ids_snapshot: string[];
  temporary_role_grants_snapshot: unknown[];
  grant_snapshot_frozen_at: string;
}

const CHECKOUT_DELIVERY_TYPES = new Set([
  'file',
  'link',
  'access_pass',
  'license_key',
  'mixed',
]);
const DISCORD_SNOWFLAKE = /^\d{17,20}$/;
function signCheckoutToken(token: string): string | null {
  const secret = process.env.PAYPAL_RECONCILE_SECRET || process.env.PAYPAL_CLIENT_SECRET;
  return secret ? createHmac('sha256', secret).update(`somnibot-checkout:v1:${token}`).digest('hex') : null;
}

/** Claim a free product through the dedicated idempotent $0 RPC. */
export async function handleFreeClaimButton(
  interaction: ButtonInteraction,
  supabase: SupabaseClient,
  guildId: string,
): Promise<void> {
  await interaction.deferReply({ ephemeral: true });
  const productId = interaction.customId.replace('store:claim:', '');
  const discordId = interaction.user.id;
  const { data: product, error: productError } = await supabase
    .from('products')
    .select('id, name, type, price_cents, delivery_type, granted_role_ids, granted_channel_ids')
    .eq('id', productId)
    .eq('guild_id', guildId)
    .eq('active', true)
    .maybeSingle();
  if (productError || !product || product.type !== 'free' || product.price_cents !== 0
    || !CHECKOUT_DELIVERY_TYPES.has(String(product.delivery_type))) {
    await interaction.editReply({ content: '❌ This free product is no longer available.' });
    return;
  }
  // The claim must not create durable entitlement/queue evidence when the
  // connected guild cannot deliver the frozen Discord grants right now.
  const liveGuild = interaction.guild;
  const roleIds = Array.isArray(product.granted_role_ids)
    ? product.granted_role_ids.filter((id: unknown): id is string => typeof id === 'string' && DISCORD_SNOWFLAKE.test(id))
    : [];
  const channelIds = Array.isArray(product.granted_channel_ids)
    ? product.granted_channel_ids.filter((id: unknown): id is string => typeof id === 'string' && DISCORD_SNOWFLAKE.test(id))
    : [];
  if (liveGuild && (roleIds.length > 0 || channelIds.length > 0)) {
    const me = liveGuild.members.me ?? await liveGuild.members.fetchMe().catch(() => null);
    const highest = me?.roles.highest.position ?? 0;
    const canManage = me?.permissions.has('ManageRoles') ?? false;
    const canManageChannels = me?.permissions.has('ManageChannels') ?? false;
    const problems: string[] = [];
    for (const roleId of roleIds) {
      const role = liveGuild.roles.cache.get(roleId);
      if (!role) problems.push(`role ${roleId} is missing`);
      else if (role.managed || role.position >= highest || !canManage) problems.push(`role ${roleId} cannot be assigned by the bot`);
    }
    for (const channelId of channelIds) {
      const channel = liveGuild.channels.cache.get(channelId);
      if (!channel || !channel.isTextBased()) problems.push(`channel ${channelId} is missing or not text-based`);
      else if (!canManageChannels) problems.push(`the bot is missing Manage Channels permission for ${channelId}`);
    }
    if (problems.length > 0) {
      await raiseOwnerAlert(supabase, guildId, {
        alertType: 'commerce_undeliverable_benefit', severity: 'critical',
        title: 'Free product benefits are undeliverable',
        message: `Free claim for "${product.name}" was refused: ${problems.join('; ')}`,
        metadata: { product_id: productId, problems },
      });
      await interaction.editReply({ content: '❌ This free product cannot be delivered right now. The server owner has been notified.' });
      return;
    }
  }
  const customerResult = await supabase.from('customers').upsert(
    { guild_id: guildId, discord_id: discordId, discord_username: interaction.user.username },
    { onConflict: 'discord_id,guild_id' },
  ).select('id').single();
  const customer = customerResult.data;
  if (!customer?.id) {
    await interaction.editReply({ content: '❌ Free claim is temporarily unavailable. Please try again.' });
    return;
  }
  const { data: claimConfig, error: claimConfigError } = await supabase.from('guild_config').select('free_claim_policy').eq('guild_id', guildId).maybeSingle();
  if (claimConfigError) {
    await interaction.editReply({ content: '⚠️ Free claims are temporarily unavailable. Please try again.' });
    return;
  }
  const requestId = claimConfig?.free_claim_policy === 'repeatable'
    ? randomUUID()
    : deterministicUuidV8('somnibot:free-claim:v1', [guildId, discordId, productId]);
  const { data, error } = await supabase.rpc('commerce_claim_free_product', {
    p_request_id: requestId, p_guild_id: guildId, p_customer_id: customer.id, p_product_id: productId,
  });
  if (error) {
    await interaction.editReply({ content: '❌ This free claim could not be completed. Please try again later.' });
    return;
  }
  const row = Array.isArray(data) ? data[0] as Record<string, unknown> | undefined : undefined;
  if (row?.disposition === 'already-claimed') {
    await interaction.editReply({ content: 'ℹ️ You have already claimed this product.' });
    return;
  }
  if (row?.disposition !== 'claimed' || typeof row.entitlement_id !== 'string') {
    await interaction.editReply({ content: '❌ Free claim evidence was incomplete; nothing was granted.' });
    return;
  }
  await interaction.editReply({ content: '✅ Free product claimed. Your entitlement is now active.' });
}
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TIMESTAMPTZ_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/;
const MAX_TEMP_ROLE_DURATION_SECONDS = 315_360_000;

function isExactSnowflakeVector(value: unknown): value is string[] {
  return (
    Array.isArray(value)
    && value.every((entry) =>
      typeof entry === 'string'
      && DISCORD_SNOWFLAKE.test(entry))
    && new Set(value).size === value.length
  );
}

function isExactTemporaryGrantSnapshot(value: unknown): boolean {
  if (!Array.isArray(value)) return false;
  const roleIds = new Set<string>();
  for (const entry of value) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
    const grant = entry as Record<string, unknown>;
    if (
      Object.keys(grant).sort().join(',') !== 'duration_seconds,role_id'
      || typeof grant.role_id !== 'string'
      || !DISCORD_SNOWFLAKE.test(grant.role_id)
      || roleIds.has(grant.role_id)
      || !Number.isSafeInteger(grant.duration_seconds)
      || (grant.duration_seconds as number) <= 0
      || (grant.duration_seconds as number) > MAX_TEMP_ROLE_DURATION_SECONDS
    ) {
      return false;
    }
    roleIds.add(grant.role_id);
  }
  return true;
}

function isExactPendingCheckoutOrder(
  value: unknown,
  expected: Pick<
    PendingCheckoutOrder,
    | 'order_number'
    | 'customer_id'
    | 'guild_id'
    | 'product_id'
    | 'plan_id'
    | 'paypal_order_id'
    | 'paypal_subscription_id'
    | 'amount_cents'
    | 'currency'
    | 'checkout_active'
    | 'checkout_approval_url'
  >,
): value is PendingCheckoutOrder {
  if (!value || typeof value !== 'object') return false;
  const order = value as Partial<PendingCheckoutOrder>;
  return (
    typeof order.id === 'string'
    && UUID_PATTERN.test(order.id)
    && (order.disposition === 'created' || order.disposition === 'replay')
    && order.order_number === expected.order_number
    && order.status === 'pending'
    && order.customer_id === expected.customer_id
    && order.guild_id === expected.guild_id
    && order.product_id === expected.product_id
    && (order.plan_id ?? null) === expected.plan_id
    && (order.paypal_order_id ?? null) === expected.paypal_order_id
    && (order.paypal_subscription_id ?? null) === expected.paypal_subscription_id
    && order.amount_cents === expected.amount_cents
    && order.currency === expected.currency
    && order.checkout_active === expected.checkout_active
    && order.checkout_approval_url === expected.checkout_approval_url
    && typeof order.delivery_type_snapshot === 'string'
    && CHECKOUT_DELIVERY_TYPES.has(order.delivery_type_snapshot)
    && isExactSnowflakeVector(order.granted_role_ids_snapshot)
    && isExactSnowflakeVector(order.granted_channel_ids_snapshot)
    && isExactTemporaryGrantSnapshot(order.temporary_role_grants_snapshot)
    && typeof order.grant_snapshot_frozen_at === 'string'
    && TIMESTAMPTZ_PATTERN.test(order.grant_snapshot_frozen_at)
    && Number.isFinite(Date.parse(order.grant_snapshot_frozen_at))
  );
}

type CheckoutBlockReason =
  | 'provider_checkout'
  | 'paid_hold'
  | 'paid_fulfillment'
  | 'active_entitlement';

type InFlightCheckout =
  | { state: 'clear' }
  | {
      state: 'blocked';
      orderNumber: string | null;
      reason: CheckoutBlockReason;
      approvalUrl: string | null;
    }
  | { state: 'unavailable' };

/**
 * Finding 10: refuse to open a SECOND payment link for a product this customer
 * already has a live checkout for. Two approval links meant two captures, two
 * entitlements, and a refund request.
 *
 * The service-only inspection RPC can see private paid holds/claims as well as
 * every still-payable provider row. Its matching INSERT trigger repeats the
 * decision under the same identity advisory lock used by fulfillment claims,
 * while the partial unique index serializes ordinary concurrent double-clicks.
 *
 * A read ERROR is not "clear": during an outage the live checkout may exist, so
 * refusing to guess is the only safe answer on the money path.
 *
 * Age is intentionally irrelevant. PayPal approval windows are provider/account
 * state, not a locally provable six-hour expiry (Orders may have an extended
 * redirect window, and Subscriptions exposes no equivalent local age contract).
 * Until exact provider state or an operator proves the link cannot be paid, the
 * active row keeps blocking a second real-money checkout.
 */
async function inspectInFlightCheckout(
  supabase: SupabaseClient,
  guildId: string,
  customerId: string,
  productId: string,
): Promise<InFlightCheckout> {
  const { data, error } = await supabase.rpc('commerce_inspect_checkout_blocker', {
    p_guild_id: guildId,
    p_customer_id: customerId,
    p_product_id: productId,
  });

  if (error) {
    log.error('Failed to inspect in-flight checkout:', error.message);
    return { state: 'unavailable' };
  }

  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    log.error('Checkout blocker inspection returned malformed data');
    return { state: 'unavailable' };
  }
  const result = data as Record<string, unknown>;
  if (
    result.disposition === 'clear'
    && result.reason === null
    && result.order_id === null
    && result.order_number === null
    && result.approval_url === null
  ) {
    return { state: 'clear' };
  }
  if (
    result.disposition === 'blocked'
    && ['provider_checkout', 'paid_hold', 'paid_fulfillment', 'active_entitlement']
      .includes(String(result.reason))
    && (result.order_number === null || typeof result.order_number === 'string')
    && (
      result.approval_url === null
      || isPayPalApprovalUrl(result.approval_url)
    )
    && (
      result.reason === 'provider_checkout'
      || result.approval_url === null
    )
  ) {
    return {
      state: 'blocked',
      orderNumber: result.order_number as string | null,
      reason: result.reason as CheckoutBlockReason,
      approvalUrl: result.approval_url as string | null,
    };
  }
  log.error('Checkout blocker inspection returned malformed identity');
  return { state: 'unavailable' };
}

function isPayPalApprovalUrl(value: unknown): value is string {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length > 2048
    || value.trim() !== value
  ) {
    return false;
  }
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    return url.protocol === 'https:'
      && (host === 'paypal.com' || host.endsWith('.paypal.com'));
  } catch {
    return false;
  }
}

type CheckoutReservationBlock = {
  orderNumber: string | null;
  reason: CheckoutBlockReason;
};

/**
 * Classify only the two authoritative checkout-reservation failures. Other
 * unique violations are persistence failures, not proof that another usable
 * PayPal link exists.
 */
function parseCheckoutReservationBlock(
  error: { code?: string; message?: string } | null,
): CheckoutReservationBlock | null {
  if (!error) return null;
  const message = error.message ?? '';
  const triggerBlock = message.match(
    /commerce_checkout_blocked:\s*(provider_checkout|paid_hold|paid_fulfillment|active_entitlement)\s+order\s+(\S+)/,
  );
  if (triggerBlock) {
    return {
      reason: triggerBlock[1] as CheckoutBlockReason,
      orderNumber: triggerBlock[2] === 'unknown' ? null : triggerBlock[2],
    };
  }
  if (message.includes('uniq_orders_pending_one_time_checkout')) {
    return { reason: 'provider_checkout', orderNumber: null };
  }
  return null;
}

function checkoutBlockCopy(
  block: CheckoutReservationBlock,
  subscription: boolean,
): { title: string; description: string } {
  const previousOrder = block.orderNumber ? ` (**${block.orderNumber}**)` : '';
  if (block.reason === 'paid_hold' || block.reason === 'paid_fulfillment') {
    return {
      title: '⚠️ Previous Payment Needs Review',
      description:
        `A previous payment for this product${previousOrder} still requires delivery `
        + 'or refund review. A second PayPal link is blocked so you cannot be charged '
        + 'again while that is unresolved. Contact the server owner; you have not been '
        + 'charged for this click.',
    };
  }
  if (block.reason === 'active_entitlement') {
    return {
      title: '⚠️ Already Purchased',
      description:
        'You already have an active entitlement for this product. You have not been '
        + 'charged for this click.',
    };
  }
  return subscription
    ? {
        title: '⏳ Checkout Already In Progress',
        description:
          `A subscription checkout for this product is already open${previousOrder}. `
          + 'Use that PayPal link to finish — a second one could create two paid '
          + 'subscriptions. You have not been charged for this click.',
      }
    : {
        title: '⏳ Checkout Already In Progress',
        description:
          `You already have a checkout open for this product${previousOrder}. `
          + 'Finish paying with the PayPal link you were given, and your purchase will '
          + 'be delivered automatically.\n\n'
          + 'A second link would let you be charged twice for the same thing, so it is '
          + 'not offered. You have not been charged for this click.',
      };
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
      signal: AbortSignal.timeout(PAYPAL_FETCH_TIMEOUT_MS),
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
  giftCheckoutToken?: string,
): Promise<void> {
  await interaction.deferReply({ ephemeral: true });

  const productId = interaction.customId.startsWith('store:gift-buy:')
    ? (interaction.customId.split(':')[2] ?? '')
    : interaction.customId.replace('store:buy:', '');
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

  const { data: commerceConfig } = await supabase
    .from('guild_config')
    .select('repeat_purchase_policy')
    .eq('guild_id', guildId)
    .maybeSingle();
  const repeatPurchasePolicy = ['unique', 'stackable', 'renewable', 'seat-based'].includes(
    String(commerceConfig?.repeat_purchase_policy),
  ) ? String(commerceConfig?.repeat_purchase_policy) : 'unique';

  // A previously validated gift intent is intentionally discovered by its
  // opaque id in the server-side ledger; it is never trusted from a client
  // supplied recipient or price.  The short-lived row is carried into the
  // PayPal custom_id metadata below and revalidated by the signed webhook.
  const { data: buyerForGift } = await supabase
    .from('customers')
    .select('id')
    .eq('guild_id', guildId)
    .eq('discord_id', discordId)
    .maybeSingle();
  const { data: giftRows } = buyerForGift && giftCheckoutToken
    ? await supabase
      .from('commerce_gift_intents')
      .select('id, checkout_token, buyer_customer_id, expires_at, status')
      .eq('guild_id', guildId)
      .eq('buyer_customer_id', buyerForGift.id)
      .eq('product_id', productId)
      .eq('checkout_token', giftCheckoutToken)
      .eq('status', 'pending')
      .gt('expires_at', new Date().toISOString())
      .order('created_at', { ascending: false })
      .limit(1)
    : { data: [] as Array<Record<string, unknown>> };
  const giftIntentId = giftCheckoutToken && Array.isArray(giftRows) && typeof giftRows[0]?.checkout_token === 'string'
    ? giftRows[0].checkout_token
    : null;
  if (giftCheckoutToken && !giftIntentId) {
    await interaction.editReply({ content: '❌ This gift checkout has expired or is no longer available. Create a new gift intent.' });
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

  // BENEFIT-DELIVERABILITY guard — save-time validation runs only when the
  // product is EDITED. A granted role deleted, raised to/above the bot, or a
  // granted channel deleted AFTER activation would let a buyer PAY for a
  // benefit the bot provably cannot deliver. The bot holds the live guild,
  // so validate at the point of sale: refuse the checkout and alert the
  // owner instead of taking money for an undeliverable grant.
  const liveGuild = interaction.guild;
  const grantedRoleIds: string[] = Array.isArray(product.granted_role_ids)
    ? product.granted_role_ids.filter((id: unknown): id is string => typeof id === 'string')
    : [];
  const grantedChannelIds: string[] = Array.isArray(product.granted_channel_ids)
    ? product.granted_channel_ids.filter((id: unknown): id is string => typeof id === 'string')
    : [];
  // Temporary roles are benefits too — they live in their own config table
  // (frozen into temporary_role_grants_snapshot at order time), so the guard
  // must load them or a deleted temp role still takes money. A read error is
  // a money-guard failure: degrade honestly.
  const { data: tempRoleRows, error: tempRoleError } = await supabase
    .from('commerce_product_temp_role_config')
    .select('role_id')
    .eq('product_id', productId)
    .eq('guild_id', guildId);
  if (tempRoleError) {
    await replyCheckoutUnavailable(interaction, supabase, guildId);
    return;
  }
  const temporaryRoleIds: string[] = (Array.isArray(tempRoleRows) ? tempRoleRows : [])
    .map((row) => row.role_id)
    .filter((id): id is string => typeof id === 'string');
  if (liveGuild
    && (grantedRoleIds.length > 0 || grantedChannelIds.length > 0 || temporaryRoleIds.length > 0)) {
    const problems: string[] = [];
    const me = liveGuild.members.me;
    const botHighest = me?.roles.highest.position ?? 0;
    const canManageRoles = me?.permissions.has('ManageRoles') ?? false;
    const canManageChannels = me?.permissions.has('ManageChannels') ?? false;
    for (const roleId of grantedRoleIds) {
      const role = liveGuild.roles.cache.get(roleId);
      if (!role) {
        problems.push(`granted role ${roleId} no longer exists`);
      } else if (role.managed) {
        problems.push(`granted role ${role.name} is integration-managed and cannot be assigned`);
      } else if (role.position >= botHighest) {
        problems.push(`granted role ${role.name} sits at or above the bot's highest role`);
      } else if (!canManageRoles) {
        problems.push('the bot is missing the Manage Roles permission needed to assign roles');
      }
    }
    for (const roleId of temporaryRoleIds) {
      const role = liveGuild.roles.cache.get(roleId);
      if (!role) {
        problems.push(`temporary role ${roleId} no longer exists`);
      } else if (role.managed) {
        problems.push(`temporary role ${role.name} is integration-managed and cannot be assigned`);
      } else if (role.position >= botHighest) {
        problems.push(`temporary role ${role.name} sits at or above the bot's highest role`);
      } else if (!canManageRoles) {
        problems.push('the bot is missing the Manage Roles permission needed to assign roles');
      }
    }
    for (const channelId of grantedChannelIds) {
      const grantedChannel = liveGuild.channels.cache.get(channelId);
      if (!grantedChannel) {
        problems.push(`granted channel ${channelId} no longer exists`);
      } else if (!canManageChannels) {
        problems.push('the bot is missing the Manage Channels permission needed to grant channel access');
      }
    }
    if (problems.length > 0) {
      log.error('Refusing checkout: product benefits are undeliverable', {
        productId,
        problems,
      });
      await raiseOwnerAlert(supabase, guildId, {
        alertType: 'commerce_undeliverable_benefit',
        severity: 'critical',
        title: 'Product benefits are undeliverable',
        message:
          `A buyer tried to purchase "${product.name}" but its Discord benefits cannot be `
          + `delivered right now: ${problems.join('; ')}. The checkout was refused before `
          + 'any payment. Fix the granted roles/channels or deactivate the product.',
        metadata: { product_id: productId, problems },
      });
      await interaction.editReply({
        embeds: [
          brandedEmbed(brandKit, {
            intent: 'warning',
            title: '⚠️ Temporarily Unavailable',
            description:
              'This product cannot be delivered right now, so it cannot be purchased. '
              + 'You have not been charged — the server owner has been notified.',
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

  if (existingCustomer && !giftIntentId) {
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

    if (existing && repeatPurchasePolicy === 'unique') {
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
    const inFlight = repeatPurchasePolicy === 'unique'
      ? await inspectInFlightCheckout(supabase, guildId, existingCustomer.id, productId)
      : { state: 'clear' as const };
    if (inFlight.state === 'unavailable') {
      await replyCheckoutUnavailable(interaction, supabase, guildId);
      return;
    }
    if (inFlight.state === 'blocked') {
      if (inFlight.reason === 'provider_checkout' && inFlight.approvalUrl) {
        await interaction.editReply({
          embeds: [
            brandedEmbed(brandKit, {
              intent: 'primary',
              title: product.type === 'subscription'
                ? `🔄 Resume Subscription: ${product.name}`
                : `🛒 Resume Purchase: ${product.name}`,
              description:
                'Your existing PayPal checkout is still available. Continue it below; no second checkout was created.',
            }),
          ],
          components: [
            new ActionRowBuilder<ButtonBuilder>().addComponents(
              new ButtonBuilder()
                .setLabel(product.type === 'subscription' ? 'Continue Subscription' : 'Continue Purchase')
                .setStyle(ButtonStyle.Link)
                .setURL(inFlight.approvalUrl)
                .setEmoji('💳'),
            ),
          ],
        });
        return;
      }
      const copy = checkoutBlockCopy(inFlight, product.type === 'subscription');
      await interaction.editReply({
        embeds: [
          brandedEmbed(brandKit, {
            intent: 'warning',
            ...copy,
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

  // PayPal receives only this opaque handle; all tenant/product/customer/gift
  // identity remains in the service-role checkout-intent ledger.
  const checkoutToken = randomUUID();
  const checkoutSignature = signCheckoutToken(checkoutToken);
  if (!checkoutSignature) {
    await interaction.editReply({ content: '❌ Checkout signing is temporarily unavailable. Please try again later.' });
    return;
  }
  if (giftIntentId) {
    const { error: giftCheckoutCleanupError } = await supabase.rpc(
      'commerce_prepare_gift_checkout',
      {
        p_guild_id: guildId,
        p_buyer_customer_id: customerId,
        p_product_id: productId,
        p_checkout_token: giftIntentId,
      },
    );
    if (giftCheckoutCleanupError) {
      log.error('Failed to prepare gift checkout ledger:', giftCheckoutCleanupError.message);
      await interaction.editReply({ content: '❌ Gift checkout could not be safely recorded. Please try again.' });
      return;
    }
  }
  const { error: checkoutIntentError } = await supabase.from('commerce_checkout_intents').insert({
    token: checkoutToken,
    guild_id: guildId,
    customer_id: customerId,
    product_id: productId,
    gift_checkout_token: giftIntentId,
  });
  if (checkoutIntentError) {
    log.error('Failed to persist checkout identity:', checkoutIntentError.message);
    await interaction.editReply({ content: '❌ Checkout could not be safely recorded. Please try again.' });
    return;
  }
  const cancelCheckoutIntent = async (reason: string): Promise<void> => {
    const { error } = await supabase
      .from('commerce_checkout_intents')
      .update({ status: 'cancelled', cancel_reason: reason })
      .eq('token', checkoutToken)
      .in('status', ['pending', 'bound']);
    if (error) log.warn('Failed to cancel abandoned checkout intent', { reason, detail: error.message });
  };
  const deactivatePendingOrder = async (order: PendingCheckoutOrder, reason: string): Promise<void> => {
    const providerKind = order.paypal_subscription_id ? 'subscription' : 'capture';
    const providerId = order.paypal_subscription_id ?? order.paypal_order_id;
    if (!providerId) {
      log.warn('Cannot deactivate pending checkout without provider identity', { orderId: order.id, reason });
      return;
    }
    const { error } = await supabase.rpc('commerce_deactivate_pending_checkout', {
      p_order_id: order.id,
      p_guild_id: order.guild_id,
      p_customer_id: order.customer_id,
      p_product_id: order.product_id,
      p_provider_kind: providerKind,
      p_provider_id: providerId,
      p_proof_kind: 'approval_link_not_exposed',
      p_proof_reference: reason,
    });
    if (error) log.warn('Failed to deactivate abandoned pending checkout', { orderId: order.id, reason, detail: error.message });
  };

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
    const productCurrency =
      typeof product.currency === 'string' && /^[A-Za-z]{3}$/.test(product.currency)
        ? product.currency.toUpperCase()
        : null;
    if (!productCurrency) {
      await cancelCheckoutIntent('invalid product billing currency');
      await interaction.editReply({
        content: '❌ This product has an invalid billing currency and cannot be purchased.',
      });
      return;
    }
    // Create PayPal order
    const orderPayload = {
      intent: 'CAPTURE',
      purchase_units: [
        {
          amount: {
            currency_code: productCurrency,
            value: price,
          },
          description: product.name,
          custom_id: `v1:${checkoutToken}.${checkoutSignature}`,
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

    let orderRes: Response;
    try {
      orderRes = await fetch(`${paypalApiBase}/v2/checkout/orders`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(orderPayload),
        signal: AbortSignal.timeout(PAYPAL_FETCH_TIMEOUT_MS),
      });
    } catch (error) {
      log.error('PayPal order creation timed out or failed:', { error: String(error) });
      await cancelCheckoutIntent('provider order creation timed out or failed');
      await interaction.editReply({ content: '❌ Payment service timed out. Please try again.' });
      return;
    }

    if (!orderRes.ok) {
      const err = await orderRes.text();
      log.error('PayPal order creation failed:', { error: String(err) });
      await cancelCheckoutIntent('provider order creation failed');
      await interaction.editReply({ content: '❌ Failed to create payment. Please try again.' });
      return;
    }

    const orderData = await orderRes.json().catch(() => null) as { id?: unknown; links?: Array<{ rel: string; href: string }> } | null;
    if (!orderData || typeof orderData.id !== 'string' || orderData.id.length === 0) {
      await cancelCheckoutIntent('provider order response malformed');
      await interaction.editReply({ content: '❌ Failed to create payment. Please try again.' });
      return;
    }
    const { data: providerBindRow, error: providerBindError } = await supabase
      .from('commerce_checkout_intents')
      .update({ provider_id: orderData.id, status: 'bound' })
      .eq('token', checkoutToken)
      .eq('status', 'pending')
      .select('token')
      .maybeSingle();
    if (providerBindError || !providerBindRow) {
      log.error('Failed to bind PayPal order to checkout ledger:', providerBindError?.message ?? 'no row updated');
      await cancelCheckoutIntent('provider order binding failed');
      await interaction.editReply({ content: '❌ Checkout could not be safely recorded. Please try again.' });
      return;
    }
    const approvalLink = orderData.links?.find((l) => l.rel === 'approve');

    if (!isPayPalApprovalUrl(approvalLink?.href)) {
      await cancelCheckoutIntent('provider approval link missing');
      await interaction.editReply({ content: '❌ Failed to get checkout URL.' });
      return;
    }

    // Create pending order in DB with sequential order number
    const { data: seqResult } = await supabase.rpc('generate_order_number') as { data: string | null; error: unknown };
    const orderNumber = seqResult || `ORD-${Date.now().toString(36).toUpperCase()}`;

    const expectedOrder = {
      order_number: orderNumber,
      customer_id: customerId,
      guild_id: guildId,
      product_id: productId,
      plan_id: null,
      paypal_order_id: orderData.id,
      paypal_subscription_id: null,
      amount_cents: product.price_cents,
      currency: productCurrency,
      checkout_active: true,
      checkout_approval_url: approvalLink.href,
    };
    let pendingOrder: unknown = null;
    let pendingOrderError: { code?: string; message?: string } | null = null;
    // An RPC response can be lost after commit. Replay the exact provider and
    // order-number contract once; SQL returns the already-frozen row only when
    // every immutable field still matches.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await supabase.rpc('commerce_create_active_paid_checkout', {
        p_order_number: orderNumber,
        p_guild_id: guildId,
        p_customer_id: customerId,
        p_product_id: productId,
        p_plan_id: null,
        p_provider_kind: 'capture',
        p_provider_id: orderData.id,
        p_approval_url: approvalLink.href,
        p_amount_cents: product.price_cents,
        p_currency: productCurrency,
      });
      pendingOrder = response.data;
      pendingOrderError = response.error;
      if (!pendingOrderError && isExactPendingCheckoutOrder(pendingOrder, expectedOrder)) {
        break;
      }
      if (parseCheckoutReservationBlock(pendingOrderError)) break;
    }

    if (pendingOrderError || !isExactPendingCheckoutOrder(pendingOrder, expectedOrder)) {
      // The pending-checkout unique index is the atomic version of the
      // pre-flight guard above: it is what actually stops a genuine
      // double-click, where both clicks read "clear" before either inserted.
      // The link is never exposed, so the losing PayPal order cannot be paid.
      const reservationBlock = parseCheckoutReservationBlock(pendingOrderError);
      if (reservationBlock) {
        log.warn('Refused a concurrent second checkout for the same product', { productId });
        await interaction.editReply({
          embeds: [
            brandedEmbed(brandKit, {
              intent: 'warning',
              ...checkoutBlockCopy(reservationBlock, false),
            }),
          ],
        });
        await cancelCheckoutIntent('concurrent checkout reservation blocked');
        return;
      }
      log.error('Failed to persist one-time checkout order:', pendingOrderError?.message ?? 'identity mismatch');
      await interaction.editReply({
        content: '❌ Checkout could not be safely recorded. No payment link was opened; please try again.',
      });
      await cancelCheckoutIntent('pending order persistence failed');
      return;
    }

    if (pendingOrder && typeof pendingOrder === 'object' && 'id' in pendingOrder && typeof (pendingOrder as { id?: unknown }).id === 'string') {
      const { data: orderBindRow, error: orderBindError } = await supabase
        .from('commerce_checkout_intents')
        .update({ order_id: (pendingOrder as { id: string }).id })
        .eq('token', checkoutToken)
        .eq('status', 'bound')
        .select('token')
        .maybeSingle();
      if (orderBindError || !orderBindRow) {
        log.error('Failed to bind pending order to checkout ledger:', orderBindError?.message ?? 'no row updated');
        await deactivatePendingOrder(pendingOrder as PendingCheckoutOrder, 'checkout intent order binding failed');
        await cancelCheckoutIntent('pending order binding failed');
        await interaction.editReply({ content: '❌ Checkout could not be safely recorded. Please try again.' });
        return;
      }
    }

    await interaction.editReply({
      embeds: [
        brandedEmbed(brandKit, {
          intent: 'primary',
          title: `🛒 Purchase: ${product.name}`,
          description:
            `**Price:** $${price} ${productCurrency}\n\nClick the button below to complete your purchase via PayPal.`,
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
      await cancelCheckoutIntent('subscription plan selection failed');
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
      await cancelCheckoutIntent('active subscription plan missing');
      await interaction.editReply({ content: '❌ No active subscription plan found for this product.' });
      return;
    }
    const planCurrency =
      typeof plan.currency === 'string' && /^[A-Za-z]{3}$/.test(plan.currency)
        ? plan.currency.toUpperCase()
        : null;
    if (!planCurrency) {
      await cancelCheckoutIntent('invalid subscription billing currency');
      await interaction.editReply({
        content: '❌ This subscription has an invalid billing currency and cannot be purchased.',
      });
      return;
    }
    const { data: planBindRow, error: planBindError } = await supabase
      .from('commerce_checkout_intents')
      .update({ plan_id: plan.id })
      .eq('token', checkoutToken)
      .eq('status', 'pending')
      .select('token')
      .maybeSingle();
    if (planBindError || !planBindRow) {
      log.error('Failed to bind subscription plan to checkout ledger:', planBindError?.message ?? 'no row updated');
      await cancelCheckoutIntent('subscription plan binding failed');
      await interaction.editReply({ content: '❌ Checkout could not be safely recorded. Please try again.' });
      return;
    }

    // Create PayPal subscription
    const subPayload = {
      plan_id: plan.paypal_plan_id,
      custom_id: `v1:${checkoutToken}.${checkoutSignature}`,
      application_context: {
        brand_name: brandName,
        locale: 'en-US',
        user_action: 'SUBSCRIBE_NOW',
        return_url: returnUrl,
        cancel_url: cancelUrl,
      },
    };

    let subRes: Response;
    try {
      subRes = await fetch(`${paypalApiBase}/v1/billing/subscriptions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(subPayload),
        signal: AbortSignal.timeout(PAYPAL_FETCH_TIMEOUT_MS),
      });
    } catch (error) {
      log.error('PayPal subscription creation timed out or failed:', { error: String(error) });
      await cancelCheckoutIntent('provider subscription creation timed out or failed');
      await interaction.editReply({ content: '❌ Payment service timed out. Please try again.' });
      return;
    }

    if (!subRes.ok) {
      const err = await subRes.text();
      log.error('PayPal subscription creation failed:', { error: String(err) });
      await cancelCheckoutIntent('provider subscription creation failed');
      await interaction.editReply({ content: '❌ Failed to create subscription. Please try again.' });
      return;
    }

    const subData = await subRes.json().catch(() => null) as { id?: unknown; links?: Array<{ rel: string; href: string }> } | null;
    if (!subData || typeof subData.id !== 'string' || subData.id.length === 0) {
      await cancelCheckoutIntent('provider subscription response malformed');
      await interaction.editReply({ content: '❌ Failed to create subscription. Please try again.' });
      return;
    }
    const { data: providerBindRow, error: providerBindError } = await supabase
      .from('commerce_checkout_intents')
      .update({ provider_id: subData.id, status: 'bound' })
      .eq('token', checkoutToken)
      .eq('status', 'pending')
      .select('token')
      .maybeSingle();
    if (providerBindError || !providerBindRow) {
      log.error('Failed to bind PayPal subscription to checkout ledger:', providerBindError?.message ?? 'no row updated');
      await cancelCheckoutIntent('provider subscription binding failed');
      await interaction.editReply({ content: '❌ Checkout could not be safely recorded. Please try again.' });
      return;
    }
    const approvalLink = subData.links?.find((l) => l.rel === 'approve');

    if (!isPayPalApprovalUrl(approvalLink?.href)) {
      await cancelCheckoutIntent('provider subscription approval link missing');
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
      order_number: orderNumber,
      customer_id: customerId,
      guild_id: guildId,
      product_id: productId,
      plan_id: plan.id,
      paypal_order_id: null,
      paypal_subscription_id: subData.id,
      amount_cents: plan.price_cents,
      currency: planCurrency,
      checkout_active: true,
      checkout_approval_url: approvalLink.href,
    };
    let pendingOrder: unknown = null;
    let pendingOrderError: { code?: string; message?: string } | null = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await supabase.rpc('commerce_create_active_paid_checkout', {
        p_order_number: orderNumber,
        p_guild_id: guildId,
        p_customer_id: customerId,
        p_product_id: productId,
        p_plan_id: plan.id,
        p_provider_kind: 'subscription',
        p_provider_id: subData.id,
        p_approval_url: approvalLink.href,
        p_amount_cents: plan.price_cents,
        p_currency: planCurrency,
      });
      pendingOrder = response.data;
      pendingOrderError = response.error;
      if (!pendingOrderError && isExactPendingCheckoutOrder(pendingOrder, expectedOrder)) {
        break;
      }
      if (parseCheckoutReservationBlock(pendingOrderError)) break;
    }

    if (pendingOrderError || !isExactPendingCheckoutOrder(pendingOrder, expectedOrder)) {
      const reservationBlock = parseCheckoutReservationBlock(pendingOrderError);
      if (reservationBlock) {
        log.warn('Refused a concurrent second subscription checkout for the same product', {
          productId,
        });
        await interaction.editReply({
          embeds: [
            brandedEmbed(brandKit, {
              intent: 'warning',
              ...checkoutBlockCopy(reservationBlock, true),
            }),
          ],
        });
        await cancelCheckoutIntent('concurrent subscription reservation blocked');
        return;
      }
      log.error('Failed to persist subscription checkout order:', pendingOrderError?.message ?? 'identity mismatch');
      await interaction.editReply({
        content: '❌ Checkout could not be safely recorded. No subscription link was opened; please try again.',
      });
      await cancelCheckoutIntent('pending subscription order persistence failed');
      return;
    }

    if (pendingOrder && typeof pendingOrder === 'object' && 'id' in pendingOrder && typeof (pendingOrder as { id?: unknown }).id === 'string') {
      const { data: orderBindRow, error: orderBindError } = await supabase
        .from('commerce_checkout_intents')
        .update({ order_id: (pendingOrder as { id: string }).id })
        .eq('token', checkoutToken)
        .eq('status', 'bound')
        .select('token')
        .maybeSingle();
      if (orderBindError || !orderBindRow) {
        log.error('Failed to bind pending subscription order to checkout ledger:', orderBindError?.message ?? 'no row updated');
        await deactivatePendingOrder(pendingOrder as PendingCheckoutOrder, 'checkout intent subscription order binding failed');
        await cancelCheckoutIntent('pending subscription order binding failed');
        await interaction.editReply({ content: '❌ Checkout could not be safely recorded. Please try again.' });
        return;
      }
    }

    await interaction.editReply({
      embeds: [
        brandedEmbed(brandKit, {
          intent: 'primary',
          title: `🔄 Subscribe: ${product.name}`,
          description:
            `**Plan:** ${plan.name}\n**Price:** $${(plan.price_cents / 100).toFixed(2)} ${planCurrency}/${plan.interval_unit.toLowerCase()}\n\nClick the button below to start your subscription via PayPal.`,
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
