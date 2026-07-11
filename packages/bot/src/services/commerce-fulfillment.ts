/**
 * Commerce Fulfillment Service
 *
 * Unified pipeline for post-payment fulfillment. When the dashboard webhook
 * writes a fulfillment request to `bot_action_queue`, this service:
 *
 * 1. Grants entitlement via EntitlementService (creates DB record + Discord roles)
 * 2. Emits platform events (purchase.completed / subscription.activated)
 * 3. Sends receipt DM with license key (if applicable)
 * 4. Logs everything to audit trail
 *
 * This bridges the gap between the Next.js webhook (no Discord access) and the
 * bot process (full Discord access + event bus).
 */

import type { Guild, User } from 'discord.js';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { PlatformEventBus } from './event-bus.js';
import { EntitlementService } from '../features/commerce/entitlement-service.js';
import { deliverReceiptDM } from '../features/commerce/receipt-builder.js';
import { createLogger, getGracePeriodDays } from '@somnibot/shared';

const log = createLogger('Fulfillment');
import { checkPurchaseVelocity, checkPaymentPattern, checkCriticalThreshold } from './fraud-detection.js';

// ── Types ──────────────────────────────────────────────────

export interface FulfillmentPayload {
  /** 'one_time_purchase' | 'subscription_activated' | 'subscription_renewed' | 'subscription_cancelled' | 'subscription_suspended' */
  fulfillment_type: string;
  guild_id: string;
  customer_id: string;
  discord_id: string;
  product_id: string;
  product_name: string;
  order_id: string;
  order_number: string;
  plan_id?: string;
  amount_cents: number;
  currency: string;
  granted_role_ids: string[];
  granted_channel_ids: string[];
  /** Frozen one-time-purchase configuration; subscriptions never use this. */
  temporary_role_grants?: Array<{
    role_id: string;
    duration_seconds: number;
  }>;
  license_key_id?: string;
  license_key_plaintext?: string;
  entitlement_type: 'one_time' | 'subscription';
  /** For renewals — existing entitlement to reactivate */
  existing_entitlement_id?: string;
}

type PreparedTemporaryRoleGrant = {
  id: string;
  grant_status: 'pending' | 'applied';
  expires_at: string;
};

const DISCORD_ROLE_ID_PATTERN = /^\d{17,20}$/;
const MAX_TEMP_ROLE_DURATION_SECONDS = 315_360_000;

function normalizeTemporaryRoleGrants(
  value: FulfillmentPayload['temporary_role_grants'],
): Array<{ role_id: string; duration_seconds: number }> {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new Error('Malformed temporary_role_grants payload');
  }

  const validated = value.map((grant) => {
    if (
      !grant
      || typeof grant.role_id !== 'string'
      || !DISCORD_ROLE_ID_PATTERN.test(grant.role_id)
      || !Number.isSafeInteger(grant.duration_seconds)
      || grant.duration_seconds <= 0
      || grant.duration_seconds > MAX_TEMP_ROLE_DURATION_SECONDS
    ) {
      throw new Error('Malformed temporary role grant snapshot');
    }
    return grant;
  });

  // A queue payload is untrusted input. Sort first so duplicate role rows are
  // resolved deterministically; for conflicting durations, retain the longest
  // frozen duration so a duplicate cannot shorten purchased access.
  validated.sort((left, right) =>
    left.role_id.localeCompare(right.role_id)
    || right.duration_seconds - left.duration_seconds,
  );

  const unique = new Map<string, { role_id: string; duration_seconds: number }>();
  for (const grant of validated) {
    if (!unique.has(grant.role_id)) unique.set(grant.role_id, grant);
  }
  return [...unique.values()];
}

function isPreparedTemporaryRoleGrant(value: unknown): value is PreparedTemporaryRoleGrant {
  if (!value || typeof value !== 'object') return false;
  const grant = value as Partial<PreparedTemporaryRoleGrant>;
  return (
    typeof grant.id === 'string'
    && grant.id.length > 0
    && (grant.grant_status === 'pending' || grant.grant_status === 'applied')
    && typeof grant.expires_at === 'string'
    && Number.isFinite(Date.parse(grant.expires_at))
  );
}

function isSameUniqueStringSet(value: unknown, expected: string[]): boolean {
  if (
    !Array.isArray(value)
    || value.some((entry) => typeof entry !== 'string' || entry.length === 0)
  ) {
    return false;
  }
  const actualSet = new Set(value);
  const expectedSet = new Set(expected);
  if (actualSet.size !== value.length || expectedSet.size !== expected.length) return false;
  if (actualSet.size !== expectedSet.size) return false;
  return [...actualSet].every((entry) => expectedSet.has(entry));
}

export interface FulfillmentResult {
  success: boolean;
  entitlementId?: string;
  receiptSent?: boolean;
  /** Set when the receipt DM failed and a persistent re-delivery was queued. */
  receiptRetryQueued?: boolean;
  eventEmitted?: boolean;
  errors: string[];
}

// ── Receipt Delivery Retry ─────────────────────────────────
// A paid customer's receipt/license-key DM must never fail silently. When
// the initial DM attempt fails, delivery is re-queued through
// `bot_action_queue` (the existing persistent retry infrastructure: backoff,
// max attempts, stale recovery). The queue handler classifies failures —
// transient ones retry, permanent ones (DMs disabled) don't burn retries —
// and final failures are dead-lettered to `action_queue_dlq` plus surfaced
// via an `alerts` row so the dashboard shows "delivery failed, act manually".

/** bot_action_queue action used for persistent receipt re-delivery. */
export const RECEIPT_DELIVERY_ACTION = 'deliver_receipt';

export interface ReceiptDeliveryPayload {
  guild_id: string;
  discord_id: string;
  order_id: string;
  order_number: string;
  product_name: string;
  amount_cents: number;
  currency: string;
  license_key_plaintext?: string;
  /**
   * ISO timestamp of the order (captured at fulfillment time — the same
   * date the initial receipt DM would have shown). A delayed redelivery
   * must render this, not the time the retry finally succeeded.
   */
  order_date?: string;
}

export type DeliveryFailureKind = 'permanent' | 'transient';

// Bounded in-process retry for the bot_action_queue insert in
// queueReceiptRedelivery. The queue row is what carries the plaintext
// license key into the retry pipeline — only its hash is stored at rest in
// `license_keys` — so losing the insert loses the key. Worth a few quick
// attempts before falling back to the dead-letter queue.
const QUEUE_INSERT_MAX_ATTEMPTS = 3;
const QUEUE_INSERT_BACKOFF_MS = [500, 2_000];

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

// Discord REST error codes for which retrying a DM can never succeed:
// 50007 = Cannot send messages to this user (DMs disabled / bot blocked)
// 10013 = Unknown User
const PERMANENT_DELIVERY_ERROR_CODES = new Set([50007, 10013]);

/**
 * Classify a receipt DM delivery error. Permanent failures (user has DMs
 * disabled, unknown user) should not be retried; everything else (network
 * blips, Discord 5xx, rate limits) is assumed transient and retryable.
 */
export function classifyDeliveryError(err: unknown): DeliveryFailureKind {
  const rawCode = (err as { code?: unknown } | null)?.code;
  const code = typeof rawCode === 'string' ? Number(rawCode) : rawCode;
  if (typeof code === 'number' && PERMANENT_DELIVERY_ERROR_CODES.has(code)) {
    return 'permanent';
  }
  return 'transient';
}

/**
 * Write the operator-visible alert for a receipt delivery failure. The
 * dashboard surfaces `alerts` rows; the message tells the operator the
 * recovery path that actually works: the full delivery payload (including
 * the plaintext license key) is preserved in the dead-letter queue, so the
 * delivery can be retried from the dashboard or the key resent manually.
 * The customer portal is NOT a recovery path — license_keys stores only
 * hash/prefix/suffix, and the portal displays only the masked key.
 */
export async function writeReceiptDeliveryAlert(
  supabase: SupabaseClient,
  opts: {
    guildId: string;
    orderNumber: string;
    productName: string;
    discordId: string;
    kind: DeliveryFailureKind;
    attempts: number;
    lastError: string;
    /**
     * Whether the delivery payload (with the plaintext key) made it into
     * action_queue_dlq. Defaults to true — every caller writes the DLQ row
     * before alerting; pass false only when that write itself failed, so
     * the operator isn't sent to an empty DLQ.
     */
    payloadPreserved?: boolean;
  },
): Promise<void> {
  const payloadPreserved = opts.payloadPreserved ?? true;
  const recovery = payloadPreserved
    ? 'The full delivery payload (including the license key) is preserved in the dead-letter queue — ' +
      'retry the delivery from the dashboard DLQ, or use the preserved key to deliver it through ' +
      'another channel. Note: the customer portal shows only a masked key, so it cannot be used for recovery.'
    : 'The delivery payload could NOT be preserved in the dead-letter queue (database write failed), ' +
      'so the plaintext key is unrecoverable — revoke the license key for this order and reissue it manually.';
  const message =
    opts.kind === 'permanent'
      ? `Could not DM the receipt/license key for **${opts.productName}** (order ${opts.orderNumber}): ` +
        'the customer has DMs disabled or is unreachable, so automatic retries will not help. ' +
        recovery
      : `Could not DM the receipt/license key for **${opts.productName}** (order ${opts.orderNumber}) ` +
        `after ${opts.attempts} attempt(s). ` +
        recovery;

  const { error } = await supabase.from('alerts').insert({
    guild_id: opts.guildId,
    alert_type: 'receipt_delivery_failed',
    severity: 'critical',
    title: `Receipt delivery failed — order ${opts.orderNumber}`,
    message,
    metadata: {
      orderNumber: opts.orderNumber,
      productName: opts.productName,
      discordId: opts.discordId,
      kind: opts.kind,
      attempts: opts.attempts,
      lastError: opts.lastError,
      payloadPreserved,
    },
  });
  if (error) {
    log.error('Failed to write receipt delivery alert', { order: opts.orderNumber, detail: error.message });
  }
}

// ── Service ────────────────────────────────────────────────

export class CommerceFulfillmentService {
  private entitlementService: EntitlementService;

  constructor(
    private guild: Guild,
    private supabase: SupabaseClient,
    private eventBus: PlatformEventBus,
  ) {
    this.entitlementService = new EntitlementService(guild, supabase, eventBus);
  }

  /**
   * Process a fulfillment request from the action queue.
   */
  async fulfill(payload: FulfillmentPayload): Promise<FulfillmentResult> {
    const result: FulfillmentResult = {
      success: false,
      errors: [],
    };

    // The action row is dispatched by a concrete Discord guild instance. A
    // payload for any other guild (or without complete identity) must be
    // rejected before even a database read, audit write, or Discord call.
    if (
      payload.guild_id !== this.guild.id
      || ![
        payload.guild_id,
        payload.customer_id,
        payload.discord_id,
        payload.product_id,
        payload.order_id,
        payload.order_number,
      ].every((value) => typeof value === 'string' && value.length > 0 && value.trim() === value)
      || !Array.isArray(payload.granted_role_ids)
      || !Array.isArray(payload.granted_channel_ids)
      || payload.granted_role_ids.some((value) =>
        typeof value !== 'string' || value.length === 0 || value.trim() !== value)
      || payload.granted_channel_ids.some((value) =>
        typeof value !== 'string' || value.length === 0 || value.trim() !== value)
      || !Number.isSafeInteger(payload.amount_cents)
      || payload.amount_cents < 0
      || typeof payload.currency !== 'string'
      || payload.currency.length === 0
      || payload.currency.trim() !== payload.currency
    ) {
      result.errors.push('Fulfillment payload failed exact guild/identity validation');
      return result;
    }

    // Audit V2 Finding 3.7 — Redact discord_id from logs (show last 4 chars only)
    const redactedId = payload.discord_id ? `***${payload.discord_id.slice(-4)}` : 'unknown';
    log.info('Processing fulfillment', { type: payload.fulfillment_type, user: redactedId, order: payload.order_number });

    try {
      switch (payload.fulfillment_type) {
        case 'one_time_purchase':
          await this.handleOneTimePurchase(payload, result);
          break;
        case 'subscription_activated':
          await this.handleSubscriptionActivated(payload, result);
          break;
        case 'subscription_renewed':
          await this.handleSubscriptionRenewed(payload, result);
          break;
        case 'subscription_cancelled':
          await this.handleSubscriptionCancelled(payload, result);
          break;
        case 'subscription_suspended':
          await this.handleSubscriptionSuspended(payload, result);
          break;
        default:
          result.errors.push(`Unknown fulfillment type: ${payload.fulfillment_type}`);
          return result;
      }

      result.success = result.errors.length === 0;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      result.errors.push(`Fulfillment error: ${msg}`);
      log.error('Fatal error in fulfillment pipeline', { detail: err });
    }

    // Audit log the fulfillment attempt
    await this.auditLog(payload, result);

    return result;
  }

  // ── One-Time Purchase ────────────────────────────────────

  private async handleOneTimePurchase(
    payload: FulfillmentPayload,
    result: FulfillmentResult,
  ): Promise<void> {
    if (payload.entitlement_type !== 'one_time') {
      throw new Error('One-time fulfillment payload failed entitlement type validation');
    }
    const temporaryRoleGrants = normalizeTemporaryRoleGrants(payload.temporary_role_grants);
    await this.validatePayloadCustomerIdentity(payload);
    await this.validatePayloadOrderSnapshot(payload, temporaryRoleGrants);

    // 1. Grant the entitlement once, or reuse the durable order-scoped row on
    // a queue retry after a later temporary-role step failed.
    let entitlementId = await this.findOrderEntitlement(payload);
    let reusedEntitlement = entitlementId !== null;
    if (!entitlementId) {
      entitlementId = await this.entitlementService.grant({
        customerId: payload.customer_id,
        productId: payload.product_id,
        productName: payload.product_name,
        orderId: payload.order_id,
        licenseKeyId: payload.license_key_id,
        discordId: payload.discord_id,
        type: 'one_time',
        source: 'purchase',
        grantedRoleIds: payload.granted_role_ids,
        grantedChannelIds: payload.granted_channel_ids,
      });

      // A concurrent/replayed worker may have won the unique order_id insert.
      // Re-read the durable row before treating a null grant result as fatal.
      if (!entitlementId) {
        entitlementId = await this.findOrderEntitlement(payload);
        reusedEntitlement = entitlementId !== null;
      }
    }

    if (!entitlementId) {
      result.errors.push('Failed to create entitlement');
      return;
    }
    result.entitlementId = entitlementId;

    // An at-least-once queue retry can resume after the entitlement insert but
    // before Discord acknowledged every permanent role. Reusing the row is
    // safe only after a fresh Discord read repairs and confirms the frozen
    // role vector.
    if (reusedEntitlement) {
      await this.entitlementService.ensureGrantedRoles(
        payload.discord_id,
        payload.granted_role_ids,
      );
    }

    // 2. Commit durable provenance before mutating any temporary Discord role.
    await this.applyTemporaryRoleGrants(payload, temporaryRoleGrants);

    // 3. Emit purchase.completed event (noncritical consumers only)
    this.eventBus.emit('purchase.completed', payload.guild_id, {
      discordId: payload.discord_id,
      orderId: payload.order_id,
      orderNumber: payload.order_number,
      productId: payload.product_id,
      productName: payload.product_name,
      amount: payload.amount_cents,
      currency: payload.currency,
    });
    result.eventEmitted = true;

    // 4. Send receipt DM
    await this.sendReceipt(payload, result);

    // 5. Run fraud checks (non-blocking — don't fail fulfillment)
    this.runFraudChecks(payload).catch((err) =>
      log.warn('Fraud check error (non-fatal)', { detail: err }),
    );
  }

  private async findOrderEntitlement(payload: FulfillmentPayload): Promise<string | null> {
    const { data, error } = await this.supabase
      .from('entitlements')
      .select('id, customer_id, product_id, plan_id, license_key_id, type, status, source, granted_role_ids, granted_channel_ids')
      .eq('guild_id', payload.guild_id)
      .eq('order_id', payload.order_id)
      .maybeSingle();
    if (error) {
      throw new Error(`Failed to inspect existing entitlement: ${error.message}`);
    }
    if (!data) return null;

    if (
      typeof data.id !== 'string'
      || data.id.length === 0
      || data.customer_id !== payload.customer_id
      || data.product_id !== payload.product_id
      || (data.plan_id ?? null) !== (payload.plan_id ?? null)
      || (data.license_key_id ?? null) !== (payload.license_key_id ?? null)
      || data.type !== payload.entitlement_type
      || data.status !== 'active'
      || data.source !== 'purchase'
      || !isSameUniqueStringSet(data.granted_role_ids, payload.granted_role_ids)
      || !isSameUniqueStringSet(data.granted_channel_ids, payload.granted_channel_ids)
    ) {
      throw new Error('Existing order entitlement failed identity validation');
    }
    return data.id;
  }

  private async validatePayloadCustomerIdentity(payload: FulfillmentPayload): Promise<void> {
    const { data, error } = await this.supabase
      .from('customers')
      .select('id, guild_id, discord_id')
      .eq('id', payload.customer_id)
      .eq('guild_id', payload.guild_id)
      .maybeSingle();
    if (error) {
      throw new Error(`Failed to verify fulfillment customer identity: ${error.message}`);
    }
    if (
      !data
      || data.id !== payload.customer_id
      || data.guild_id !== payload.guild_id
      || data.discord_id !== payload.discord_id
    ) {
      throw new Error('Fulfillment customer identity is missing or mismatched');
    }
  }

  private async validatePayloadOrderSnapshot(
    payload: FulfillmentPayload,
    temporaryRoleGrants: Array<{ role_id: string; duration_seconds: number }>,
  ): Promise<void> {
    const { data, error } = await this.supabase
      .from('orders')
      .select('id, guild_id, customer_id, product_id, plan_id, amount_cents, currency, source, status, granted_role_ids_snapshot, granted_channel_ids_snapshot, temporary_role_grants_snapshot, grant_snapshot_frozen_at')
      .eq('id', payload.order_id)
      .eq('guild_id', payload.guild_id)
      .maybeSingle();
    if (error) throw new Error(`Failed to verify fulfillment order snapshot: ${error.message}`);

    let frozenTemporaryRoleGrants: Array<{ role_id: string; duration_seconds: number }>;
    try {
      frozenTemporaryRoleGrants = normalizeTemporaryRoleGrants(
        data?.temporary_role_grants_snapshot as FulfillmentPayload['temporary_role_grants'],
      );
    } catch {
      throw new Error('Fulfillment order returned a malformed frozen grant snapshot');
    }
    const tempSnapshotsMatch = frozenTemporaryRoleGrants.length === temporaryRoleGrants.length
      && frozenTemporaryRoleGrants.every((grant, index) =>
        grant.role_id === temporaryRoleGrants[index]?.role_id
        && grant.duration_seconds === temporaryRoleGrants[index]?.duration_seconds);

    if (
      !data
      || data.id !== payload.order_id
      || data.guild_id !== payload.guild_id
      || data.customer_id !== payload.customer_id
      || data.product_id !== payload.product_id
      || (data.plan_id ?? null) !== (payload.plan_id ?? null)
      || data.amount_cents !== payload.amount_cents
      || data.currency !== payload.currency
      || (data.source !== 'purchase' && data.source !== null)
      || data.status !== 'completed'
      || typeof data.grant_snapshot_frozen_at !== 'string'
      || data.grant_snapshot_frozen_at.length === 0
      || !Number.isFinite(Date.parse(data.grant_snapshot_frozen_at))
      || !isSameUniqueStringSet(data.granted_role_ids_snapshot, payload.granted_role_ids)
      || !isSameUniqueStringSet(data.granted_channel_ids_snapshot, payload.granted_channel_ids)
      || !tempSnapshotsMatch
    ) {
      throw new Error('Fulfillment order failed exact frozen snapshot validation');
    }
  }

  private async findSubscriptionLifecycleEntitlement(
    payload: FulfillmentPayload,
  ): Promise<{
    id: string;
    status: string;
  }> {
    if (payload.entitlement_type !== 'subscription') {
      throw new Error('Subscription lifecycle payload failed entitlement type validation');
    }

    const { data, error } = await this.supabase
      .from('entitlements')
      .select('id, guild_id, customer_id, order_id, product_id, plan_id, type, status, source, customers(id, guild_id, discord_id)')
      .eq('guild_id', payload.guild_id)
      .eq('order_id', payload.order_id)
      .maybeSingle();
    if (error) {
      throw new Error(`Failed to inspect subscription entitlement: ${error.message}`);
    }

    const customer = Array.isArray(data?.customers) ? data.customers[0] : data?.customers;
    if (
      !data
      || typeof data.id !== 'string'
      || data.id.length === 0
      || data.guild_id !== payload.guild_id
      || data.customer_id !== payload.customer_id
      || data.order_id !== payload.order_id
      || data.product_id !== payload.product_id
      || (payload.plan_id !== undefined && data.plan_id !== payload.plan_id)
      || data.type !== 'subscription'
      || typeof data.status !== 'string'
      || ![
        'active',
        'pending',
        'grace_period',
        'suspended',
        'cancelled',
        'expired',
        'revoked',
      ].includes(data.status)
      || (data.source !== 'purchase' && data.source !== null)
      || !customer
      || customer.id !== payload.customer_id
      || customer.guild_id !== payload.guild_id
      || customer.discord_id !== payload.discord_id
    ) {
      throw new Error('Subscription entitlement failed exact lifecycle identity validation');
    }

    return { id: data.id, status: data.status };
  }

  private async applyTemporaryRoleGrants(
    payload: FulfillmentPayload,
    grants: Array<{ role_id: string; duration_seconds: number }>,
  ): Promise<void> {
    for (const grant of grants) {
      const { data, error } = await this.supabase.rpc('commerce_prepare_temp_role_grant', {
        p_guild_id: payload.guild_id,
        p_user_id: payload.discord_id,
        p_role_id: grant.role_id,
        p_order_id: payload.order_id,
        p_product_id: payload.product_id,
        p_duration_seconds: grant.duration_seconds,
      });

      if (error) {
        throw new Error(
          `Failed to prepare temporary role ${grant.role_id}: ${error.message}`,
        );
      }
      if (!isPreparedTemporaryRoleGrant(data)) {
        throw new Error(`Malformed temporary role provenance for ${grant.role_id}`);
      }

      const expiresAt = Date.parse(data.expires_at);
      if (data.grant_status === 'applied' && expiresAt <= Date.now()) {
        // Expiry reconciliation owns already-expired applied rows. A late
        // fulfillment replay must never resurrect their Discord role.
        continue;
      }
      if (data.grant_status === 'pending' && expiresAt <= Date.now()) {
        throw new Error(`Temporary role ${grant.role_id} expired before Discord delivery`);
      }

      try {
        let member = await this.guild.members.fetch({
          user: payload.discord_id,
          force: true,
        });

        const roleWasPresent = member.roles.cache.has(grant.role_id);
        const permanentSnapshotAlsoOwnsRole = payload.granted_role_ids.includes(grant.role_id);
        const canonicalOwnerAlreadyOwnsRole = permanentSnapshotAlsoOwnsRole
          || (
            roleWasPresent
            && await this.hasOtherCanonicalLiveRoleOwner(payload, grant.role_id, data.id)
          );
        if (!roleWasPresent || canonicalOwnerAlreadyOwnsRole) {
          // Persist ownership before any add. The overlap case matters too:
          // the permanent grant earlier in this same payload may be why the
          // role is already present. Without this marker, permanent expiry
          // followed by temp expiry could strand the role forever.
          await this.persistTemporaryRoleRemovalIntent(data.id, data.grant_status);
        }

        if (!roleWasPresent) {
          await member.roles.add(
            grant.role_id,
            `SomniBot temporary commerce role — order ${payload.order_number}`,
          );
          // Confirm the role from Discord before acknowledging provenance. A
          // successful REST response followed by a failed confirmation leaves
          // the row pending so a retry can safely observe and finish it.
          member = await this.guild.members.fetch({
            user: payload.discord_id,
            force: true,
          });
        }

        if (!member.roles.cache.has(grant.role_id)) {
          throw new Error('Discord did not confirm the temporary role');
        }
      } catch (discordError) {
        const detail = (
          discordError instanceof Error ? discordError.message : String(discordError)
        ).slice(0, 1_000);
        await this.recordTemporaryRoleFailure(data.id, detail);
        throw new Error(`Failed to apply temporary role ${grant.role_id}: ${detail}`);
      }

      // Applied rows have already committed their completion marker. The work
      // above is only an idempotent Discord repair/confirmation.
      if (data.grant_status === 'applied') continue;

      const appliedAt = new Date().toISOString();
      const { data: acknowledged, error: acknowledgeError } = await this.supabase
        .from('temp_role_grants')
        .update({
          grant_status: 'applied',
          applied_at: appliedAt,
          last_error: null,
          updated_at: appliedAt,
        })
        .eq('id', data.id)
        .select('id')
        .maybeSingle();

      if (acknowledgeError || acknowledged?.id !== data.id) {
        const detail = acknowledgeError?.message ?? 'provenance row was not acknowledged';
        await this.recordTemporaryRoleFailure(data.id, detail);
        throw new Error(`Failed to acknowledge temporary role ${grant.role_id}: ${detail}`);
      }
    }
  }

  private async hasOtherCanonicalLiveRoleOwner(
    payload: FulfillmentPayload,
    roleId: string,
    grantId: string,
  ): Promise<boolean> {
    const nowIso = new Date().toISOString();
    const { data: tempOwners, error: tempError } = await this.supabase
      .from('temp_role_grants')
      .select('id, guild_id, user_id, role_id, expires_at, grant_status')
      .eq('guild_id', payload.guild_id)
      .eq('user_id', payload.discord_id)
      .eq('role_id', roleId)
      .neq('id', grantId)
      .in('grant_status', ['pending', 'applied'])
      .gt('expires_at', nowIso)
      .order('id', { ascending: true })
      .limit(1);
    if (tempError) {
      throw new Error(`Temporary role ownership lookup failed: ${tempError.message}`);
    }
    if (!Array.isArray(tempOwners) || tempOwners.length > 1) {
      throw new Error('Temporary role ownership lookup returned malformed data');
    }
    if (tempOwners.length === 1) {
      const owner = tempOwners[0];
      if (
        typeof owner?.id !== 'string'
        || owner.id.length === 0
        || owner.guild_id !== payload.guild_id
        || owner.user_id !== payload.discord_id
        || owner.role_id !== roleId
        || !Number.isFinite(Date.parse(owner.expires_at))
        || Date.parse(owner.expires_at) <= Date.parse(nowIso)
        || (owner.grant_status !== 'pending' && owner.grant_status !== 'applied')
      ) {
        throw new Error('Temporary role ownership lookup returned a mismatched grant');
      }
      return true;
    }

    const { data: entitlementOwners, error: entitlementError } = await this.supabase
      .from('entitlements')
      .select('id, guild_id, customer_id, status, granted_role_ids')
      .eq('guild_id', payload.guild_id)
      .eq('customer_id', payload.customer_id)
      .in('status', ['active', 'pending', 'grace_period', 'suspended'])
      .contains('granted_role_ids', [roleId])
      .order('id', { ascending: true })
      .limit(1);
    if (entitlementError) {
      throw new Error(`Entitlement role ownership lookup failed: ${entitlementError.message}`);
    }
    if (!Array.isArray(entitlementOwners) || entitlementOwners.length > 1) {
      throw new Error('Entitlement role ownership lookup returned malformed data');
    }
    if (entitlementOwners.length === 0) return false;

    const owner = entitlementOwners[0];
    if (
      typeof owner?.id !== 'string'
      || owner.id.length === 0
      || owner.guild_id !== payload.guild_id
      || owner.customer_id !== payload.customer_id
      || typeof owner.status !== 'string'
      || !['active', 'pending', 'grace_period', 'suspended'].includes(owner.status)
      || !Array.isArray(owner.granted_role_ids)
      || !owner.granted_role_ids.every((value) => typeof value === 'string')
      || !owner.granted_role_ids.includes(roleId)
    ) {
      throw new Error('Entitlement role ownership lookup returned a mismatched entitlement');
    }
    return true;
  }

  private async persistTemporaryRoleRemovalIntent(
    grantId: string,
    grantStatus: PreparedTemporaryRoleGrant['grant_status'],
  ): Promise<void> {
    const intentAt = new Date().toISOString();
    const { data, error } = await this.supabase
      .from('temp_role_grants')
      .update({
        remove_on_expiry: true,
        updated_at: intentAt,
      })
      .eq('id', grantId)
      .eq('grant_status', grantStatus)
      .select('id, remove_on_expiry')
      .maybeSingle();
    if (error || data?.id !== grantId || data.remove_on_expiry !== true) {
      const detail = error?.message ?? 'removal intent was not acknowledged';
      throw new Error(`Failed to persist temporary-role removal intent: ${detail}`);
    }
  }

  private async recordTemporaryRoleFailure(grantId: string, detail: string): Promise<void> {
    try {
      const { error } = await this.supabase
        .from('temp_role_grants')
        .update({
          last_error: detail,
          updated_at: new Date().toISOString(),
        })
        .eq('id', grantId);
      if (error) {
        log.warn('Failed to record temporary role delivery error', {
          grantId,
          detail: error.message,
        });
      }
    } catch (err) {
      log.warn('Failed to record temporary role delivery error', { grantId, detail: err });
    }
  }

  // ── Subscription Activated ───────────────────────────────

  private async handleSubscriptionActivated(
    payload: FulfillmentPayload,
    result: FulfillmentResult,
  ): Promise<void> {
    if (payload.entitlement_type !== 'subscription') {
      throw new Error('Subscription fulfillment payload failed entitlement type validation');
    }
    await this.validatePayloadCustomerIdentity(payload);
    const temporaryRoleGrants = normalizeTemporaryRoleGrants(payload.temporary_role_grants);
    await this.validatePayloadOrderSnapshot(payload, temporaryRoleGrants);

    // 1. Grant once, or resume the exact durable entitlement after a worker
    // crash/Discord failure. Subscription actions use the same unique order_id
    // boundary as one-time purchases and therefore need the same replay path.
    let entitlementId = await this.findOrderEntitlement(payload);
    let reusedEntitlement = entitlementId !== null;
    if (!entitlementId) {
      entitlementId = await this.entitlementService.grant({
        customerId: payload.customer_id,
        productId: payload.product_id,
        productName: payload.product_name,
        orderId: payload.order_id,
        planId: payload.plan_id,
        discordId: payload.discord_id,
        type: 'subscription',
        source: 'purchase',
        grantedRoleIds: payload.granted_role_ids,
        grantedChannelIds: payload.granted_channel_ids,
      });
      if (!entitlementId) {
        entitlementId = await this.findOrderEntitlement(payload);
        reusedEntitlement = entitlementId !== null;
      }
    }

    if (!entitlementId) {
      result.errors.push('Failed to create subscription entitlement');
      return;
    }
    result.entitlementId = entitlementId;

    if (reusedEntitlement) {
      await this.entitlementService.ensureGrantedRoles(
        payload.discord_id,
        payload.granted_role_ids,
      );
    }

    // 2. Emit subscription.activated event
    this.eventBus.emit('subscription.activated', payload.guild_id, {
      discordId: payload.discord_id,
      productId: payload.product_id,
      planId: payload.plan_id ?? '',
      status: 'activated',
    });
    result.eventEmitted = true;

    // 3. Send receipt DM
    await this.sendReceipt(payload, result);

    // Run fraud checks (non-blocking — don't fail fulfillment)
    this.runFraudChecks(payload).catch((err) =>
      log.warn('Fraud check error (non-fatal)', { detail: err }),
    );
  }

  // ── Subscription Renewed ─────────────────────────────────

  private async handleSubscriptionRenewed(
    payload: FulfillmentPayload,
    result: FulfillmentResult,
  ): Promise<void> {
    // Reactivate existing entitlement if it was in grace period
    if (payload.existing_entitlement_id) {
      const reactivated = await this.entitlementService.reactivate(payload.existing_entitlement_id);
      if (reactivated) {
        result.entitlementId = payload.existing_entitlement_id;
      } else {
        result.errors.push('Failed to reactivate entitlement');
      }
    }

    // Emit event
    this.eventBus.emit('subscription.activated', payload.guild_id, {
      discordId: payload.discord_id,
      productId: payload.product_id,
      planId: payload.plan_id ?? '',
      status: 'renewed',
    });
    result.eventEmitted = true;
  }

  // ── Subscription Cancelled ───────────────────────────────

  private async handleSubscriptionCancelled(
    payload: FulfillmentPayload,
    result: FulfillmentResult,
  ): Promise<void> {
    const entitlement = await this.findSubscriptionLifecycleEntitlement(payload);
    result.entitlementId = entitlement.id;

    // A completed retry must not repeat notifications. A live row still needs
    // the exact terminal transition; every already-terminal state is an
    // idempotent replay of cancellation/expiry and is safe to complete.
    if (['cancelled', 'expired', 'revoked'].includes(entitlement.status)) return;
    if (!['active', 'pending', 'grace_period', 'suspended'].includes(entitlement.status)) {
      throw new Error(`Subscription cancellation found unsupported status ${entitlement.status}`);
    }

    const revoked = await this.entitlementService.revoke(entitlement.id, 'cancelled');
    if (!revoked) {
      result.errors.push(`Failed to revoke entitlement ${entitlement.id}`);
      return;
    }

    // Emit event
    this.eventBus.emit('subscription.lapsed', payload.guild_id, {
      discordId: payload.discord_id,
      productId: payload.product_id,
      planId: payload.plan_id ?? '',
      status: 'cancelled',
    });
    result.eventEmitted = true;

    // DM the user about cancellation
    try {
      const user = await this.guild.client.users.fetch(payload.discord_id);
      await user.send({
        content: `Your subscription to **${payload.product_name}** has been cancelled. If this was a mistake, you can re-subscribe in the server store.`,
      });
    } catch {
      // DMs may be disabled — non-fatal
    }
  }

  // ── Subscription Suspended ───────────────────────────────

  private async handleSubscriptionSuspended(
    payload: FulfillmentPayload,
    result: FulfillmentResult,
  ): Promise<void> {
    const entitlement = await this.findSubscriptionLifecycleEntitlement(payload);
    result.entitlementId = entitlement.id;

    // A repeated failure event while already in grace must not extend the
    // deadline or repeat owner/customer notifications. A late failure after a
    // terminal transition is also a safe no-op and can never reactivate access.
    if (
      entitlement.status === 'grace_period'
      || entitlement.status === 'suspended'
      || ['cancelled', 'expired', 'revoked'].includes(entitlement.status)
    ) {
      return;
    }
    if (entitlement.status !== 'active') {
      throw new Error(`Subscription suspension found unsupported status ${entitlement.status}`);
    }

    // Read configurable grace period (guild_config.grace_period_days, default
    // DEFAULT_GRACE_PERIOD_DAYS if unset) via the shared helper that the
    // dashboard's manual grace transition also uses — one source of truth.
    const graceDays = await getGracePeriodDays(this.supabase, payload.guild_id);

    const suspended = await this.entitlementService.suspend(entitlement.id, graceDays);
    if (!suspended) {
      result.errors.push(`Failed to suspend entitlement ${entitlement.id}`);
      return;
    }

    // Emit subscription lapsed event
    this.eventBus.emit('subscription.lapsed', payload.guild_id, {
      discordId: payload.discord_id,
      productId: payload.product_id,
      planId: payload.plan_id ?? '',
      status: 'lapsed',
    });

    // Emit payment.failed so owner gets notified
    this.eventBus.emit('payment.failed', payload.guild_id, {
      discordId: payload.discord_id,
      orderId: payload.order_id,
      productName: payload.product_name,
      amount: payload.amount_cents,
      currency: payload.currency,
    });
    result.eventEmitted = true;

    // Check for payment pattern fraud (non-blocking)
    const fraudCtx = { supabase: this.supabase, guildId: payload.guild_id, eventBus: this.eventBus };
    checkPaymentPattern(fraudCtx, payload.customer_id, payload.discord_id).catch((err) =>
      log.warn('Fraud check error (non-fatal)', { detail: err }),
    );
    checkCriticalThreshold(fraudCtx).catch((err) =>
      log.warn('Critical threshold check error (non-fatal)', { detail: err }),
    );

    // DM warning
    try {
      const user = await this.guild.client.users.fetch(payload.discord_id);
      await user.send({
        content: `⚠️ Your payment for **${payload.product_name}** failed. You have a *${graceDays}-day grace period* before your access is revoked. Please update your payment method on PayPal.`,
      });
    } catch {
      // DMs may be disabled — non-fatal
    }
  }

  // ── Fraud Checks ──────────────────────────────────────────
  // Non-blocking checks run after successful fulfillment.
  // These feed the fraud_signals table and can trigger incidents / owner DMs.

  private async runFraudChecks(payload: FulfillmentPayload): Promise<void> {
    const ctx = { supabase: this.supabase, guildId: payload.guild_id, eventBus: this.eventBus };
    await checkPurchaseVelocity(ctx, payload.customer_id, payload.discord_id);
    await checkCriticalThreshold(ctx);
  }

  // ── Receipt DM ───────────────────────────────────────────

  /**
   * Deliver the receipt/license-key DM. Failures are never dropped silently:
   * the delivery is re-queued through `bot_action_queue` for persistent retry
   * (see handleDeliverReceipt in action-queue.ts for backoff, permanent-vs-
   * transient classification, and dead-letter + alert on final failure).
   *
   * A delivery failure intentionally does NOT fail the fulfillment itself —
   * the entitlement is already granted, and retrying the whole fulfillment
   * action would double-grant it. Only the delivery is retried.
   */
  private async sendReceipt(payload: FulfillmentPayload, result: FulfillmentResult): Promise<void> {
    // Fulfillment runs immediately after payment, so "now" is the order
    // date. Captured once so a queued redelivery renders the same date the
    // initial DM would have shown, not the date the retry succeeded.
    const orderDate = new Date();
    try {
      const user = await this.guild.client.users.fetch(payload.discord_id);
      await deliverReceiptDM(user, {
        orderNumber: payload.order_number,
        productName: payload.product_name,
        amountCents: payload.amount_cents,
        currency: payload.currency,
        licenseKey: payload.license_key_plaintext ?? null,
        date: orderDate,
      });
      result.receiptSent = true;
    } catch (err) {
      const redacted = payload.discord_id ? `***${payload.discord_id.slice(-4)}` : 'unknown';
      log.error('Failed to send receipt', { user: redacted, detail: err });
      result.receiptSent = false;
      result.receiptRetryQueued = await this.queueReceiptRedelivery(payload, err, orderDate);
    }
  }

  /**
   * Queue a persistent re-delivery of the receipt DM via `bot_action_queue`.
   *
   * The queue row is the only at-rest copy of the plaintext license key
   * (`license_keys` stores hash/prefix/suffix only), so the insert itself is
   * retried with a short backoff. If it still fails, the delivery payload is
   * preserved in `action_queue_dlq` — dashboard-visible and manually
   * retryable via the existing DLQ retry flow, and the same table/shape the
   * queue's own final-failure path writes, so this adds no new exposure
   * surface — and an operator alert is written. The alert itself never
   * contains the key.
   */
  private async queueReceiptRedelivery(
    payload: FulfillmentPayload,
    deliveryError: unknown,
    orderDate: Date,
  ): Promise<boolean> {
    const deliveryPayload: ReceiptDeliveryPayload = {
      guild_id: payload.guild_id,
      discord_id: payload.discord_id,
      order_id: payload.order_id,
      order_number: payload.order_number,
      product_name: payload.product_name,
      amount_cents: payload.amount_cents,
      currency: payload.currency,
      license_key_plaintext: payload.license_key_plaintext,
      order_date: orderDate.toISOString(),
    };

    let lastQueueError: unknown;
    for (let attempt = 1; attempt <= QUEUE_INSERT_MAX_ATTEMPTS; attempt++) {
      try {
        const { error } = await this.supabase.from('bot_action_queue').insert({
          guild_id: payload.guild_id,
          action: RECEIPT_DELIVERY_ACTION,
          payload: deliveryPayload,
          status: 'pending',
        });
        if (error) throw new Error(error.message);
        log.info('Queued receipt re-delivery', { order: payload.order_number });
        return true;
      } catch (queueErr) {
        lastQueueError = queueErr;
        log.warn('Receipt re-delivery queue insert failed', {
          order: payload.order_number,
          attempt,
          detail: queueErr,
        });
        if (attempt < QUEUE_INSERT_MAX_ATTEMPTS) {
          await sleep(QUEUE_INSERT_BACKOFF_MS[attempt - 1] ?? 2_000);
        }
      }
    }

    log.error('Failed to queue receipt re-delivery', {
      order: payload.order_number,
      detail: lastQueueError,
    });

    // Preserve the full delivery payload (including the plaintext key) in
    // the dead-letter queue so the operator can retry the delivery from the
    // dashboard instead of the key being unrecoverable.
    let payloadPreserved = false;
    try {
      const queueMsg =
        lastQueueError instanceof Error ? lastQueueError.message : String(lastQueueError);
      const { error } = await this.supabase.from('action_queue_dlq').insert({
        guild_id: payload.guild_id,
        action: RECEIPT_DELIVERY_ACTION,
        payload: deliveryPayload,
        error_message:
          `Failed to queue receipt re-delivery after ${QUEUE_INSERT_MAX_ATTEMPTS} attempts: ${queueMsg}`,
        retry_count: 0,
        max_retries: 0,
      });
      if (error) throw new Error(error.message);
      payloadPreserved = true;
      log.info('Dead-lettered receipt re-delivery payload', { order: payload.order_number });
    } catch (dlqErr) {
      // Last resort is the alert below: it references the order, and the
      // hashed key for that order can still be manually revoked + reissued.
      log.error('Failed to dead-letter receipt re-delivery', {
        order: payload.order_number,
        detail: dlqErr,
      });
    }

    await writeReceiptDeliveryAlert(this.supabase, {
      guildId: payload.guild_id,
      orderNumber: payload.order_number,
      productName: payload.product_name,
      discordId: payload.discord_id,
      kind: classifyDeliveryError(deliveryError),
      attempts: 1,
      lastError: deliveryError instanceof Error ? deliveryError.message : String(deliveryError),
      payloadPreserved,
    });
    return false;
  }

  // ── Audit ────────────────────────────────────────────────

  private async auditLog(
    payload: FulfillmentPayload,
    result: FulfillmentResult,
  ): Promise<void> {
    try {
      await this.supabase.from('audit_logs').insert({
        guild_id: payload.guild_id,
        actor_type: 'system',
        actor_id: 'commerce-fulfillment',
        action: `fulfillment.${payload.fulfillment_type}`,
        target_type: 'order',
        target_id: payload.order_id,
        details: {
          discordId: payload.discord_id,
          productId: payload.product_id,
          productName: payload.product_name,
          orderNumber: payload.order_number,
          amountCents: payload.amount_cents,
          entitlementId: result.entitlementId,
          receiptSent: result.receiptSent,
          receiptRetryQueued: result.receiptRetryQueued,
          eventEmitted: result.eventEmitted,
          success: result.success,
          errors: result.errors,
        },
      });
    } catch {
      // Non-fatal — don't let audit failure break fulfillment
    }
  }
}
