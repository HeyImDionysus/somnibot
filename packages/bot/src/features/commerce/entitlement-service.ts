/**
 * Entitlement Service — Grant, revoke, and manage product entitlements.
 *
 * Handles the lifecycle: PENDING → ACTIVE → EXPIRED/CANCELLED/SUSPENDED/REVOKED
 * Grants/revokes Discord roles on status changes.
 */
import type { Guild, GuildMember } from 'discord.js';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { PlatformEventBus } from '../../services/event-bus.js';
import { createLogger } from '@somnibot/shared';

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
  source: 'purchase' | 'giveaway' | 'manual' | 'automation';
  grantedRoleIds: string[];
  grantedChannelIds: string[];
  expiresAt?: string | null;
}

export class EntitlementService {
  constructor(
    private guild: Guild,
    private supabase: SupabaseClient,
    private eventBus: PlatformEventBus,
  ) {}

  /**
   * Grant a new entitlement — creates DB record and adds Discord roles.
   */
  async grant(opts: EntitlementGrantOptions): Promise<string | null> {
    const guildId = this.guild.id;

    // Create entitlement record
    const { data: entitlement, error } = await this.supabase
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

    if (error || !entitlement) {
      log.error('Failed to create entitlement:', error?.message);
      return null;
    }

    // Discord delivery is part of successful fulfillment. The entitlement row
    // is deliberately durable first, so a queue retry can find this exact
    // order-scoped row and idempotently repair any missing roles. Do not report
    // success until a fresh Discord read confirms every purchased role.
    await this.ensureGrantedRoles(opts.discordId, opts.grantedRoleIds);

    // Fire event
    this.eventBus.emit('entitlement.granted', guildId, {
      discordId: opts.discordId,
      entitlementId: entitlement.id,
      productId: opts.productId,
      productName: opts.productName,
      roleIds: opts.grantedRoleIds,
    });

    // Audit log
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
    reason: 'expired' | 'cancelled' | 'suspended' | 'revoked' | 'refund',
  ): Promise<boolean> {
    const guildId = this.guild.id;

    // Fetch entitlement — scoped to guild_id to prevent cross-guild access
    const { data: ent } = await this.supabase
      .from('entitlements')
      .select('*, products(name)')
      .eq('id', entitlementId)
      .eq('guild_id', guildId)
      .single();

    if (!ent) {
      log.error('Entitlement not found:', entitlementId);
      return false;
    }

    // Determine new status
    const statusMap: Record<string, string> = {
      expired: 'expired',
      cancelled: 'cancelled',
      suspended: 'suspended',
      revoked: 'expired', // forced revoke → expired
      refund: 'expired',
    };
    const newStatus = statusMap[reason] ?? 'expired';

    // Update DB — scoped to guild_id
    const { error } = await this.supabase
      .from('entitlements')
      .update({
        status: newStatus,
        cancelled_at: reason === 'cancelled' ? new Date().toISOString() : undefined,
        updated_at: new Date().toISOString(),
      })
      .eq('id', entitlementId)
      .eq('guild_id', guildId);

    if (error) {
      log.error('Failed to revoke entitlement:', error.message);
      return false;
    }

    // W2 review: revoke() is a terminal transition for grace_period rows
    // (subscription cancellation and refunds select them), and every target
    // status above is non-grace — so an unresolved 'entitlement_grace_period'
    // operator alert raised by suspend() is now stale. Resolve it with the
    // same entitlement-scoped filters as reactivate() and the reconciliation
    // sweep (a no-op when none exists). Non-fatal: the revocation committed.
    const { error: graceAlertError } = await this.supabase
      .from('alerts')
      .update({
        resolved: true,
        resolved_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('guild_id', guildId)
      .eq('alert_type', 'entitlement_grace_period')
      .eq('metadata->>entitlement_id', entitlementId)
      .eq('resolved', false);
    if (graceAlertError) {
      log.error('Failed to resolve grace-period alert on revoke:', graceAlertError.message);
    }

    // Get customer discord_id — scoped to guild_id
    const { data: customer, error: customerError } = await this.supabase
      .from('customers')
      .select('id, guild_id, discord_id')
      .eq('id', ent.customer_id)
      .eq('guild_id', guildId)
      .maybeSingle();

    const customerIdentityValid = !customerError
      && customer?.id === ent.customer_id
      && customer?.guild_id === guildId
      && typeof customer?.discord_id === 'string'
      && customer.discord_id.length > 0;
    const discordId = customerIdentityValid ? customer.discord_id : null;
    // Paid entitlement terminal transitions are protected by
    // commerce_entitlements_enqueue_role_revocation: the status update above
    // and an exact, retryable revoke_roles intent commit in one transaction.
    // Removing here as well would bypass the action handler's shared-owner
    // preflight and could strip a role that another live entitlement still
    // grants. Non-commerce entitlements are not covered by that trigger and
    // retain the direct removal path.
    const usesDurablePaidRoleRevocation = ent.source == null || ent.source === 'purchase';
    if (discordId) {
      if (!usesDurablePaidRoleRevocation) {
        try {
          await this.revokeRolesSafely(
            ent.customer_id,
            discordId,
            ent.granted_role_ids ?? [],
          );
        } catch (err) {
          log.error(`Failed to revoke non-commerce roles for ${discordId}:`, err);
          return false;
        }
      }

      // Fire event
      this.eventBus.emit('entitlement.revoked', guildId, {
        discordId,
        entitlementId,
        productId: ent.product_id,
        productName: ent.products?.name ?? 'Unknown',
        reason,
      });
    } else if (!usesDurablePaidRoleRevocation && (ent.granted_role_ids ?? []).length > 0) {
      log.error('Cannot verify non-commerce customer identity for role revocation:', {
        entitlementId,
        detail: customerError?.message ?? 'missing or mismatched customer',
      });
      return false;
    }

    // Also revoke associated license sessions. NOTE: license_sessions has no
    // guild_id column — the key id (from the guild-scoped entitlement fetched
    // above) is the scope. The previous `.eq('guild_id', ...)` filter made
    // PostgREST reject this whole update, and the unchecked error meant every
    // session of a revoked entitlement silently stayed active.
    if (ent.license_key_id) {
      const { error: sessionError } = await this.supabase
        .from('license_sessions')
        .update({
          active: false,
          deactivated_at: new Date().toISOString(),
          deactivation_reason: 'entitlement_revoked',
        })
        .eq('license_key_id', ent.license_key_id)
        .eq('active', true);
      if (sessionError) {
        // Non-fatal: the entitlement status + roles are already revoked and
        // validation/heartbeat reject on entitlement status.
        log.error('Failed to deactivate license sessions:', sessionError.message);
      }
    }

    // Audit log
    await this.supabase.from('audit_logs').insert({
      guild_id: guildId,
      actor_type: 'system',
      actor_id: 'commerce',
      action: 'entitlement.revoked',
      target_type: 'entitlement',
      target_id: entitlementId,
      details: { discordId, reason, productId: ent.product_id },
    });

    log.info(`Entitlement revoked: ${entitlementId} (${reason})`);
    return true;
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
    const { error: alertError } = await this.supabase.from('alerts').insert({
      guild_id: guildId,
      alert_type: 'entitlement_grace_period',
      severity: 'warning',
      title: 'Paid entitlement entered payment grace period',
      message: alertMessage,
      metadata: alertMetadata,
    });
    if (alertError && alertError.code === '23505') {
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
    } else if (alertError) {
      log.error('Failed to write grace-period alert:', alertError.message);
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
   * Reactivate a suspended/grace entitlement.
   */
  async reactivate(entitlementId: string): Promise<boolean> {
    const guildId = this.guild.id;

    const { data: ent, error: entitlementError } = await this.supabase
      .from('entitlements')
      .select('*')
      .eq('id', entitlementId)
      .eq('guild_id', guildId)
      .single();

    if (entitlementError || !ent) {
      log.error('Failed to load entitlement for reactivation:', entitlementError?.message);
      return false;
    }

    const { error } = await this.supabase
      .from('entitlements')
      .update({
        status: 'active',
        grace_period_ends_at: null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', entitlementId)
      .eq('guild_id', guildId);

    if (error) {
      log.error('Failed to reactivate entitlement:', error.message);
      return false;
    }

    // Payment recovered — resolve the outstanding grace-period operator
    // alert so it does not linger as stale churn noise. Non-fatal.
    const { error: alertError } = await this.supabase
      .from('alerts')
      .update({ resolved: true, resolved_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq('guild_id', guildId)
      .eq('alert_type', 'entitlement_grace_period')
      .eq('metadata->>entitlement_id', entitlementId)
      .eq('resolved', false);
    if (alertError) {
      log.error('Failed to resolve grace-period alert:', alertError.message);
    }

    // Re-grant roles
    const { data: customer, error: customerError } = await this.supabase
      .from('customers')
      .select('id, guild_id, discord_id')
      .eq('id', ent.customer_id)
      .eq('guild_id', guildId)
      .maybeSingle();

    if (
      customerError
      || !customer
      || customer.id !== ent.customer_id
      || customer.guild_id !== guildId
      || typeof customer.discord_id !== 'string'
      || customer.discord_id.length === 0
    ) {
      throw new Error(
        `Failed to verify customer identity for entitlement reactivation: ${customerError?.message ?? 'missing or mismatched customer'}`,
      );
    }
    await this.ensureGrantedRoles(customer.discord_id, ent.granted_role_ids ?? []);

    log.info(`Entitlement reactivated: ${entitlementId}`);
    return true;
  }

  // ── Role helpers ──────────────────────────────────

  async ensureGrantedRoles(discordId: string, roleIds: string[]): Promise<void> {
    if (!roleIds.length) return;

    let member = await this.guild.members.fetch({ user: discordId, force: true });
    for (const roleId of [...new Set(roleIds)]) {
      if (!member.roles.cache.has(roleId)) {
        await member.roles.add(roleId, 'Commerce: entitlement granted');
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

  private async ensureRolePresentAndConfirm(
    discordId: string,
    roleId: string,
    reason: string,
  ) {
    let member = await this.guild.members.fetch({ user: discordId, force: true });
    if (!member.roles.cache.has(roleId)) {
      await member.roles.add(roleId, reason);
      member = await this.guild.members.fetch({ user: discordId, force: true });
    }
    if (!member.roles.cache.has(roleId)) {
      throw new Error(`Discord did not confirm retained role ${roleId}`);
    }
    return member;
  }

  private async hasOtherLiveRoleOwner(
    customerId: string,
    discordId: string,
    roleId: string,
  ): Promise<boolean> {
    const { data: entitlementOwners, error: entitlementError } = await this.supabase
      .from('entitlements')
      .select('id, guild_id, customer_id, status, granted_role_ids')
      .eq('guild_id', this.guild.id)
      .eq('customer_id', customerId)
      .in('status', ['active', 'pending', 'grace_period', 'suspended'])
      .contains('granted_role_ids', [roleId])
      .order('id', { ascending: true })
      .limit(1);
    if (entitlementError) {
      throw new Error(`entitlement ownership lookup failed: ${entitlementError.message}`);
    }
    if (!Array.isArray(entitlementOwners) || entitlementOwners.length > 1) {
      throw new Error('entitlement ownership lookup returned malformed data');
    }
    if (entitlementOwners.length === 1) {
      const owner = entitlementOwners[0];
      if (
        typeof owner?.id !== 'string'
        || owner.id.length === 0
        || owner.guild_id !== this.guild.id
        || owner.customer_id !== customerId
        || typeof owner.status !== 'string'
        || !['active', 'pending', 'grace_period', 'suspended'].includes(owner.status)
        || !Array.isArray(owner.granted_role_ids)
        || !owner.granted_role_ids.every((value) => typeof value === 'string')
        || !owner.granted_role_ids.includes(roleId)
      ) {
        throw new Error('entitlement ownership lookup returned a mismatched row');
      }
      return true;
    }

    const nowIso = new Date().toISOString();
    const { data: tempOwners, error: tempError } = await this.supabase
      .from('temp_role_grants')
      .select('id, guild_id, user_id, role_id, expires_at, grant_status')
      .eq('guild_id', this.guild.id)
      .eq('user_id', discordId)
      .eq('role_id', roleId)
      .in('grant_status', ['pending', 'applied'])
      .gt('expires_at', nowIso)
      .order('id', { ascending: true })
      .limit(1);
    if (tempError) throw new Error(`temporary ownership lookup failed: ${tempError.message}`);
    if (!Array.isArray(tempOwners) || tempOwners.length > 1) {
      throw new Error('temporary ownership lookup returned malformed data');
    }
    if (tempOwners.length === 0) return false;
    const owner = tempOwners[0];
    if (
      typeof owner?.id !== 'string'
      || owner.id.length === 0
      || owner.guild_id !== this.guild.id
      || owner.user_id !== discordId
      || owner.role_id !== roleId
      || typeof owner.expires_at !== 'string'
      || Date.parse(owner.expires_at) <= Date.parse(nowIso)
      || (owner.grant_status !== 'pending' && owner.grant_status !== 'applied')
    ) {
      throw new Error('temporary ownership lookup returned a mismatched row');
    }
    return true;
  }

  private async revokeRolesSafely(
    customerId: string,
    discordId: string,
    roleIds: string[],
  ): Promise<void> {
    if (!roleIds.length) return;

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
      if (await this.hasOtherLiveRoleOwner(customerId, discordId, roleId)) {
        retained.add(roleId);
      }
    }

    let member = await this.guild.members.fetch({ user: discordId, force: true });
    for (const roleId of retained) {
      if (!member.roles.cache.has(roleId)) {
        member = await this.ensureRolePresentAndConfirm(
          discordId,
          roleId,
          'Commerce: repair shared role during entitlement revocation',
        );
      }
    }

    for (const roleId of uniqueRoleIds) {
      if (retained.has(roleId)) continue;
      if (member.roles.cache.has(roleId)) {
        await member.roles.remove(roleId, 'Commerce: entitlement revoked');
        member = await this.guild.members.fetch({ user: discordId, force: true });
        if (member.roles.cache.has(roleId)) {
          throw new Error(`Discord did not confirm revoked role ${roleId}`);
        }
      }

      try {
        if (await this.hasOtherLiveRoleOwner(customerId, discordId, roleId)) {
          member = await this.ensureRolePresentAndConfirm(
            discordId,
            roleId,
            'Commerce: repair concurrent shared role owner',
          );
        }
      } catch (err) {
        try {
          member = await this.ensureRolePresentAndConfirm(
            discordId,
            roleId,
            'Commerce: preserve role during ownership uncertainty',
          );
        } catch {
          // Preserve the original ownership failure as the retry reason.
        }
        throw err;
      }
    }
  }
}
