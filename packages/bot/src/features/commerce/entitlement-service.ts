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

    // Grant Discord roles
    await this.grantRoles(opts.discordId, opts.grantedRoleIds);

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

    // Get customer discord_id — scoped to guild_id
    const { data: customer } = await this.supabase
      .from('customers')
      .select('discord_id')
      .eq('id', ent.customer_id)
      .eq('guild_id', guildId)
      .single();

    const discordId = customer?.discord_id;
    if (discordId) {
      // Revoke Discord roles
      await this.revokeRoles(discordId, ent.granted_role_ids ?? []);

      // Fire event
      this.eventBus.emit('entitlement.revoked', guildId, {
        discordId,
        entitlementId,
        productId: ent.product_id,
        productName: ent.products?.name ?? 'Unknown',
        reason,
      });
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
    const { error: alertError } = await this.supabase.from('alerts').insert({
      guild_id: guildId,
      alert_type: 'entitlement_grace_period',
      severity: 'warning',
      title: 'Paid entitlement entered payment grace period',
      message:
        `Entitlement ${entitlementId} entered a payment-failure grace period ending ` +
        `${gracePeriodEnds.toISOString()}. If payment is not recovered by then, ` +
        'access will be revoked automatically.',
      metadata: {
        entitlement_id: entitlementId,
        customer_id: ent.customer_id,
        product_id: ent.product_id,
        order_id: ent.order_id,
        grace_period_ends_at: gracePeriodEnds.toISOString(),
        source: 'entitlement_service.suspend',
      },
    });
    if (alertError && alertError.code !== '23505') {
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

    const { data: ent } = await this.supabase
      .from('entitlements')
      .select('*')
      .eq('id', entitlementId)
      .eq('guild_id', guildId)
      .single();

    if (!ent) return false;

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
    const { data: customer } = await this.supabase
      .from('customers')
      .select('discord_id')
      .eq('id', ent.customer_id)
      .single();

    if (customer?.discord_id) {
      await this.grantRoles(customer.discord_id, ent.granted_role_ids ?? []);
    }

    log.info(`Entitlement reactivated: ${entitlementId}`);
    return true;
  }

  // ── Role helpers ──────────────────────────────────

  private async grantRoles(discordId: string, roleIds: string[]): Promise<void> {
    if (!roleIds.length) return;
    try {
      const member = await this.guild.members.fetch(discordId);
      for (const roleId of roleIds) {
        if (!member.roles.cache.has(roleId)) {
          await member.roles.add(roleId, 'Commerce: entitlement granted');
        }
      }
    } catch (err) {
      log.error(`Failed to grant roles to ${discordId}:`, err);
    }
  }

  private async revokeRoles(discordId: string, roleIds: string[]): Promise<void> {
    if (!roleIds.length) return;
    try {
      const member = await this.guild.members.fetch(discordId);
      for (const roleId of roleIds) {
        if (member.roles.cache.has(roleId)) {
          await member.roles.remove(roleId, 'Commerce: entitlement revoked');
        }
      }
    } catch (err) {
      log.error(`Failed to revoke roles from ${discordId}:`, err);
    }
  }
}
