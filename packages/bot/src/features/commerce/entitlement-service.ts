/**
 * Entitlement Service — Grant, revoke, and manage product entitlements.
 *
 * Handles the lifecycle: PENDING → ACTIVE → EXPIRED/CANCELLED/SUSPENDED/REVOKED
 * Grants/revokes Discord roles on status changes.
 */
import type { Guild, GuildMember } from 'discord.js';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { PlatformEventBus } from '../../services/event-bus.js';
import { raiseOwnerAlert, resolveOwnerAlert } from '../../services/alert-service.js';
import { createLogger } from '@somnibot/shared';
import { recordRoleDeliveryOutcome } from './role-delivery-audit.js';

const log = createLogger('Entitlement');

export interface EntitlementGrantOptions {
  customerId: string;
  productId: string;
  productName: string;
  orderId: string;
  licenseKeyId?: string;
  planId?: string;
  discordId: string;
  type: 'one_time' | 'subscription';
  source: 'purchase';
  grantedRoleIds: string[];
  grantedChannelIds: string[];
  expiresAt?: string | null;
  roleDeliveryClaim?: RoleDeliveryActionClaim;
}

export interface PurchaseRoleDeliveryContract {
  customerId: string;
  productId: string;
  orderId: string;
  planId: string | null;
  discordId: string;
  grantedRoleIds: string[];
  entitlementType: 'one_time' | 'subscription';
}

export interface NonCommerceRoleDeliveryContract {
  customerId: string;
  productId: string;
  orderId: string | null;
  planId: string | null;
  discordId: string;
  grantedRoleIds: string[];
  entitlementType: 'one_time' | 'subscription';
  entitlementSource: 'manual' | 'giveaway' | 'automation';
  activationGeneration: string;
}

export interface SubscriptionReactivationContract extends PurchaseRoleDeliveryContract {
  planId: string;
  entitlementType: 'subscription';
  expiresAt: string;
  grantedChannelIds: string[];
}

export type PurchaseRoleReconciliationOutcome = 'live' | 'terminal';

export interface RoleDeliveryActionClaim {
  actionId: string;
  claimToken: string;
}

export interface SubscriptionFulfillmentClaim extends RoleDeliveryActionClaim {
  orderId: string;
  orderNumber: string;
  customerId: string;
  discordId: string;
  productId: string;
  productName: string;
  planId: string;
  paypalSubscriptionId: string;
  amountCents: number;
  currency: string;
  expectedStatus: EntitlementLifecycleStatus;
  expectedUpdatedAt: string | null;
}

export type SubscriptionPaymentFailureFulfillmentResult =
  | {
    disposition: 'applied' | 'replay';
    outwardGenerationId: string;
    gracePeriodEndsAt: string;
  }
  | {
    disposition: 'noop';
    outwardGenerationId: null;
    gracePeriodEndsAt: string | null;
  }
  | {
    disposition: 'stale' | 'not_found' | 'failed';
    outwardGenerationId: null;
    gracePeriodEndsAt: null;
  };

export type EntitlementLifecycleStatus =
  | 'active'
  | 'pending'
  | 'grace_period'
  | 'suspended'
  | 'expired'
  | 'cancelled';

export type EntitlementRevokeResult =
  | {
    disposition: 'applied';
    transitionId: string;
    status: 'expired' | 'cancelled' | 'suspended';
    outwardGenerationId?: string | null;
  }
  | {
    disposition: 'noop';
    transitionId: null;
    status: 'expired' | 'cancelled' | 'suspended';
    outwardGenerationId?: string | null;
  }
  | {
    disposition: 'stale';
    transitionId: null;
    status: 'active' | 'pending' | 'grace_period' | 'suspended';
    outwardGenerationId?: null;
  }
  | {
    disposition: 'not_found' | 'failed';
    transitionId: null;
    status: null;
    outwardGenerationId?: null;
  };

export interface PurchaseRoleDeliveryAttempt extends RoleDeliveryActionClaim {
  intentId: string;
  mutationToken: string;
  /** Present for paid delivery intents; omitted by non-commerce role carriers. */
  outwardGenerationId?: string;
}

type RoleDeliveryAttachmentDisposition =
  | 'reserve_add'
  | 'reserve_inherited'
  | 'reserved_replay'
  | 'owned_replay'
  | 'manual_baseline'
  | 'dependency_pending'
  | 'terminal'
  | 'operator_held';

type RoleDeliveryAttachment = {
  intentState: 'open' | 'cleanup_required' | 'operator_required';
  mayMutate: boolean;
  ownsRemoval: boolean;
  claimNewlyAcquired: boolean;
  disposition: RoleDeliveryAttachmentDisposition;
};

type RoleDeliveryPromotion = {
  intentState: 'open' | 'operator_required';
  promoted: boolean;
  ownsRemoval: boolean;
};

type RoleDeliveryBaselineConfirmation = {
  intentState: 'open';
  confirmed: boolean;
  disposition:
    | 'manual_baseline'
    | 'baseline_replay'
    | 'contract_changed'
    | 'dependency_pending'
    | 'owner_changed';
};

export interface PurchaseRoleCleanupContract {
  intentId: string;
  entitlementId: string;
  customerId: string;
  discordId: string;
  ownedRoleIds: string[];
  temporaryRoleGrantIds: string[];
}

type RoleOwnerExclusions = {
  intentId?: string | null;
  entitlementId?: string | null;
  temporaryRoleGrantIds?: string[];
};

type LiveRoleOwnerState = 'confirmed' | 'pending' | 'none';

export type PurchaseRoleDeliveryDisposition =
  | 'confirmed_open'
  | 'settled'
  | 'safe_retry'
  | 'safe_retry_owned'
  | 'run_origin_cleanup'
  | 'operator_held';

export type PurchaseRoleDeliveryBeginResult =
  | { state: 'live'; attempt: PurchaseRoleDeliveryAttempt }
  | { state: 'confirmed_live'; intentId: string; outwardGenerationId: string | null }
  | { state: 'terminal'; intentId: string; cleanupNeeded: boolean };

export type NonCommerceRoleDeliveryBeginResult =
  | { state: 'live'; attempt: PurchaseRoleDeliveryAttempt }
  | { state: 'confirmed_live'; intentId: string }
  | { state: 'terminal'; intentId: string; cleanupNeeded: boolean }
  | { state: 'superseded' }
  | { state: 'unproven' }
  | { state: 'operator_held'; intentId: string };

class PurchaseDeliveryTerminalFenceError extends Error {
  constructor(readonly cleanupHandled = false) {
    super('Purchase role delivery lost its exact live mutation fence');
  }
}

class PurchaseDeliveryMutationUncertainError extends Error {
  constructor(roleId: string, detail: unknown) {
    super(
      `Purchased role ${roleId} add result is uncertain; durable ownership requires operator recovery: ${
        detail instanceof Error ? detail.message : String(detail)
      }`,
    );
  }
}

export class PurchaseRoleDeliveryTerminalNoopError extends Error {
  constructor(readonly entitlementId: string | null) {
    super(
      entitlementId
        ? `Purchase entitlement ${entitlementId} is terminal; delivery was safely skipped`
        : 'Purchase order is terminal before entitlement delivery; delivery was safely skipped',
    );
  }
}

function normalizeExactRoleVector(value: unknown, label: string): string[] {
  if (
    !Array.isArray(value)
    || value.some((roleId) =>
      typeof roleId !== 'string'
      || roleId.length === 0
      || roleId.trim() !== roleId)
  ) {
    throw new Error(`${label} is malformed`);
  }
  const unique = new Set(value as string[]);
  if (unique.size !== value.length) {
    throw new Error(`${label} contains duplicate roles`);
  }
  return [...unique].sort((left, right) => left.localeCompare(right));
}

function exactRoleVectorsMatch(left: unknown, right: string[]): boolean {
  try {
    const normalized = normalizeExactRoleVector(left, 'Stored granted role vector');
    return normalized.length === right.length
      && normalized.every((roleId, index) => roleId === right[index]);
  } catch {
    return false;
  }
}

function firstRpcRow(value: unknown): Record<string, unknown> | null {
  if (Array.isArray(value) && value.length !== 1) return null;
  const candidate = Array.isArray(value) ? value[0] : value;
  return candidate && typeof candidate === 'object' && !Array.isArray(candidate)
    ? candidate as Record<string, unknown>
    : null;
}

export class EntitlementService {
  private activePurchaseRoleDeliveryAttempt: PurchaseRoleDeliveryAttempt | null = null;
  private confirmedPurchaseRoleDeliveryReplay = false;
  private purchaseRoleDeliveryOutwardGeneration: string | null = null;

  constructor(
    private guild: Guild,
    private supabase: SupabaseClient,
    _eventBus: PlatformEventBus,
  ) {}

  /**
   * Grant a new entitlement — creates DB record and adds Discord roles.
   */
  async grant(opts: EntitlementGrantOptions): Promise<string | null> {
    const guildId = this.guild.id;

    // Non-purchase producers must use commerce_create_noncommerce_entitlement.
    // That RPC creates the $0 provenance order, entitlement, and activation
    // carrier atomically; this paid worker path cannot safely synthesize them.
    if ((opts as { source?: unknown }).source !== 'purchase') {
      throw new Error('Non-purchase entitlement grant requires the atomic non-commerce RPC');
    }
    if (!opts.roleDeliveryClaim) {
      throw new Error('Paid entitlement grant requires an exact action claim');
    }

    let entitlement: { id: string } | null = null;
    if (opts.type === 'subscription') {
      if (
        typeof opts.planId !== 'string'
        || !Number.isFinite(Date.parse(opts.expiresAt ?? ''))
      ) {
        throw new Error('Subscription entitlement requires exact lifecycle expiry');
      }
      const { data, error } = await (
        this.supabase.rpc as (
          fn: string,
          params: Record<string, unknown>,
        ) => ReturnType<typeof this.supabase.rpc>
      )('commerce_apply_subscription_entitlement_lifecycle', {
        p_action_id: opts.roleDeliveryClaim.actionId,
        p_claim_token: opts.roleDeliveryClaim.claimToken,
        p_entitlement_id: null,
        p_guild_id: guildId,
        p_customer_id: opts.customerId,
        p_discord_id: opts.discordId,
        p_product_id: opts.productId,
        p_order_id: opts.orderId,
        p_plan_id: opts.planId,
        p_license_key_id: opts.licenseKeyId ?? null,
        p_granted_role_ids: opts.grantedRoleIds,
        p_granted_channel_ids: opts.grantedChannelIds,
        p_expires_at: opts.expiresAt,
      });
      if (error) {
        throw new Error(
          `Failed to bind subscription entitlement lifecycle: ${error.message}`,
        );
      }
      const row = firstRpcRow(data);
      if (
        !row
        || !['created', 'replay', 'superseded'].includes(
          String(row.disposition),
        )
        || (
          row.entitlement_id !== null
          && (
            typeof row.entitlement_id !== 'string'
            || row.entitlement_id.length === 0
          )
        )
      ) {
        throw new Error('Subscription entitlement lifecycle returned malformed evidence');
      }
      if (row.disposition === 'superseded') {
        throw new PurchaseRoleDeliveryTerminalNoopError(
          row.entitlement_id as string | null,
        );
      }
      if (
        typeof row.entitlement_id !== 'string'
        || row.status !== 'active'
        || Date.parse(String(row.expires_at)) !== Date.parse(opts.expiresAt as string)
      ) {
        throw new Error('Subscription entitlement lifecycle returned mismatched access');
      }
      entitlement = { id: row.entitlement_id };
    } else {
      const { data, error } = await this.supabase
        .from('entitlements')
        .insert({
          customer_id: opts.customerId,
          guild_id: guildId,
          product_id: opts.productId,
          plan_id: opts.planId ?? null,
          license_key_id: opts.licenseKeyId ?? null,
          order_id: opts.orderId,
          type: opts.type,
          status: 'active',
          source: opts.source,
          granted_role_ids: opts.grantedRoleIds,
          granted_channel_ids: opts.grantedChannelIds,
          starts_at: new Date().toISOString(),
          expires_at: opts.expiresAt ?? null,
        })
        .select('id')
        .single();
      if (error || !data) {
        log.error('Failed to create entitlement:', error?.message);
        return null;
      }
      entitlement = data;
    }

    const contract: PurchaseRoleDeliveryContract = {
      customerId: opts.customerId,
      productId: opts.productId,
      orderId: opts.orderId,
      planId: opts.planId ?? null,
      discordId: opts.discordId,
      grantedRoleIds: opts.grantedRoleIds,
      entitlementType: opts.type,
    };
    let attempt: PurchaseRoleDeliveryAttempt | undefined;
    const begun = await this.beginPurchaseRoleDeliveryAttempt(
      entitlement.id,
      contract,
      opts.roleDeliveryClaim,
    );
    if (begun.state === 'terminal') {
      if (begun.cleanupNeeded) {
        await this.executeOwnedPurchaseRoleCleanup(
          begun.intentId,
          opts.roleDeliveryClaim,
        );
      }
      throw new PurchaseRoleDeliveryTerminalNoopError(entitlement.id);
    }
    if (begun.state === 'confirmed_live') {
      attempt = undefined;
    } else {
      attempt = begun.attempt;
    }
    if (attempt) {
      const outcome = await this.reconcilePurchaseGrantedRoles(
        entitlement.id,
        contract,
        attempt,
      );
      if (outcome === 'terminal') {
        if (this.activePurchaseRoleDeliveryAttempt?.intentId === attempt.intentId) {
          const finalized = await this.finishPurchaseRoleDeliveryAttempt(
            attempt,
            'compensated',
          );
          if (!finalized.settled || !finalized.authorityEmpty) {
            throw new Error('Terminal paid role grant compensation did not settle');
          }
        }
        throw new PurchaseRoleDeliveryTerminalNoopError(entitlement.id);
      }
    }

    // This transition writes its authoritative audit directly below. Do not
    // also emit entitlement.granted: AuditService consumes that event into a
    // second audit row, while no supported automation consumes it.
    await this.supabase.from('audit_logs').insert({
      guild_id: guildId,
      actor_type: 'system',
      actor_id: 'commerce',
      action: 'entitlement.granted',
      target_type: 'entitlement',
      target_id: entitlement.id,
      details: {
        discordId: opts.discordId,
        productId: opts.productId,
        source: opts.source,
        roleIds: opts.grantedRoleIds,
      },
    });

    log.info(`Entitlement granted: ${entitlement.id} for ${opts.discordId}`);
    return entitlement.id;
  }

  /**
   * Revoke an entitlement — updates status and removes Discord roles.
   */
  async revoke(
    entitlementId: string,
    reason: 'expired' | 'cancelled' | 'refund' | 'suspended',
    fulfillmentClaim?: SubscriptionFulfillmentClaim,
  ): Promise<EntitlementRevokeResult> {
    const guildId = this.guild.id;

    // Observe the exact optimistic-concurrency token. The database RPC locks
    // this guild-scoped row and accepts the transition only while both fields
    // still match; updated_at is maintained by the table trigger.
    const { data: ent, error: entitlementError } = await this.supabase
      .from('entitlements')
      .select('id, guild_id, status, updated_at')
      .eq('id', entitlementId)
      .eq('guild_id', guildId)
      .maybeSingle();

    if (entitlementError) {
      log.error('Failed to load entitlement for revocation:', entitlementError.message);
      return { disposition: 'failed', transitionId: null, status: null };
    }
    if (!ent) {
      log.error('Entitlement not found:', entitlementId);
      return { disposition: 'not_found', transitionId: null, status: null };
    }

    const statuses: EntitlementLifecycleStatus[] = [
      'active', 'pending', 'grace_period', 'suspended', 'expired', 'cancelled',
    ];
    if (
      ent.id !== entitlementId
      || ent.guild_id !== guildId
      || typeof ent.status !== 'string'
      || !statuses.includes(ent.status as EntitlementLifecycleStatus)
      || (ent.updated_at !== null && typeof ent.updated_at !== 'string')
    ) {
      log.error('Entitlement revocation observation was malformed:', entitlementId);
      return { disposition: 'failed', transitionId: null, status: null };
    }

    if (
      fulfillmentClaim
      && (
        !['cancelled', 'suspended'].includes(reason)
        || fulfillmentClaim.orderId.length === 0
        || fulfillmentClaim.orderNumber.length === 0
        || fulfillmentClaim.customerId.length === 0
        || fulfillmentClaim.discordId.length === 0
        || fulfillmentClaim.productId.length === 0
        || fulfillmentClaim.productName.length === 0
        || fulfillmentClaim.planId.length === 0
        || fulfillmentClaim.paypalSubscriptionId.length === 0
        || !Number.isSafeInteger(fulfillmentClaim.amountCents)
        || fulfillmentClaim.amountCents < 0
        || fulfillmentClaim.currency.length === 0
        || fulfillmentClaim.actionId.length === 0
        || fulfillmentClaim.claimToken.length === 0
        || fulfillmentClaim.expectedStatus !== ent.status
        || fulfillmentClaim.expectedUpdatedAt !== (ent.updated_at ?? null)
      )
    ) {
      log.error('Subscription lifecycle claim does not match the observed entitlement');
      return { disposition: 'failed', transitionId: null, status: null };
    }

    const { data, error } = await (
      this.supabase.rpc as (
        fn: string,
        params: Record<string, unknown>,
      ) => ReturnType<typeof this.supabase.rpc>
    )(
      fulfillmentClaim
        ? 'commerce_revoke_subscription_fulfillment'
        : 'commerce_revoke_entitlement_exact',
      fulfillmentClaim
        ? {
          p_action_id: fulfillmentClaim.actionId,
          p_claim_token: fulfillmentClaim.claimToken,
          p_entitlement_id: entitlementId,
          p_guild_id: guildId,
          p_order_id: fulfillmentClaim.orderId,
          p_customer_id: fulfillmentClaim.customerId,
          p_discord_id: fulfillmentClaim.discordId,
          p_product_id: fulfillmentClaim.productId,
          p_plan_id: fulfillmentClaim.planId,
          p_paypal_subscription_id: fulfillmentClaim.paypalSubscriptionId,
          p_fulfillment_type: reason === 'cancelled'
            ? 'subscription_cancelled'
            : 'subscription_suspended',
          p_expected_status: ent.status,
          p_expected_updated_at: ent.updated_at,
        }
        : {
          p_entitlement_id: entitlementId,
          p_guild_id: guildId,
          p_expected_status: ent.status,
          p_expected_updated_at: ent.updated_at,
          p_reason: reason,
        },
    );

    if (error) {
      log.error('Failed to revoke entitlement:', error.message);
      return { disposition: 'failed', transitionId: null, status: null };
    }

    const row = firstRpcRow(data);
    if (!row || typeof row.disposition !== 'string') {
      log.error('Entitlement revocation returned malformed transition evidence');
      return { disposition: 'failed', transitionId: null, status: null };
    }

    const outwardGenerationId = row.outward_generation_id;
    if (
      fulfillmentClaim
      && outwardGenerationId !== null
      && (
        typeof outwardGenerationId !== 'string'
        || outwardGenerationId.length === 0
        || outwardGenerationId.trim() !== outwardGenerationId
      )
    ) {
      log.error('Subscription lifecycle transition returned malformed outward generation');
      return { disposition: 'failed', transitionId: null, status: null };
    }
    const fulfillmentIdentityMatches = !fulfillmentClaim
      || (
        row.action_id === fulfillmentClaim.actionId
        && row.claim_token === fulfillmentClaim.claimToken
        && row.order_id === fulfillmentClaim.orderId
        && row.order_number === fulfillmentClaim.orderNumber
        && row.guild_id === guildId
        && row.customer_id === fulfillmentClaim.customerId
        && row.discord_id === fulfillmentClaim.discordId
        && row.product_id === fulfillmentClaim.productId
        && row.product_name === fulfillmentClaim.productName
        && row.plan_id === fulfillmentClaim.planId
        && row.paypal_subscription_id === fulfillmentClaim.paypalSubscriptionId
        && row.amount_cents === fulfillmentClaim.amountCents
        && row.currency === fulfillmentClaim.currency
      );
    if (!fulfillmentIdentityMatches) {
      log.error('Subscription lifecycle transition returned mismatched action evidence');
      return { disposition: 'failed', transitionId: null, status: null };
    }

    if (row.disposition === 'not_found') {
      if (row.transition_id !== null || row.entitlement_id !== null || row.status !== null) {
        log.error('Entitlement revocation returned mismatched not-found evidence');
        return { disposition: 'failed', transitionId: null, status: null };
      }
      return { disposition: 'not_found', transitionId: null, status: null };
    }

    const exactIdentity = row.entitlement_id === entitlementId && row.guild_id === guildId;
    if (row.disposition === 'noop') {
      if (
        !exactIdentity
        || row.transition_id !== null
        || !['expired', 'cancelled', 'suspended'].includes(String(row.status))
      ) {
        log.error('Entitlement revocation returned mismatched no-op evidence');
        return { disposition: 'failed', transitionId: null, status: null };
      }
      return {
        disposition: 'noop',
        transitionId: null,
        status: row.status as 'expired' | 'cancelled' | 'suspended',
        ...(fulfillmentClaim
          ? { outwardGenerationId: outwardGenerationId as string | null }
          : {}),
      };
    }

    if (row.disposition === 'stale') {
      if (
        !exactIdentity
        || row.transition_id !== null
        || !['active', 'pending', 'grace_period', 'suspended'].includes(String(row.status))
      ) {
        log.error('Entitlement revocation returned mismatched stale-state evidence');
        return { disposition: 'failed', transitionId: null, status: null };
      }
      return {
        disposition: 'stale',
        transitionId: null,
        status: row.status as 'active' | 'pending' | 'grace_period' | 'suspended',
        ...(fulfillmentClaim ? { outwardGenerationId: null } : {}),
      };
    }

    const expectedStatus = reason === 'cancelled'
      ? 'cancelled'
      : reason === 'suspended'
        ? 'suspended'
        : 'expired';
    const appliedContractMatches = fulfillmentClaim
      ? fulfillmentIdentityMatches
      : (
        typeof row.discord_id === 'string'
        && row.discord_id.length > 0
        && typeof row.product_id === 'string'
        && row.product_id.length > 0
        && typeof row.product_name === 'string'
        && Array.isArray(row.role_ids)
        && row.role_ids.every(
          (roleId) => typeof roleId === 'string' && roleId.length > 0,
        )
      );
    if (
      row.disposition !== 'applied'
      || !exactIdentity
      || typeof row.transition_id !== 'string'
      || row.transition_id.length === 0
      || row.status !== expectedStatus
      || !appliedContractMatches
      || typeof row.updated_at !== 'string'
      || (fulfillmentClaim && typeof outwardGenerationId !== 'string')
    ) {
      log.error('Entitlement revocation returned mismatched applied evidence');
      return { disposition: 'failed', transitionId: null, status: null };
    }

    // The RPC has already committed the status transition, durable role
    // cleanup carrier, license-session shutdown, grace-alert resolution, and
    // lifecycle audit under this transition UUID. Do not emit the legacy
    // entitlement.revoked audit event as well: AuditService would persist a
    // second row and there is no supported non-audit consumer for that event.

    log.info(`Entitlement revoked: ${entitlementId} (${reason})`);
    return {
      disposition: 'applied',
      transitionId: row.transition_id,
      status: expectedStatus,
      ...(fulfillmentClaim
        ? { outwardGenerationId: outwardGenerationId as string }
        : {}),
    };
  }

  /**
   * Suspend an entitlement (payment failure → grace period).
   *
   * The transition is guarded on `status = 'active'` so a replayed or late
   * suspension webhook can never pull an expired/cancelled entitlement back
   * into grace_period, and an entitlement already in grace cannot have its
   * window silently extended. Entering grace also raises a deduped
   * operator alert (a paying customer's access is decaying — this is churn
   * signal, not routine noise) and writes an audit trail entry.
   */
  async suspend(entitlementId: string, gracePeriodDays: number = 3): Promise<boolean> {
    const guildId = this.guild.id;
    const gracePeriodEnds = new Date();
    gracePeriodEnds.setDate(gracePeriodEnds.getDate() + gracePeriodDays);

    const { data: suspended, error } = await this.supabase
      .from('entitlements')
      .update({
        status: 'grace_period',
        grace_period_ends_at: gracePeriodEnds.toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', entitlementId)
      .eq('guild_id', guildId)
      .eq('status', 'active')
      .select('id, customer_id, product_id, order_id');

    if (error) {
      log.error('Failed to suspend entitlement:', error.message);
      return false;
    }
    if (!suspended || suspended.length === 0) {
      log.warn(`Suspend skipped — entitlement not active: ${entitlementId}`);
      return false;
    }
    const ent = suspended[0];

    // Operator alert — deduped atomically at the DB by the partial unique
    // index uniq_alerts_unresolved_entitlement_grace (one unresolved alert
    // per entitlement): a 23505 unique violation means another writer
    // already raised it, which is dedupe success, not an error. Alert
    // failure never fails the suspension itself — the transition committed.
    const alertMessage =
      `Entitlement ${entitlementId} entered a payment-failure grace period ending ` +
      `${gracePeriodEnds.toISOString()}. If payment is not recovered by then, ` +
      'access will be revoked automatically.';
    const alertMetadata = {
      entitlement_id: entitlementId,
      customer_id: ent.customer_id,
      product_id: ent.product_id,
      order_id: ent.order_id,
      grace_period_ends_at: gracePeriodEnds.toISOString(),
      source: 'entitlement_service.suspend',
    };
    const alertResult = await raiseOwnerAlert(this.supabase, guildId, {
      alertType: 'entitlement_grace_period',
      severity: 'warning',
      title: 'Paid entitlement entered payment grace period',
      message: alertMessage,
      metadata: alertMetadata,
      guild: this.guild,
    });
    if (alertResult.insertErrorCode === '23505') {
      // Codex W2: a stale unresolved alert already occupies the unique slot for
      // this entitlement (e.g. a prior recovery's resolve failed non-fatally,
      // then this suspension re-entered grace). The UPDATE above just committed
      // a NEW grace_period_ends_at, so that pre-existing alert now carries the
      // OLD deadline in its message/metadata. Refresh it in place — same
      // entitlement-scoped, unresolved-only filter the manual admin path uses —
      // so operators see the current revocation time. Non-fatal.
      const { error: refreshError } = await this.supabase
        .from('alerts')
        .update({
          message: alertMessage,
          metadata: alertMetadata,
          severity: 'warning',
          updated_at: new Date().toISOString(),
        })
        .eq('guild_id', guildId)
        .eq('alert_type', 'entitlement_grace_period')
        .eq('metadata->>entitlement_id', entitlementId)
        .eq('resolved', false);
      if (refreshError) {
        log.error('Failed to refresh duplicate grace-period alert:', refreshError.message);
      }
    }

    // Audit trail — lifecycle transitions on paid entitlements must be traceable.
    const { error: auditError } = await this.supabase.from('audit_logs').insert({
      guild_id: guildId,
      actor_type: 'system',
      actor_id: 'commerce',
      action: 'entitlement.grace_period_started',
      target_type: 'entitlement',
      target_id: entitlementId,
      details: {
        customer_id: ent.customer_id,
        product_id: ent.product_id,
        order_id: ent.order_id,
        grace_period_days: gracePeriodDays,
        grace_period_ends_at: gracePeriodEnds.toISOString(),
      },
    });
    if (auditError) {
      log.error('Failed to write grace-period audit log:', auditError.message);
    }

    log.info(`Entitlement suspended (grace until ${gracePeriodEnds.toISOString()}): ${entitlementId}`);
    return true;
  }

  /**
   * Atomically win or recover one queued subscription-suspension episode.
   *
   * The database binds the outward generation only to the exact current action
   * claim that won the active -> grace transition. A different action seeing
   * the target state receives no generation and therefore emits nothing.
   */
  async startPaymentFailureGraceForFulfillment(
    entitlementId: string,
    gracePeriodDays: number,
    claim: SubscriptionFulfillmentClaim,
  ): Promise<SubscriptionPaymentFailureFulfillmentResult> {
    if (
      !Number.isSafeInteger(gracePeriodDays)
      || gracePeriodDays < 0
      || [
        entitlementId,
        claim.actionId,
        claim.claimToken,
        claim.orderId,
        claim.orderNumber,
        claim.customerId,
        claim.discordId,
        claim.productId,
        claim.productName,
        claim.planId,
        claim.paypalSubscriptionId,
        claim.currency,
      ].some((value) => value.length === 0 || value.trim() !== value)
      || !Number.isSafeInteger(claim.amountCents)
      || claim.amountCents < 0
    ) {
      return {
        disposition: 'failed',
        outwardGenerationId: null,
        gracePeriodEndsAt: null,
      };
    }

    const { data, error } = await (
      this.supabase.rpc as (
        fn: string,
        params: Record<string, unknown>,
      ) => ReturnType<typeof this.supabase.rpc>
    )('commerce_start_payment_failure_grace_fulfillment', {
      p_action_id: claim.actionId,
      p_claim_token: claim.claimToken,
      p_entitlement_id: entitlementId,
      p_guild_id: this.guild.id,
      p_order_id: claim.orderId,
      p_customer_id: claim.customerId,
      p_discord_id: claim.discordId,
      p_product_id: claim.productId,
      p_plan_id: claim.planId,
      p_paypal_subscription_id: claim.paypalSubscriptionId,
      p_expected_status: claim.expectedStatus,
      p_expected_updated_at: claim.expectedUpdatedAt,
      p_grace_period_days: gracePeriodDays,
    });
    if (error) {
      log.error('Failed to start payment-failure grace for fulfillment:', error.message);
      return {
        disposition: 'failed',
        outwardGenerationId: null,
        gracePeriodEndsAt: null,
      };
    }
    const row = firstRpcRow(data);
    const validDisposition =
      row
      && typeof row.disposition === 'string'
      && ['applied', 'replay', 'noop', 'stale', 'not_found'].includes(row.disposition);
    const exactContract =
      row
      && row.action_id === claim.actionId
      && row.claim_token === claim.claimToken
      && row.guild_id === this.guild.id
      && row.order_id === claim.orderId
      && row.order_number === claim.orderNumber
      && row.customer_id === claim.customerId
      && row.discord_id === claim.discordId
      && row.product_id === claim.productId
      && row.product_name === claim.productName
      && row.plan_id === claim.planId
      && row.paypal_subscription_id === claim.paypalSubscriptionId
      && row.amount_cents === claim.amountCents
      && row.currency === claim.currency;
    if (
      !validDisposition
      || !exactContract
      || (
        row.disposition === 'not_found'
          ? row.entitlement_id !== null
          : row.entitlement_id !== entitlementId
      )
    ) {
      log.error('Subscription payment failure returned malformed action evidence');
      return {
        disposition: 'failed',
        outwardGenerationId: null,
        gracePeriodEndsAt: null,
      };
    }

    if (row.disposition === 'applied' || row.disposition === 'replay') {
      if (
        row.status !== 'grace_period'
        || typeof row.updated_at !== 'string'
        || typeof row.outward_generation_id !== 'string'
        || row.outward_generation_id.length === 0
        || typeof row.grace_period_ends_at !== 'string'
        || !Number.isFinite(Date.parse(row.grace_period_ends_at))
      ) {
        log.error('Subscription payment failure winner returned malformed durable evidence');
        return {
          disposition: 'failed',
          outwardGenerationId: null,
          gracePeriodEndsAt: null,
        };
      }
      return {
        disposition: row.disposition,
        outwardGenerationId: row.outward_generation_id,
        gracePeriodEndsAt: row.grace_period_ends_at,
      };
    }

    const validOptionalGraceDeadline =
      row.grace_period_ends_at === null
      || (
        typeof row.grace_period_ends_at === 'string'
        && Number.isFinite(Date.parse(row.grace_period_ends_at))
      );
    const validLoserEnvelope =
      row.outward_generation_id === null
      && validOptionalGraceDeadline
      && (
        row.disposition === 'not_found'
          ? row.status === null
            && row.updated_at === null
            && row.grace_period_ends_at === null
          : typeof row.updated_at === 'string'
            && (
              row.disposition === 'noop'
                ? ['cancelled', 'expired', 'grace_period', 'suspended'].includes(
                  row.status as string,
                )
                : ['active', 'pending'].includes(row.status as string)
            )
      );
    if (!validLoserEnvelope) {
      log.error('Subscription payment failure loser returned malformed evidence');
      return {
        disposition: 'failed',
        outwardGenerationId: null,
        gracePeriodEndsAt: null,
      };
    }
    if (row.disposition === 'noop') {
      return {
        disposition: 'noop',
        outwardGenerationId: null,
        gracePeriodEndsAt: row.grace_period_ends_at as string | null,
      };
    }
    return {
      disposition: row.disposition as 'stale' | 'not_found',
      outwardGenerationId: null,
      gracePeriodEndsAt: null,
    };
  }

  /**
   * Recover a paid subscription from grace/suspension, or repair an exact
   * already-active replay. Every identity field is re-proved from storage;
   * terminal or unsupported states are never reactivated.
   */
  async reactivate(
    entitlementId: string,
    contract: SubscriptionReactivationContract,
    roleDeliveryClaim?: RoleDeliveryActionClaim,
  ): Promise<boolean> {
    const guildId = this.guild.id;

    const expectedRoleIds = normalizeExactRoleVector(
      contract.grantedRoleIds,
      'Subscription reactivation role vector',
    );
    const expectedChannelIds = normalizeExactRoleVector(
      contract.grantedChannelIds,
      'Subscription reactivation channel vector',
    );
    if (
      !roleDeliveryClaim
      ||
      entitlementId.length === 0
      || entitlementId.trim() !== entitlementId
      || contract.entitlementType !== 'subscription'
      || !Number.isFinite(Date.parse(contract.expiresAt))
      || ![
        contract.customerId,
        contract.productId,
        contract.orderId,
        contract.planId,
        contract.discordId,
      ].every((value) => value.length > 0 && value.trim() === value)
    ) {
      throw new Error('Subscription reactivation contract is malformed');
    }

    const loadExactEntitlement = async () => {
      const { data, error } = await this.supabase
        .from('entitlements')
        .select('id, guild_id, customer_id, product_id, plan_id, order_id, type, status, source, granted_role_ids, granted_channel_ids, grace_period_ends_at, expires_at')
        .eq('id', entitlementId)
        .eq('guild_id', guildId)
        .eq('customer_id', contract.customerId)
        .eq('product_id', contract.productId)
        .eq('plan_id', contract.planId)
        .eq('order_id', contract.orderId)
        .eq('type', 'subscription')
        .maybeSingle();
      if (error) {
        throw new Error(`Failed to load entitlement for reactivation: ${error.message}`);
      }
      if (!data) return null;
      if (
        data.id !== entitlementId
        || data.guild_id !== guildId
        || data.customer_id !== contract.customerId
        || data.product_id !== contract.productId
        || data.plan_id !== contract.planId
        || data.order_id !== contract.orderId
        || data.type !== 'subscription'
        || typeof data.status !== 'string'
        || ![
          'active',
          'pending',
          'grace_period',
          'suspended',
          'expired',
          'cancelled',
        ].includes(data.status)
        || (data.source !== 'purchase' && data.source !== null)
        || !exactRoleVectorsMatch(data.granted_role_ids, expectedRoleIds)
        || !exactRoleVectorsMatch(data.granted_channel_ids, expectedChannelIds)
      ) {
        throw new Error('Subscription reactivation entitlement identity mismatch');
      }
      return data;
    };

    let entitlement = await loadExactEntitlement();
    if (!entitlement) return false;

    const { data: customer, error: customerError } = await this.supabase
      .from('customers')
      .select('id, guild_id, discord_id')
      .eq('id', contract.customerId)
      .eq('guild_id', guildId)
      .maybeSingle();
    if (
      customerError
      || !customer
      || customer.id !== contract.customerId
      || customer.guild_id !== guildId
      || customer.discord_id !== contract.discordId
    ) {
      throw new Error(
        `Failed to verify customer identity for entitlement reactivation: ${customerError?.message ?? 'missing or mismatched customer'}`,
      );
    }

    const { data: lifecycleData, error: lifecycleError } = await (
      this.supabase.rpc as (
        fn: string,
        params: Record<string, unknown>,
      ) => ReturnType<typeof this.supabase.rpc>
    )('commerce_apply_subscription_entitlement_lifecycle', {
      p_action_id: roleDeliveryClaim.actionId,
      p_claim_token: roleDeliveryClaim.claimToken,
      p_entitlement_id: entitlementId,
      p_guild_id: guildId,
      p_customer_id: contract.customerId,
      p_discord_id: contract.discordId,
      p_product_id: contract.productId,
      p_order_id: contract.orderId,
      p_plan_id: contract.planId,
      p_license_key_id: null,
      p_granted_role_ids: expectedRoleIds,
      p_granted_channel_ids: expectedChannelIds,
      p_expires_at: contract.expiresAt,
    });
    if (lifecycleError) {
      throw new Error(
        `Failed to advance subscription entitlement lifecycle: ${lifecycleError.message}`,
      );
    }
    const lifecycleRow = firstRpcRow(lifecycleData);
    if (
      !lifecycleRow
      || !['advanced', 'superseded'].includes(String(lifecycleRow.disposition))
      || lifecycleRow.entitlement_id !== entitlementId
    ) {
      throw new Error('Subscription reactivation lifecycle returned malformed evidence');
    }
    if (lifecycleRow.disposition === 'superseded') {
      throw new PurchaseRoleDeliveryTerminalNoopError(entitlementId);
    }
    if (
      lifecycleRow.status !== 'active'
      || Date.parse(String(lifecycleRow.expires_at))
        !== Date.parse(contract.expiresAt)
    ) {
      throw new Error('Subscription reactivation lifecycle returned mismatched access');
    }
    entitlement = await loadExactEntitlement();
    if (
      !entitlement
      || entitlement.status !== 'active'
      || Date.parse(String(entitlement.expires_at))
        !== Date.parse(contract.expiresAt)
    ) {
      throw new Error('Subscription reactivation durable access disappeared');
    }

    const begun = await this.beginPurchaseRoleDeliveryAttempt(
      entitlementId,
      {
        ...contract,
        grantedRoleIds: expectedRoleIds,
      },
      roleDeliveryClaim,
    );
    if (begun.state === 'terminal') {
      if (begun.cleanupNeeded) {
        await this.executeOwnedPurchaseRoleCleanup(begun.intentId, roleDeliveryClaim);
      }
      throw new PurchaseRoleDeliveryTerminalNoopError(entitlementId);
    }
    const deliveryAttempt = begun.state === 'live' ? begun.attempt : undefined;

    if (deliveryAttempt) {
      await this.ensurePurchaseGrantedRoles(
        entitlementId,
        {
          ...contract,
          grantedRoleIds: expectedRoleIds,
        },
        deliveryAttempt,
      );
    }

    // Resolve the grace alert only after exact DB identity and Discord role
    // delivery have both been confirmed. Failure is non-fatal but visible
    // (resolveOwnerAlert logs internally and posts the #51 recovery notice).
    await resolveOwnerAlert(
      this.supabase,
      guildId,
      'entitlement_grace_period',
      { entitlement_id: entitlementId },
      {
        guild: this.guild,
        notice: `Entitlement ${entitlementId} recovered from its payment grace period — access is active again.`,
      },
    );

    log.info(`Entitlement reactivated: ${entitlementId}`);
    return true;
  }

  // ── Role helpers ──────────────────────────────────

  async beginPurchaseRoleDeliveryAttempt(
    entitlementId: string,
    contract: PurchaseRoleDeliveryContract,
    claim: RoleDeliveryActionClaim,
  ): Promise<PurchaseRoleDeliveryBeginResult> {
    this.confirmedPurchaseRoleDeliveryReplay = false;
    this.purchaseRoleDeliveryOutwardGeneration = null;
    const normalizedRoleIds = normalizeExactRoleVector(
      contract.grantedRoleIds,
      'Purchase granted role vector',
    );
    if (
      ![entitlementId, claim.actionId, claim.claimToken].every((value) =>
        typeof value === 'string' && value.length > 0 && value.trim() === value)
    ) {
      throw new Error('Purchase role delivery claim is malformed');
    }

    const { data, error } = await (
      this.supabase.rpc as (
        fn: string,
        params: Record<string, unknown>,
      ) => ReturnType<typeof this.supabase.rpc>
    )('commerce_begin_role_delivery_attempt', {
      p_action_id: claim.actionId,
      p_claim_token: claim.claimToken,
      p_entitlement_id: entitlementId,
      p_guild_id: this.guild.id,
      p_customer_id: contract.customerId,
      p_discord_id: contract.discordId,
      p_order_id: contract.orderId,
      p_product_id: contract.productId,
      p_plan_id: contract.planId,
      p_entitlement_type: contract.entitlementType,
      p_permanent_role_ids: normalizedRoleIds,
    });
    if (error) {
      if (
        contract.entitlementType === 'subscription'
        && error.message.includes('subscription lifecycle authority was superseded')
      ) {
        throw new PurchaseRoleDeliveryTerminalNoopError(entitlementId);
      }
      throw new Error(`Failed to begin paid role delivery intent: ${error.message}`);
    }

    const row = firstRpcRow(data);
    if (
      !row
      || typeof row.intent_id !== 'string'
      || row.intent_id.length === 0
      || typeof row.intent_state !== 'string'
      || !['open', 'cleanup_required', 'operator_required', 'settled'].includes(
        row.intent_state,
      )
      || typeof row.may_mutate !== 'boolean'
      || typeof row.contract_live !== 'boolean'
      || typeof row.delivery_confirmed !== 'boolean'
      || typeof row.cleanup_needed !== 'boolean'
      || (
        row.outward_generation_id !== null
        && (
          typeof row.outward_generation_id !== 'string'
          || row.outward_generation_id.length === 0
          || row.outward_generation_id.trim() !== row.outward_generation_id
        )
      )
    ) {
      throw new Error('Paid role delivery intent returned malformed evidence');
    }

    if (row.contract_live && row.delivery_confirmed && !row.may_mutate) {
      if (row.mutation_token !== null) {
        throw new Error('Confirmed paid role replay returned an active mutation token');
      }
      this.confirmedPurchaseRoleDeliveryReplay = true;
      this.purchaseRoleDeliveryOutwardGeneration =
        row.outward_generation_id as string | null;
      return {
        state: 'confirmed_live',
        intentId: row.intent_id,
        outwardGenerationId: row.outward_generation_id as string | null,
      };
    }
    if (!row.contract_live) {
      if (row.may_mutate) {
        throw new Error('Terminal paid role delivery intent returned mutation authority');
      }
      return {
        state: 'terminal',
        intentId: row.intent_id,
        cleanupNeeded: row.cleanup_needed,
      };
    }
    if (!row.may_mutate || row.delivery_confirmed) {
      throw new Error('Live paid role delivery intent is unresolved and requires operator recovery');
    }
    if (
      row.intent_state !== 'open'
      || typeof row.mutation_token !== 'string'
      || row.mutation_token.length === 0
      || typeof row.outward_generation_id !== 'string'
      || row.outward_generation_id.length === 0
    ) {
      throw new Error('Live paid role delivery intent returned mismatched evidence');
    }
    const attempt: PurchaseRoleDeliveryAttempt = {
      ...claim,
      intentId: row.intent_id,
      mutationToken: row.mutation_token,
      outwardGenerationId: row.outward_generation_id,
    };
    this.activePurchaseRoleDeliveryAttempt = attempt;
    this.purchaseRoleDeliveryOutwardGeneration = row.outward_generation_id;
    return {
      state: 'live',
      attempt,
    };
  }

  async beginNonCommerceRoleDeliveryAttempt(
    entitlementId: string,
    contract: NonCommerceRoleDeliveryContract,
    claim: RoleDeliveryActionClaim,
  ): Promise<NonCommerceRoleDeliveryBeginResult> {
    const normalizedRoleIds = normalizeExactRoleVector(
      contract.grantedRoleIds,
      'Non-commerce granted role vector',
    );
    const requiredStrings = [
      entitlementId,
      claim.actionId,
      claim.claimToken,
      contract.customerId,
      contract.productId,
      contract.discordId,
      contract.activationGeneration,
    ];
    if (
      requiredStrings.some((value) =>
        typeof value !== 'string' || value.length === 0 || value.trim() !== value)
      || (contract.orderId !== null
        && (contract.orderId.length === 0 || contract.orderId.trim() !== contract.orderId))
      || (contract.planId !== null
        && (contract.planId.length === 0 || contract.planId.trim() !== contract.planId))
      || !['one_time', 'subscription'].includes(contract.entitlementType)
      || !['manual', 'giveaway', 'automation'].includes(contract.entitlementSource)
    ) {
      throw new Error('Non-commerce role delivery claim is malformed');
    }

    const { data, error } = await (
      this.supabase.rpc as (
        fn: string,
        params: Record<string, unknown>,
      ) => ReturnType<typeof this.supabase.rpc>
    )('commerce_begin_noncommerce_role_delivery_attempt', {
      p_action_id: claim.actionId,
      p_claim_token: claim.claimToken,
      p_entitlement_id: entitlementId,
      p_guild_id: this.guild.id,
      p_customer_id: contract.customerId,
      p_discord_id: contract.discordId,
      p_order_id: contract.orderId,
      p_product_id: contract.productId,
      p_plan_id: contract.planId,
      p_entitlement_type: contract.entitlementType,
      p_entitlement_source: contract.entitlementSource,
      p_activation_generation: contract.activationGeneration,
      p_permanent_role_ids: normalizedRoleIds,
    });
    if (error) {
      throw new Error(`Failed to begin non-commerce role delivery intent: ${error.message}`);
    }

    const row = firstRpcRow(data);
    const dispositions = [
      'superseded',
      'unproven',
      'confirmed_replay',
      'operator_held',
      'terminal',
      'live_mutation',
    ];
    if (
      !row
      || typeof row.may_mutate !== 'boolean'
      || typeof row.contract_live !== 'boolean'
      || typeof row.delivery_confirmed !== 'boolean'
      || typeof row.cleanup_needed !== 'boolean'
      || typeof row.disposition !== 'string'
      || !dispositions.includes(row.disposition)
    ) {
      throw new Error('Non-commerce role delivery intent returned malformed evidence');
    }

    const disposition = row.disposition;
    const hasIntent = typeof row.intent_id === 'string' && row.intent_id.length > 0;
    if (disposition === 'unproven') {
      if (
        row.intent_id !== null
        || row.mutation_token !== null
        || row.intent_state !== null
        || row.may_mutate
        || row.contract_live
        || row.delivery_confirmed
        || row.cleanup_needed
      ) {
        throw new Error('Unproven non-commerce role delivery returned mismatched evidence');
      }
      return { state: 'unproven' };
    }
    if (disposition === 'superseded') {
      const noIntent = row.intent_id === null
        && row.mutation_token === null
        && row.intent_state === null
        && !row.may_mutate
        && !row.contract_live
        && !row.delivery_confirmed
        && !row.cleanup_needed;
      const settledIntent = hasIntent
        && row.mutation_token === null
        && row.intent_state === 'settled'
        && !row.may_mutate
        && !row.contract_live
        && !row.delivery_confirmed
        && !row.cleanup_needed;
      if (!noIntent && !settledIntent) {
        throw new Error('Superseded non-commerce role delivery returned mismatched evidence');
      }
      return { state: 'superseded' };
    }
    if (!hasIntent) {
      throw new Error('Non-commerce role delivery intent identity is missing');
    }
    if (disposition === 'confirmed_replay') {
      if (
        row.mutation_token !== null
        || row.intent_state !== 'open'
        || row.may_mutate
        || !row.contract_live
        || !row.delivery_confirmed
        || row.cleanup_needed
      ) {
        throw new Error('Confirmed non-commerce role replay returned mismatched evidence');
      }
      return { state: 'confirmed_live', intentId: row.intent_id as string };
    }
    if (disposition === 'terminal') {
      if (
        row.mutation_token !== null
        || !['cleanup_required', 'settled'].includes(String(row.intent_state))
        || row.may_mutate
        || row.contract_live
        || row.delivery_confirmed
        || row.cleanup_needed !== (row.intent_state === 'cleanup_required')
      ) {
        throw new Error('Terminal non-commerce role delivery returned mismatched evidence');
      }
      return {
        state: 'terminal',
        intentId: row.intent_id as string,
        cleanupNeeded: row.cleanup_needed,
      };
    }
    if (disposition === 'operator_held') {
      if (
        row.may_mutate
        || row.contract_live
        || !row.cleanup_needed
        || !['open', 'cleanup_required', 'operator_required'].includes(String(row.intent_state))
      ) {
        throw new Error('Held non-commerce role delivery returned mismatched evidence');
      }
      return { state: 'operator_held', intentId: row.intent_id as string };
    }
    if (
      disposition !== 'live_mutation'
      || row.intent_state !== 'open'
      || typeof row.mutation_token !== 'string'
      || row.mutation_token.length === 0
      || !row.may_mutate
      || !row.contract_live
      || row.delivery_confirmed
      || row.cleanup_needed
    ) {
      throw new Error('Live non-commerce role delivery returned mismatched evidence');
    }
    const attempt: PurchaseRoleDeliveryAttempt = {
      ...claim,
      intentId: row.intent_id as string,
      mutationToken: row.mutation_token,
    };
    this.activePurchaseRoleDeliveryAttempt = attempt;
    return { state: 'live', attempt };
  }

  getActivePurchaseRoleDeliveryAttempt(): PurchaseRoleDeliveryAttempt | null {
    return this.activePurchaseRoleDeliveryAttempt;
  }

  wasPurchaseRoleDeliveryConfirmedReplay(): boolean {
    return this.confirmedPurchaseRoleDeliveryReplay;
  }

  getPurchaseRoleDeliveryOutwardGeneration(): string | null {
    return this.activePurchaseRoleDeliveryAttempt?.outwardGenerationId
      ?? this.purchaseRoleDeliveryOutwardGeneration;
  }

  private async assertRoleDeliveryAttemptLive(
    attempt: PurchaseRoleDeliveryAttempt,
  ): Promise<boolean> {
    const { data, error } = await (
      this.supabase.rpc as (
        fn: string,
        params: Record<string, unknown>,
      ) => ReturnType<typeof this.supabase.rpc>
    )('commerce_assert_role_delivery_attempt_live', {
      p_intent_id: attempt.intentId,
      p_mutation_token: attempt.mutationToken,
    });
    if (error) throw new Error(`Paid role delivery fence failed: ${error.message}`);
    const row = firstRpcRow(data);
    if (
      !row
      || typeof row.intent_state !== 'string'
      || typeof row.may_mutate !== 'boolean'
    ) {
      throw new Error('Paid role delivery fence returned malformed evidence');
    }
    if (row.may_mutate && row.intent_state !== 'open') {
      throw new Error('Paid role delivery fence returned mismatched live evidence');
    }
    return row.may_mutate;
  }

  private async attachPermanentRoleDelivery(
    attempt: PurchaseRoleDeliveryAttempt,
    roleId: string,
    roleWasPresent: boolean,
  ): Promise<RoleDeliveryAttachment> {
    const { data, error } = await (
      this.supabase.rpc as (
        fn: string,
        params: Record<string, unknown>,
      ) => ReturnType<typeof this.supabase.rpc>
    )('commerce_attach_permanent_role_delivery', {
      p_intent_id: attempt.intentId,
      p_mutation_token: attempt.mutationToken,
      p_role_id: roleId,
      p_role_was_present: roleWasPresent,
    });
    if (error) throw new Error(`Failed to attach paid role delivery: ${error.message}`);
    const row = firstRpcRow(data);
    if (
      !row
      || typeof row.intent_state !== 'string'
      || !['open', 'cleanup_required', 'operator_required'].includes(
        row.intent_state,
      )
      || typeof row.may_mutate !== 'boolean'
      || typeof row.owns_removal !== 'boolean'
      || typeof row.claim_newly_acquired !== 'boolean'
      || typeof row.disposition !== 'string'
      || ![
        'reserve_add',
        'reserve_inherited',
        'reserved_replay',
        'owned_replay',
        'manual_baseline',
        'dependency_pending',
        'terminal',
        'operator_held',
      ].includes(row.disposition)
    ) {
      throw new Error('Paid role delivery attachment returned malformed evidence');
    }

    const disposition = row.disposition as RoleDeliveryAttachmentDisposition;
    const liveOwned = row.intent_state === 'open'
      && row.may_mutate === true
      && row.owns_removal === true
      && row.claim_newly_acquired === false;
    const dispositionMatches =
      (disposition === 'reserve_add'
        && row.intent_state === 'open'
        && row.may_mutate === true
        && row.owns_removal === false
        && row.claim_newly_acquired === true)
      || (disposition === 'owned_replay' && liveOwned)
      || ((
        disposition === 'reserve_inherited'
        || disposition === 'reserved_replay'
        || disposition === 'manual_baseline'
        || disposition === 'dependency_pending'
      )
        && row.intent_state === 'open'
        && row.may_mutate === true
        && row.owns_removal === false
        && row.claim_newly_acquired === false)
      || (disposition === 'terminal'
        && row.intent_state === 'cleanup_required'
        && row.may_mutate === false
        && row.owns_removal === false
        && row.claim_newly_acquired === false)
      || (disposition === 'operator_held'
        && row.intent_state === 'operator_required'
        && row.may_mutate === false
        && row.owns_removal === false
        && row.claim_newly_acquired === false);
    if (!dispositionMatches) {
      throw new Error('Paid role delivery attachment returned mismatched evidence');
    }
    if (
      (disposition === 'reserve_add' && roleWasPresent)
      || (disposition === 'reserve_inherited' && !roleWasPresent)
      || ((disposition === 'manual_baseline' || disposition === 'dependency_pending')
        && !roleWasPresent)
    ) {
      throw new Error('Paid role delivery attachment contradicted the Discord observation');
    }

    return {
      intentState: row.intent_state as RoleDeliveryAttachment['intentState'],
      mayMutate: row.may_mutate,
      ownsRemoval: row.owns_removal,
      claimNewlyAcquired: row.claim_newly_acquired,
      disposition,
    };
  }

  private async confirmPermanentRoleDelivery(
    attempt: PurchaseRoleDeliveryAttempt,
    roleId: string,
  ): Promise<RoleDeliveryPromotion> {
    const { data, error } = await (
      this.supabase.rpc as (
        fn: string,
        params: Record<string, unknown>,
      ) => ReturnType<typeof this.supabase.rpc>
    )('commerce_confirm_permanent_role_delivery', {
      p_intent_id: attempt.intentId,
      p_mutation_token: attempt.mutationToken,
      p_role_id: roleId,
    });
    if (error) {
      throw new PurchaseDeliveryMutationUncertainError(
        roleId,
        `durable ownership promotion failed: ${error.message}`,
      );
    }
    const row = firstRpcRow(data);
    if (
      !row
      || typeof row.intent_state !== 'string'
      || !['open', 'operator_required'].includes(row.intent_state)
      || typeof row.promoted !== 'boolean'
      || typeof row.owns_removal !== 'boolean'
    ) {
      throw new PurchaseDeliveryMutationUncertainError(
        roleId,
        'durable ownership promotion returned malformed evidence',
      );
    }
    const matches = row.intent_state === 'open'
      ? row.owns_removal === true
      : row.promoted === false && row.owns_removal === false;
    if (!matches) {
      throw new PurchaseDeliveryMutationUncertainError(
        roleId,
        'durable ownership promotion returned mismatched evidence',
      );
    }
    return {
      intentState: row.intent_state as RoleDeliveryPromotion['intentState'],
      promoted: row.promoted,
      ownsRemoval: row.owns_removal,
    };
  }

  private async confirmPermanentRoleBaseline(
    attempt: PurchaseRoleDeliveryAttempt,
    roleId: string,
  ): Promise<RoleDeliveryBaselineConfirmation> {
    const { data, error } = await (
      this.supabase.rpc as (
        fn: string,
        params: Record<string, unknown>,
      ) => ReturnType<typeof this.supabase.rpc>
    )('commerce_confirm_permanent_role_baseline', {
      p_intent_id: attempt.intentId,
      p_mutation_token: attempt.mutationToken,
      p_role_id: roleId,
    });
    if (error) {
      throw new Error(`Failed to confirm manual paid role baseline: ${error.message}`);
    }
    const row = firstRpcRow(data);
    if (
      !row
      || row.intent_state !== 'open'
      || typeof row.confirmed !== 'boolean'
      || typeof row.disposition !== 'string'
      || ![
        'manual_baseline',
        'baseline_replay',
        'contract_changed',
        'dependency_pending',
        'owner_changed',
      ].includes(row.disposition)
    ) {
      throw new Error('Manual paid role baseline returned malformed evidence');
    }
    const disposition = row.disposition as RoleDeliveryBaselineConfirmation['disposition'];
    const matches = row.confirmed
      ? disposition === 'manual_baseline' || disposition === 'baseline_replay'
      : disposition === 'contract_changed'
        || disposition === 'dependency_pending'
        || disposition === 'owner_changed';
    if (!matches) {
      throw new Error('Manual paid role baseline returned mismatched evidence');
    }
    return {
      intentState: 'open',
      confirmed: row.confirmed,
      disposition,
    };
  }

  private async releaseUnconsumedPermanentRoleClaim(
    attempt: PurchaseRoleDeliveryAttempt,
    roleId: string,
  ): Promise<void> {
    const { data, error } = await (
      this.supabase.rpc as (
        fn: string,
        params: Record<string, unknown>,
      ) => ReturnType<typeof this.supabase.rpc>
    )('commerce_release_unconsumed_permanent_role_claim', {
      p_intent_id: attempt.intentId,
      p_mutation_token: attempt.mutationToken,
      p_role_id: roleId,
    });
    if (error) {
      throw new Error(`Failed to release unconsumed paid role reservation: ${error.message}`);
    }
    const row = firstRpcRow(data);
    if (
      !row
      || typeof row.intent_state !== 'string'
      || !['open', 'cleanup_required', 'operator_required', 'settled'].includes(
        row.intent_state,
      )
      || row.released !== true
      || typeof row.may_mutate !== 'boolean'
      || typeof row.cleanup_needed !== 'boolean'
      || typeof row.settled !== 'boolean'
    ) {
      throw new Error('Paid role reservation release returned malformed evidence');
    }
    if (row.may_mutate) {
      if (row.intent_state !== 'open' || row.cleanup_needed || row.settled) {
        throw new Error('Paid role reservation release returned mismatched live evidence');
      }
      return;
    }

    if (!row.cleanup_needed && !row.settled) {
      throw new Error('Terminal paid role reservation release has no cleanup carrier');
    }
    // A terminal fence after releasing a provisional reservation must enter
    // the exact-intent cleanup path; the release itself never grants removal
    // authority and is not a whole-attempt compensation marker.
    throw new PurchaseDeliveryTerminalFenceError(false);
  }

  async finishPurchaseRoleDeliveryAttempt(
    attempt: PurchaseRoleDeliveryAttempt,
    outcome: 'live' | 'compensated' | 'retry',
    errorDetail: string | null = null,
  ): Promise<{
    state: string;
    settled: boolean;
    authorityEmpty: boolean;
    disposition: PurchaseRoleDeliveryDisposition;
  }> {
    const { data, error } = await (
      this.supabase.rpc as (
        fn: string,
        params: Record<string, unknown>,
      ) => ReturnType<typeof this.supabase.rpc>
    )('commerce_finish_role_delivery_attempt', {
      p_intent_id: attempt.intentId,
      p_mutation_token: attempt.mutationToken,
      p_outcome: outcome,
      p_error: errorDetail,
    });
    if (error) throw new Error(`Failed to finish paid role delivery intent: ${error.message}`);
    const row = firstRpcRow(data);
    if (
      !row
      || typeof row.intent_state !== 'string'
      || typeof row.settled !== 'boolean'
      || typeof row.authority_empty !== 'boolean'
      || typeof row.disposition !== 'string'
      || ![
        'confirmed_open',
        'settled',
        'safe_retry',
        'safe_retry_owned',
        'run_origin_cleanup',
        'operator_held',
      ].includes(row.disposition)
    ) {
      throw new Error('Paid role delivery finalization returned malformed evidence');
    }
    if (row.settled !== (row.intent_state === 'settled')) {
      throw new Error('Paid role delivery finalization returned mismatched evidence');
    }
    const disposition = row.disposition as PurchaseRoleDeliveryDisposition;
    const dispositionMatches =
      (disposition === 'confirmed_open'
        && row.intent_state === 'open' && !row.settled && !row.authority_empty)
      || (disposition === 'settled'
        && row.intent_state === 'settled' && row.settled && row.authority_empty)
      || (disposition === 'safe_retry'
        && row.intent_state === 'open' && !row.settled && row.authority_empty)
      || (disposition === 'safe_retry_owned'
        && row.intent_state === 'open' && !row.settled && !row.authority_empty)
      || (disposition === 'run_origin_cleanup'
        && row.intent_state === 'operator_required' && !row.settled && !row.authority_empty)
      || (disposition === 'operator_held'
        && row.intent_state === 'operator_required' && !row.settled);
    if (!dispositionMatches) {
      throw new Error('Paid role delivery finalization returned mismatched disposition');
    }
    if (disposition !== 'run_origin_cleanup') {
      this.activePurchaseRoleDeliveryAttempt = null;
    }
    if (outcome === 'retry' || outcome === 'live') {
      await recordRoleDeliveryOutcome(this.supabase, {
        guildId: this.guild.id,
        intentId: attempt.intentId,
        outcome,
        disposition,
      });
    }
    return {
      state: row.intent_state,
      settled: row.settled,
      authorityEmpty: row.authority_empty,
      disposition,
    };
  }

  async reconcileOwnedPurchaseRoleCleanup(
    contract: PurchaseRoleCleanupContract,
  ): Promise<{ removed: string[]; absent: string[]; retained: string[] }> {
    if (
      ![
        contract.intentId,
        contract.entitlementId,
        contract.customerId,
        contract.discordId,
      ].every((value) => value.length > 0 && value.trim() === value)
    ) {
      throw new Error('Paid role cleanup contract is malformed');
    }
    const ownedRoleIds = normalizeExactRoleVector(
      contract.ownedRoleIds,
      'Paid role cleanup ownership vector',
    );
    if (
      !Array.isArray(contract.temporaryRoleGrantIds)
      || contract.temporaryRoleGrantIds.some((grantId) =>
        typeof grantId !== 'string' || grantId.length === 0 || grantId.trim() !== grantId)
      || new Set(contract.temporaryRoleGrantIds).size !== contract.temporaryRoleGrantIds.length
    ) {
      throw new Error('Paid role cleanup temporary ownership vector is malformed');
    }
    return this.revokeRolesSafely(
      contract.discordId,
      ownedRoleIds,
      {
        intentId: contract.intentId,
        entitlementId: contract.entitlementId,
        temporaryRoleGrantIds: [...contract.temporaryRoleGrantIds],
      },
      `Commerce: unresolved delivery intent ${contract.intentId} cleanup`,
    );
  }

  async executeOwnedPurchaseRoleCleanup(
    intentId: string,
    cleanupClaim: RoleDeliveryActionClaim,
  ): Promise<{ state: string; settled: boolean }> {
    if (
      ![intentId, cleanupClaim.actionId, cleanupClaim.claimToken].every((value) =>
        value.length > 0 && value.trim() === value)
    ) {
      throw new Error('Paid role cleanup claim is malformed');
    }
    const rpc = this.supabase.rpc as (
      fn: string,
      params: Record<string, unknown>,
    ) => ReturnType<typeof this.supabase.rpc>;
    const { data: begunData, error: begunError } = await rpc(
      'commerce_begin_role_delivery_cleanup',
      {
        p_intent_id: intentId,
        p_cleanup_action_id: cleanupClaim.actionId,
        p_cleanup_claim_token: cleanupClaim.claimToken,
      },
    );
    if (begunError) throw new Error(`Paid role cleanup claim failed: ${begunError.message}`);
    const begun = firstRpcRow(begunData);
    if (
      begun?.intent_state === 'settled'
      && begun.may_mutate === false
      && begun.cleanup_mutation_token === null
    ) {
      if (this.activePurchaseRoleDeliveryAttempt?.intentId === intentId) {
        this.activePurchaseRoleDeliveryAttempt = null;
      }
      return { state: 'settled', settled: true };
    }
    if (
      (begun?.intent_state === 'cleanup_required' || begun?.intent_state === 'operator_required')
      && begun.may_mutate === false
      && begun.cleanup_mutation_token === null
    ) {
      throw new Error('Paid role cleanup is held by another or uncertain controller');
    }
    if (
      !begun
      || typeof begun.cleanup_mutation_token !== 'string'
      || begun.cleanup_mutation_token.length === 0
      || begun.may_mutate !== true
      || (begun.intent_state !== 'cleanup_required' && begun.intent_state !== 'operator_required')
    ) {
      throw new Error('Paid role cleanup claim returned malformed evidence');
    }

    const cleanupToken = begun.cleanup_mutation_token;
    const { data: contractData, error: contractError } = await rpc(
      'commerce_get_role_delivery_cleanup',
      {
        p_intent_id: intentId,
        p_cleanup_action_id: cleanupClaim.actionId,
        p_cleanup_claim_token: cleanupClaim.claimToken,
        p_cleanup_mutation_token: cleanupToken,
      },
    );
    if (contractError) {
      throw new Error(`Paid role cleanup contract failed: ${contractError.message}`);
    }
    const contract = firstRpcRow(contractData);
    if (
      !contract
      || contract.intent_id !== intentId
      || contract.guild_id !== this.guild.id
      || typeof contract.entitlement_id !== 'string'
      || typeof contract.customer_id !== 'string'
      || typeof contract.discord_id !== 'string'
      || !Array.isArray(contract.owned_role_ids)
      || !Array.isArray(contract.temporary_role_grant_ids)
    ) {
      throw new Error('Paid role cleanup contract returned malformed evidence');
    }

    const outcome = await this.reconcileOwnedPurchaseRoleCleanup({
      intentId,
      entitlementId: contract.entitlement_id,
      customerId: contract.customer_id,
      discordId: contract.discord_id,
      ownedRoleIds: contract.owned_role_ids as string[],
      temporaryRoleGrantIds: contract.temporary_role_grant_ids as string[],
    });

    const { data: finishedData, error: finishedError } = await rpc(
      'commerce_finish_role_delivery_cleanup',
      {
        p_intent_id: intentId,
        p_cleanup_action_id: cleanupClaim.actionId,
        p_cleanup_claim_token: cleanupClaim.claimToken,
        p_cleanup_mutation_token: cleanupToken,
        p_outcome: 'cleaned',
        p_error: null,
        p_removed_role_ids: outcome.removed,
        p_absent_role_ids: outcome.absent,
        p_retained_role_ids: outcome.retained,
      },
    );
    if (finishedError) {
      throw new Error(`Paid role cleanup finalization failed: ${finishedError.message}`);
    }
    const finished = firstRpcRow(finishedData);
    if (
      !finished
      || typeof finished.intent_state !== 'string'
      || typeof finished.settled !== 'boolean'
    ) {
      throw new Error('Paid role cleanup finalization returned malformed evidence');
    }
    const isCurrentDeliveryCleanup =
      this.activePurchaseRoleDeliveryAttempt?.intentId === intentId;
    if (
      !finished.settled
      && !(isCurrentDeliveryCleanup && finished.intent_state === 'cleanup_required')
    ) {
      throw new Error('Paid role cleanup remains unresolved after confirmed mutation');
    }
    if (finished.settled && isCurrentDeliveryCleanup) {
      this.activePurchaseRoleDeliveryAttempt = null;
    }
    return { state: finished.intent_state, settled: finished.settled };
  }

  private async isPurchaseGrantStillLive(
    entitlementId: string,
    contract: PurchaseRoleDeliveryContract,
  ): Promise<boolean> {
    const { data, error } = await this.supabase
      .from('entitlements')
      .select('id, guild_id, customer_id, product_id, plan_id, order_id, type, status, source, granted_role_ids')
      .eq('id', entitlementId)
      .eq('guild_id', this.guild.id)
      .eq('customer_id', contract.customerId)
      .eq('product_id', contract.productId)
      .eq('order_id', contract.orderId)
      .maybeSingle();
    if (error) {
      throw new Error(`Failed to verify purchase entitlement after Discord delivery: ${error.message}`);
    }

    const verification = data as unknown;
    const row = verification && typeof verification === 'object' && !Array.isArray(verification)
      ? verification as Record<string, unknown>
      : null;
    const entitlementStatuses = [
      'active',
      'pending',
      'grace_period',
      'suspended',
      'expired',
      'cancelled',
    ];
    const orderStatuses = [
      'pending',
      'completed',
      'refunded',
      'disputed',
      'cancelled',
      'pending_review',
    ];
    if (
      !row
      || row.id !== entitlementId
      || row.guild_id !== this.guild.id
      || row.customer_id !== contract.customerId
      || row.product_id !== contract.productId
      || (row.plan_id ?? null) !== contract.planId
      || row.order_id !== contract.orderId
      || row.type !== contract.entitlementType
      || (row.source !== 'purchase' && row.source !== null)
      || typeof row.status !== 'string'
      || !entitlementStatuses.includes(row.status)
      || !exactRoleVectorsMatch(row.granted_role_ids, contract.grantedRoleIds)
    ) {
      throw new Error('Purchase entitlement verification returned malformed or mismatched data');
    }

    const { data: parentOrderValue, error: orderError } = await this.supabase
      .from('orders')
      .select('id, guild_id, customer_id, product_id, plan_id, status')
      .eq('id', contract.orderId)
      .eq('guild_id', this.guild.id)
      .eq('customer_id', contract.customerId)
      .eq('product_id', contract.productId)
      .maybeSingle();
    if (orderError) {
      throw new Error(`Failed to verify parent order after Discord delivery: ${orderError.message}`);
    }
    const parentOrder = parentOrderValue as unknown;
    const order = parentOrder && typeof parentOrder === 'object' && !Array.isArray(parentOrder)
      ? parentOrder as Record<string, unknown>
      : null;
    if (
      !order
      || order.id !== contract.orderId
      || order.guild_id !== this.guild.id
      || order.customer_id !== contract.customerId
      || order.product_id !== contract.productId
      || (order.plan_id ?? null) !== contract.planId
      || typeof order.status !== 'string'
      || !orderStatuses.includes(order.status)
    ) {
      throw new Error('Purchase parent-order verification returned malformed or mismatched data');
    }

    // Discord delivery can race a customer relink. A well-formed missing or
    // changed mapping is authoritative evidence that this old Discord target
    // no longer owns the paid grant; malformed data and lookup errors remain
    // retryable uncertainty.
    const { data: customerValue, error: customerError } = await this.supabase
      .from('customers')
      .select('id, guild_id, discord_id')
      .eq('id', contract.customerId)
      .eq('guild_id', this.guild.id)
      .maybeSingle();
    if (customerError) {
      throw new Error(`Failed to verify customer after Discord delivery: ${customerError.message}`);
    }
    const customer = customerValue as unknown;
    if (customer === null) return false;
    if (
      typeof customer !== 'object'
      || Array.isArray(customer)
      || (customer as Record<string, unknown>).id !== contract.customerId
      || (customer as Record<string, unknown>).guild_id !== this.guild.id
      || typeof (customer as Record<string, unknown>).discord_id !== 'string'
      || ((customer as Record<string, unknown>).discord_id as string).length === 0
    ) {
      throw new Error('Purchase customer verification returned malformed or mismatched data');
    }

    if ((customer as Record<string, unknown>).discord_id !== contract.discordId) return false;

    return ['active', 'pending', 'grace_period', 'suspended'].includes(row.status as string)
      && order.status === 'completed';
  }

  async reconcilePurchaseGrantedRoles(
    entitlementId: string,
    contract: PurchaseRoleDeliveryContract,
    attempt: PurchaseRoleDeliveryAttempt,
  ): Promise<PurchaseRoleReconciliationOutcome> {
    if (
      entitlementId.length === 0
      || entitlementId.trim() !== entitlementId
      || ![
        contract.customerId,
        contract.productId,
        contract.orderId,
        contract.discordId,
      ].every((value) => value.length > 0 && value.trim() === value)
      || (
        contract.planId !== null
        && (contract.planId.length === 0 || contract.planId.trim() !== contract.planId)
      )
      || !['one_time', 'subscription'].includes(contract.entitlementType)
      || (contract.entitlementType === 'subscription' && contract.planId === null)
    ) {
      throw new Error('Purchase role delivery contract is malformed');
    }
    const normalizedContract: PurchaseRoleDeliveryContract = {
      ...contract,
      grantedRoleIds: normalizeExactRoleVector(
        contract.grantedRoleIds,
        'Purchase granted role vector',
      ),
    };

    // Fence before the first Discord write. This closes the common refund /
    // stale-reconciliation race without weakening the post-write proof below.
    // A durable delivery-intent token (owned by the queue layer) covers the
    // unavoidable external-write crash gap between these two proofs.
    const purchaseLiveBeforeDelivery = await this.isPurchaseGrantStillLive(
      entitlementId,
      normalizedContract,
    );
    if (!purchaseLiveBeforeDelivery) {
      // This invocation has not introduced a Discord role. Entitlement
      // metadata alone is not authority to remove a role that may have been
      // assigned manually after an older delivery settled. Residue from a
      // crashed delivery is handled only through its explicit unresolved,
      // tokenized delivery intent.
      return 'terminal';
    }
    const intentLiveBeforeDelivery = await this.assertRoleDeliveryAttemptLive(attempt);
    if (!intentLiveBeforeDelivery) {
      throw new PurchaseDeliveryMutationUncertainError(
        normalizedContract.grantedRoleIds[0] ?? 'unknown',
        'the exact delivery claim is no longer live',
      );
    }

    try {
      await this.addAndConfirmGrantedRoles(
        normalizedContract.discordId,
        normalizedContract.grantedRoleIds,
        async (roleId, roleWasPresent) => this.attachPermanentRoleDelivery(
          attempt,
          roleId,
          roleWasPresent,
        ),
        async (roleId) => this.releaseUnconsumedPermanentRoleClaim(attempt, roleId),
        async (roleId) => this.confirmPermanentRoleDelivery(attempt, roleId),
        async (roleId) => this.confirmPermanentRoleBaseline(attempt, roleId),
      );
    } catch (deliveryError) {
      if (deliveryError instanceof PurchaseDeliveryTerminalFenceError) {
        await this.executeOwnedPurchaseRoleCleanup(attempt.intentId, attempt);
        return 'terminal';
      }
      // Confirmed ownership and provisional reservations are durable protocol
      // state, not a whole-action success marker. Preserve them for the exact
      // same-action retry/rebind instead of deleting a partially delivered
      // role vector or attempting newly-added-only compensation.
      throw deliveryError;
    }

    let purchaseStillLive = await this.isPurchaseGrantStillLive(
      entitlementId,
      normalizedContract,
    );
    if (purchaseStillLive) {
      purchaseStillLive = await this.assertRoleDeliveryAttemptLive(attempt);
      if (!purchaseStillLive) {
        throw new PurchaseDeliveryMutationUncertainError(
          normalizedContract.grantedRoleIds[0] ?? 'unknown',
          'the exact delivery claim was lost before whole-action confirmation',
        );
      }
    }

    if (!purchaseStillLive) {
      // Terminal evidence invokes the full exact-intent cleanup vector. This
      // covers inherited/replayed ownership and excludes manual baselines;
      // a newly-added-only list is neither complete nor authoritative.
      await this.executeOwnedPurchaseRoleCleanup(attempt.intentId, attempt);
      return 'terminal';
    }

    return 'live';
  }

  async ensurePurchaseGrantedRoles(
    entitlementId: string,
    contract: PurchaseRoleDeliveryContract,
    attempt: PurchaseRoleDeliveryAttempt,
  ): Promise<void> {
    const outcome = await this.reconcilePurchaseGrantedRoles(entitlementId, contract, attempt);
    if (outcome === 'terminal') {
      throw new PurchaseRoleDeliveryTerminalNoopError(entitlementId);
    }
  }

  async reconcileNonCommerceGrantedRoles(
    contract: NonCommerceRoleDeliveryContract,
    attempt: PurchaseRoleDeliveryAttempt,
  ): Promise<PurchaseRoleReconciliationOutcome> {
    const normalizedRoleIds = normalizeExactRoleVector(
      contract.grantedRoleIds,
      'Non-commerce granted role vector',
    );
    if (
      [
        contract.customerId,
        contract.productId,
        contract.discordId,
        contract.activationGeneration,
      ].some((value) => value.length === 0 || value.trim() !== value)
      || (contract.orderId !== null
        && (contract.orderId.length === 0 || contract.orderId.trim() !== contract.orderId))
      || (contract.planId !== null
        && (contract.planId.length === 0 || contract.planId.trim() !== contract.planId))
      || !['one_time', 'subscription'].includes(contract.entitlementType)
      || !['manual', 'giveaway', 'automation'].includes(contract.entitlementSource)
    ) {
      throw new Error('Non-commerce role delivery contract is malformed');
    }

    if (!await this.assertRoleDeliveryAttemptLive(attempt)) {
      throw new PurchaseDeliveryMutationUncertainError(
        normalizedRoleIds[0] ?? 'unknown',
        'the exact non-commerce delivery claim is no longer live',
      );
    }
    try {
      await this.addAndConfirmGrantedRoles(
        contract.discordId,
        normalizedRoleIds,
        async (roleId, roleWasPresent) => this.attachPermanentRoleDelivery(
          attempt,
          roleId,
          roleWasPresent,
        ),
        async (roleId) => this.releaseUnconsumedPermanentRoleClaim(attempt, roleId),
        async (roleId) => this.confirmPermanentRoleDelivery(attempt, roleId),
        async (roleId) => this.confirmPermanentRoleBaseline(attempt, roleId),
      );
    } catch (deliveryError) {
      if (deliveryError instanceof PurchaseDeliveryTerminalFenceError) {
        await this.executeOwnedPurchaseRoleCleanup(attempt.intentId, attempt);
        return 'terminal';
      }
      throw deliveryError;
    }

    if (!await this.assertRoleDeliveryAttemptLive(attempt)) {
      await this.executeOwnedPurchaseRoleCleanup(attempt.intentId, attempt);
      return 'terminal';
    }
    return 'live';
  }

  async ensureGrantedRoles(discordId: string, roleIds: string[]): Promise<void> {
    await this.addAndConfirmGrantedRoles(discordId, roleIds);
  }

  private async addAndConfirmGrantedRoles(
    discordId: string,
    roleIds: string[],
    attachRoleDelivery?: (
      roleId: string,
      roleWasPresent: boolean,
    ) => Promise<RoleDeliveryAttachment>,
    releaseUnconsumedRoleClaim?: (roleId: string) => Promise<void>,
    confirmReservedRole?: (roleId: string) => Promise<RoleDeliveryPromotion>,
    confirmManualBaseline?: (
      roleId: string,
    ) => Promise<RoleDeliveryBaselineConfirmation>,
  ): Promise<void> {
    if (!roleIds.length) return;

    let member = await this.guild.members.fetch({ user: discordId, force: true });
    for (const roleId of [...new Set(roleIds)]) {
      let attachment: RoleDeliveryAttachment | null = null;
      let hasProvisionalReservation = false;
      if (attachRoleDelivery) {
        const roleWasPresent = member.roles.cache.has(roleId);
        attachment = await attachRoleDelivery(roleId, roleWasPresent);
        hasProvisionalReservation = attachment.disposition === 'reserve_add'
          || attachment.disposition === 'reserve_inherited'
          || attachment.disposition === 'reserved_replay';
        if (attachment.disposition === 'terminal') {
          throw new PurchaseDeliveryTerminalFenceError();
        }
        if (attachment.disposition === 'operator_held') {
          throw new PurchaseDeliveryMutationUncertainError(
            roleId,
            'the durable delivery controller is held for operator recovery',
          );
        }
        if (attachment.disposition === 'dependency_pending') {
          throw new Error(
            `Purchased role ${roleId} ownership dependency remains unresolved`,
          );
        }

        // Every paid role is classified, including an already-present role.
        // Re-read after that durable decision so a concurrent assignment or
        // removal cannot be mistaken for this attempt's own Discord mutation.
        member = await this.guild.members.fetch({ user: discordId, force: true });
        if (attachment.disposition === 'manual_baseline') {
          if (member.roles.cache.has(roleId)) {
            if (!confirmManualBaseline) {
              throw new Error('Paid role baseline confirmation callback is missing');
            }
            const baseline = await confirmManualBaseline(roleId);
            if (!baseline.confirmed) {
              if (baseline.disposition === 'contract_changed') {
                throw new PurchaseDeliveryTerminalFenceError();
              }
              throw new Error(
                `Purchased role ${roleId} baseline changed during confirmation`,
              );
            }
            continue;
          }

          // The observed manual baseline disappeared before it could satisfy
          // delivery. Reclassify the now-absent role; only the resulting
          // durable reservation permits a Discord write.
          attachment = await attachRoleDelivery(roleId, false);
          hasProvisionalReservation = attachment.disposition === 'reserve_add'
            || attachment.disposition === 'reserve_inherited'
            || attachment.disposition === 'reserved_replay';
          if (attachment.disposition === 'terminal') {
            throw new PurchaseDeliveryTerminalFenceError();
          }
          if (attachment.disposition === 'operator_held') {
            throw new PurchaseDeliveryMutationUncertainError(
              roleId,
              'the durable delivery controller is held for operator recovery',
            );
          }
          if (attachment.disposition === 'dependency_pending') {
            throw new Error(
              `Purchased role ${roleId} ownership dependency remains unresolved`,
            );
          }
          if (
            attachment.disposition !== 'reserve_add'
            || attachment.ownsRemoval
            || !attachment.claimNewlyAcquired
          ) {
            throw new Error('Absent paid role did not acquire an exact add reservation');
          }
          member = await this.guild.members.fetch({ user: discordId, force: true });
        }

        // A newly-created absent-role reservation loses to a role that
        // appeared before this invocation wrote Discord. Release the
        // provisional reservation and preserve the concurrent/manual role.
        if (
          attachment.disposition === 'reserve_add'
          && member.roles.cache.has(roleId)
        ) {
          if (!releaseUnconsumedRoleClaim) {
            throw new Error('Paid role ownership release callback is missing');
          }
          await releaseUnconsumedRoleClaim(roleId);
          attachment = await attachRoleDelivery(roleId, true);
          if (attachment.disposition === 'terminal') {
            throw new PurchaseDeliveryTerminalFenceError();
          }
          if (attachment.disposition === 'operator_held') {
            throw new PurchaseDeliveryMutationUncertainError(
              roleId,
              'the durable delivery controller is held for operator recovery',
            );
          }
          if (attachment.disposition === 'dependency_pending') {
            throw new Error(
              `Purchased role ${roleId} ownership dependency remains unresolved`,
            );
          }
          member = await this.guild.members.fetch({ user: discordId, force: true });
          if (attachment.disposition === 'manual_baseline') {
            if (!member.roles.cache.has(roleId)) {
              throw new Error(`Purchased role ${roleId} changed during baseline classification`);
            }
            if (!confirmManualBaseline) {
              throw new Error('Paid role baseline confirmation callback is missing');
            }
            const baseline = await confirmManualBaseline(roleId);
            if (!baseline.confirmed) {
              if (baseline.disposition === 'contract_changed') {
                throw new PurchaseDeliveryTerminalFenceError();
              }
              throw new Error(
                `Purchased role ${roleId} baseline changed during confirmation`,
              );
            }
            continue;
          }
          hasProvisionalReservation = attachment.disposition === 'reserve_add'
            || attachment.disposition === 'reserve_inherited'
            || attachment.disposition === 'reserved_replay';
        }

        // A reservation replay plus a present role is the add-before-promote
        // crash/manual-add ambiguity. Never convert that provisional state
        // into automatic removal authority.
        if (
          attachment.disposition === 'reserved_replay'
          && member.roles.cache.has(roleId)
        ) {
          throw new PurchaseDeliveryMutationUncertainError(
            roleId,
            'a pre-existing provisional reservation now observes the role present',
          );
        }
      }

      if (!member.roles.cache.has(roleId)) {
        const mayAddWithReservation = attachment?.disposition === 'reserve_add'
          || attachment?.disposition === 'reserve_inherited'
          || attachment?.disposition === 'reserved_replay';
        if (
          attachRoleDelivery
          && (!attachment || (!attachment.ownsRemoval && !mayAddWithReservation))
        ) {
          throw new Error('Paid role is absent without exact ownership or reservation');
        }
        try {
          await member.roles.add(roleId, 'Commerce: entitlement granted');
        } catch (addError) {
          try {
            member = await this.guild.members.fetch({ user: discordId, force: true });
          } catch (readError) {
            throw new PurchaseDeliveryMutationUncertainError(
              roleId,
              `${addError instanceof Error ? addError.message : String(addError)}; post-error read failed: ${
                readError instanceof Error ? readError.message : String(readError)
              }`,
            );
          }
          if (member.roles.cache.has(roleId)) {
            if (attachment?.disposition === 'owned_replay') {
              continue;
            }
            throw new PurchaseDeliveryMutationUncertainError(roleId, addError);
          }
          if (hasProvisionalReservation && !releaseUnconsumedRoleClaim) {
            throw new Error('Paid role ownership release callback is missing');
          }
          if (hasProvisionalReservation && releaseUnconsumedRoleClaim) {
            await releaseUnconsumedRoleClaim(roleId);
          }
          throw addError;
        }

        try {
          member = await this.guild.members.fetch({ user: discordId, force: true });
        } catch (readError) {
          throw new PurchaseDeliveryMutationUncertainError(roleId, readError);
        }
        if (!member.roles.cache.has(roleId)) {
          if (hasProvisionalReservation && !releaseUnconsumedRoleClaim) {
            throw new Error('Paid role ownership release callback is missing');
          }
          if (hasProvisionalReservation && releaseUnconsumedRoleClaim) {
            await releaseUnconsumedRoleClaim(roleId);
          }
          throw new Error(`Discord did not confirm purchased role ${roleId}`);
        }
      }

      if (
        attachment
        && (
          attachment.disposition === 'reserve_add'
          || attachment.disposition === 'reserve_inherited'
          || attachment.disposition === 'reserved_replay'
        )
      ) {
        if (!confirmReservedRole) {
          throw new Error('Paid role ownership promotion callback is missing');
        }
        const promotion = await confirmReservedRole(roleId);
        if (promotion.intentState !== 'open' || !promotion.ownsRemoval) {
          throw new PurchaseDeliveryMutationUncertainError(
            roleId,
            'the provisional reservation could not be promoted',
          );
        }
      }
    }

    member = await this.guild.members.fetch({ user: discordId, force: true });
    const missingRoleIds = [...new Set(roleIds)].filter(
      (roleId) => !member.roles.cache.has(roleId),
    );
    if (missingRoleIds.length > 0) {
      throw new Error(
        `Discord did not confirm ${missingRoleIds.length} purchased role(s) for ${discordId}`,
      );
    }
  }

  private async classifyOtherLiveRoleOwner(
    discordId: string,
    roleId: string,
    exclusions: RoleOwnerExclusions,
  ): Promise<LiveRoleOwnerState> {
    const temporaryRoleGrantIds = exclusions.temporaryRoleGrantIds ?? [];
    if (
      ![discordId, roleId].every((value) =>
        value.length > 0 && value.trim() === value)
      || temporaryRoleGrantIds.some((value) =>
        typeof value !== 'string' || value.length === 0 || value.trim() !== value)
      || new Set(temporaryRoleGrantIds).size !== temporaryRoleGrantIds.length
    ) {
      throw new Error('role ownership proof identity is malformed');
    }
    const { data, error } = await (
      this.supabase.rpc as (
        fn: string,
        params: Record<string, unknown>,
      ) => ReturnType<typeof this.supabase.rpc>
    )('commerce_classify_live_role_owner', {
      p_guild_id: this.guild.id,
      p_discord_id: discordId,
      p_role_id: roleId,
      p_exclude_intent_id: exclusions.intentId ?? null,
      p_exclude_entitlement_id: exclusions.entitlementId ?? null,
      p_exclude_grant_ids: temporaryRoleGrantIds,
    });
    if (error) {
      throw new Error(`authoritative role ownership classification failed: ${error.message}`);
    }
    if (data !== 'confirmed' && data !== 'pending' && data !== 'none') {
      throw new Error('authoritative role ownership classification returned malformed evidence');
    }
    return data;
  }

  private async removeRepairAddedRoleAndConfirm(
    discordId: string,
    roleId: string,
  ): Promise<void> {
    let member = await this.guild.members.fetch({ user: discordId, force: true });
    if (!member.roles.cache.has(roleId)) return;
    await member.roles.remove(
      roleId,
      'Commerce: compensate stale confirmed-owner repair',
    );
    member = await this.guild.members.fetch({ user: discordId, force: true });
    if (member.roles.cache.has(roleId)) {
      throw new Error(`Discord did not confirm stale repair compensation for ${roleId}`);
    }
  }

  private async repairConfirmedRole(
    discordId: string,
    roleId: string,
    exclusions: RoleOwnerExclusions,
    reason: string,
  ): Promise<LiveRoleOwnerState> {
    let ownerState = await this.classifyOtherLiveRoleOwner(
      discordId,
      roleId,
      exclusions,
    );
    if (ownerState !== 'confirmed') return ownerState;

    let member = await this.guild.members.fetch({ user: discordId, force: true });
    if (member.roles.cache.has(roleId)) {
      return this.classifyOtherLiveRoleOwner(discordId, roleId, exclusions);
    }

    ownerState = await this.classifyOtherLiveRoleOwner(
      discordId,
      roleId,
      exclusions,
    );
    if (ownerState !== 'confirmed') return ownerState;

    let addError: unknown = null;
    try {
      await member.roles.add(roleId, reason);
    } catch (error) {
      // A committed Discord add can lose its response. Continue to the
      // authoritative post-add proof so stale access is still compensated.
      addError = error;
    }
    try {
      ownerState = await this.classifyOtherLiveRoleOwner(
        discordId,
        roleId,
        exclusions,
      );
    } catch (classificationError) {
      await this.removeRepairAddedRoleAndConfirm(discordId, roleId);
      throw new Error(
        `post-repair ownership classification failed; added access was removed (${String(classificationError)})`,
      );
    }
    if (ownerState !== 'confirmed') {
      await this.removeRepairAddedRoleAndConfirm(discordId, roleId);
      return ownerState;
    }

    member = await this.guild.members.fetch({ user: discordId, force: true });
    if (!member.roles.cache.has(roleId)) {
      if (addError) {
        throw new Error(
          `Discord retained-role add failed and read-back did not confirm ${roleId} (${String(addError)})`,
        );
      }
      throw new Error(`Discord did not confirm retained role ${roleId}`);
    }
    return 'confirmed';
  }

  private async revokeRolesSafely(
    discordId: string,
    roleIds: string[],
    exclusions: RoleOwnerExclusions = {},
    removalReason: string = 'Commerce: entitlement revoked',
  ): Promise<{ removed: string[]; absent: string[]; retained: string[] }> {
    if (!roleIds.length) return { removed: [], absent: [], retained: [] };

    const uniqueRoleIds = [...new Set(roleIds)];
    if (
      uniqueRoleIds.length !== roleIds.length
      || uniqueRoleIds.some((roleId) =>
        typeof roleId !== 'string' || roleId.length === 0 || roleId.trim() !== roleId)
    ) {
      throw new Error('non-commerce role snapshot is malformed');
    }

    const retained = new Set<string>();
    for (const roleId of uniqueRoleIds) {
      const ownerState = await this.classifyOtherLiveRoleOwner(
        discordId,
        roleId,
        exclusions,
      );
      if (ownerState === 'pending') {
        // Finish the complete preflight before any Discord mutation. A
        // provisional delivery may be between its DB reservation and Discord
        // confirmation, so cleanup must retry after it resolves.
        throw new Error(`role ownership for ${roleId} is pending; cleanup deferred`);
      }
      if (ownerState === 'confirmed') {
        retained.add(roleId);
      }
    }

    let member = await this.guild.members.fetch({ user: discordId, force: true });
    const removed: string[] = [];
    const absent: string[] = [];

    // A role protected by another exact live owner is required access, not
    // merely an instruction to skip removal. Repair it before any destructive
    // mutation so a prior crashed attempt cannot leave that owner unserved.
    for (const roleId of [...retained]) {
      const repairedState = await this.repairConfirmedRole(
        discordId,
        roleId,
        exclusions,
        'Commerce: repair exact retained role owner',
      );
      if (repairedState === 'pending') {
        throw new Error(`role ownership for ${roleId} became pending; cleanup deferred`);
      }
      if (repairedState === 'none') retained.delete(roleId);
    }
    member = await this.guild.members.fetch({ user: discordId, force: true });

    for (const roleId of uniqueRoleIds) {
      if (retained.has(roleId)) continue;
      if (member.roles.cache.has(roleId)) {
        try {
          // Discord can commit the mutation and still reject locally if its
          // response is lost. Treat the entire remove/confirm boundary as
          // uncertain until the forced read-back proves absence.
          await member.roles.remove(roleId, removalReason);
          member = await this.guild.members.fetch({ user: discordId, force: true });
          if (member.roles.cache.has(roleId)) {
            throw new Error(`Discord did not confirm revoked role ${roleId}`);
          }
        } catch (removalError) {
          try {
            if (
              await this.classifyOtherLiveRoleOwner(discordId, roleId, exclusions)
                === 'confirmed'
            ) {
              await this.repairConfirmedRole(
                discordId,
                roleId,
                exclusions,
                'Commerce: repair confirmed owner after removal uncertainty',
              );
            }
          } catch {
            // Pending, none, unknown, and failed confirmation never authorize
            // restoring access. Preserve the original removal failure.
          }
          throw new Error(
            `Discord removal confirmation failed for ${roleId} (${String(removalError)})`,
          );
        }
        removed.push(roleId);
      } else {
        absent.push(roleId);
      }

      let otherOwnerState: LiveRoleOwnerState;
      try {
        otherOwnerState = await this.classifyOtherLiveRoleOwner(
          discordId,
          roleId,
          exclusions,
        );
      } catch (ownerLookupError) {
        throw ownerLookupError;
      }

      if (otherOwnerState === 'pending') {
        throw new Error(`role ownership for ${roleId} became pending; cleanup deferred`);
      }

      if (otherOwnerState === 'confirmed') {
        otherOwnerState = await this.repairConfirmedRole(
          discordId,
          roleId,
          exclusions,
          'Commerce: repair role for concurrent exact owner',
        );
        if (otherOwnerState === 'pending') {
          throw new Error(`role ownership for ${roleId} became pending; cleanup deferred`);
        }
        if (otherOwnerState === 'confirmed') {
          retained.add(roleId);
          const removedIndex = removed.indexOf(roleId);
          if (removedIndex >= 0) removed.splice(removedIndex, 1);
          const absentIndex = absent.indexOf(roleId);
          if (absentIndex >= 0) absent.splice(absentIndex, 1);
        }
        member = await this.guild.members.fetch({ user: discordId, force: true });
      }
    }
    return { removed, absent, retained: [...retained] };
  }
}
