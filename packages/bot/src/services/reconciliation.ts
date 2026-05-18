/**
 * Entitlement Reconciliation Service (Phase B.4)
 *
 * Periodic job that verifies entitlements ↔ Discord roles are in sync.
 * - Checks active entitlements → ensures Discord roles are present, re-grants if missing.
 * - Checks grace_period entitlements → expires if grace period ended.
 * - Checks active license sessions → expires if heartbeat timeout exceeded.
 * - Logs all findings and fixes to `reconciliation_runs` table.
 */

import type { Guild } from 'discord.js';
import type { SupabaseClient } from '@supabase/supabase-js';

interface ReconciliationFindings {
  entitlements_checked: number;
  roles_missing: number;
  roles_regranted: number;
  grace_periods_expired: number;
  sessions_timed_out: number;
  errors: string[];
}

/**
 * Run a full entitlement reconciliation pass.
 */
export async function runReconciliation(
  guild: Guild,
  supabase: SupabaseClient,
  trigger: 'scheduled' | 'manual' | 'startup' = 'scheduled',
): Promise<ReconciliationFindings> {
  const findings: ReconciliationFindings = {
    entitlements_checked: 0,
    roles_missing: 0,
    roles_regranted: 0,
    grace_periods_expired: 0,
    sessions_timed_out: 0,
    errors: [],
  };

  // Create a reconciliation run record
  const { data: run } = await supabase
    .from('reconciliation_runs')
    .insert({
      trigger,
      status: 'running',
    })
    .select('id')
    .single();

  const runId = run?.id;
  console.log(`[Reconciliation] Starting ${trigger} run ${runId ?? 'unknown'}`);

  try {
    // ── 1. Check active entitlements → Discord roles ──
    const { data: activeEntitlements } = await supabase
      .from('entitlements')
      .select('id, customer_id, granted_role_ids, product_id')
      .eq('guild_id', guild.id)
      .eq('status', 'active');

    if (activeEntitlements) {
      for (const ent of activeEntitlements) {
        findings.entitlements_checked++;
        const roleIds = ent.granted_role_ids ?? [];
        if (!roleIds.length) continue;

        // Get customer's Discord ID
        const { data: customer } = await supabase
          .from('customers')
          .select('discord_id')
          .eq('id', ent.customer_id)
          .single();

        if (!customer?.discord_id) continue;

        try {
          const member = await guild.members.fetch(customer.discord_id);

          for (const roleId of roleIds) {
            if (!member.roles.cache.has(roleId)) {
              // Role is missing — re-grant
              findings.roles_missing++;
              const role = guild.roles.cache.get(roleId);
              if (role) {
                await member.roles.add(roleId, 'Reconciliation: re-granting missing role');
                findings.roles_regranted++;
              }
            }
          }
        } catch (err) {
          // Member not in guild — that's okay, roles will be granted when they rejoin
          const msg = err instanceof Error ? err.message : String(err);
          if (!msg.includes('Unknown Member') && !msg.includes('not found')) {
            findings.errors.push(`Entitlement ${ent.id}: ${msg}`);
          }
        }
      }
    }

    // ── 2. Expire grace periods that have ended ──
    const now = new Date().toISOString();
    const { data: gracePeriodEntitlements } = await supabase
      .from('entitlements')
      .select('id, customer_id, granted_role_ids')
      .eq('guild_id', guild.id)
      .eq('status', 'grace_period')
      .lt('grace_period_ends_at', now);

    if (gracePeriodEntitlements) {
      for (const ent of gracePeriodEntitlements) {
        // Expire the entitlement
        await supabase
          .from('entitlements')
          .update({
            status: 'expired',
            updated_at: now,
          })
          .eq('id', ent.id);

        findings.grace_periods_expired++;

        // Revoke roles
        const roleIds = ent.granted_role_ids ?? [];
        if (!roleIds.length) continue;

        const { data: customer } = await supabase
          .from('customers')
          .select('discord_id')
          .eq('id', ent.customer_id)
          .single();

        if (customer?.discord_id) {
          try {
            const member = await guild.members.fetch(customer.discord_id);
            for (const roleId of roleIds) {
              if (member.roles.cache.has(roleId)) {
                await member.roles.remove(roleId, 'Reconciliation: grace period expired');
              }
            }
          } catch {
            // Member not in guild
          }
        }
      }
    }

    // ── 3. Timeout stale license sessions ──
    // Get all active sessions with their license config
    const { data: staleSessions } = await supabase
      .from('license_sessions')
      .select(`
        id,
        last_seen_at,
        license_key_id,
        license_keys!inner(product_id)
      `)
      .eq('active', true);

    if (staleSessions) {
      for (const session of staleSessions) {
        const productId = (session.license_keys as unknown as { product_id: string })?.product_id;
        if (!productId) continue;

        // Get offline grace period for this product
        const { data: config } = await supabase
          .from('product_license_config')
          .select('offline_grace_period_seconds')
          .eq('product_id', productId)
          .maybeSingle();

        const gracePeriodSeconds = config?.offline_grace_period_seconds ?? 86400;
        const lastSeen = new Date(session.last_seen_at).getTime();
        const nowMs = Date.now();

        if (nowMs - lastSeen > gracePeriodSeconds * 1000) {
          await supabase
            .from('license_sessions')
            .update({
              active: false,
              deactivated_at: new Date().toISOString(),
              deactivation_reason: 'heartbeat_timeout',
            })
            .eq('id', session.id);

          findings.sessions_timed_out++;
        }
      }
    }

    // ── Mark run as completed ──
    if (runId) {
      await supabase
        .from('reconciliation_runs')
        .update({
          status: 'completed',
          completed_at: new Date().toISOString(),
          findings,
          fixes_applied: {
            roles_regranted: findings.roles_regranted,
            grace_periods_expired: findings.grace_periods_expired,
            sessions_timed_out: findings.sessions_timed_out,
          },
        })
        .eq('id', runId);
    }

    console.log(
      `[Reconciliation] Completed: ${findings.entitlements_checked} checked, ` +
      `${findings.roles_regranted} roles re-granted, ` +
      `${findings.grace_periods_expired} grace periods expired, ` +
      `${findings.sessions_timed_out} sessions timed out`,
    );
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(`[Reconciliation] Error: ${errMsg}`);
    findings.errors.push(errMsg);

    if (runId) {
      await supabase
        .from('reconciliation_runs')
        .update({
          status: 'failed',
          completed_at: new Date().toISOString(),
          findings,
          error_message: errMsg,
        })
        .eq('id', runId);
    }
  }

  return findings;
}

/**
 * Schedule reconciliation to run every 6 hours.
 */
export function scheduleReconciliation(
  guild: Guild,
  supabase: SupabaseClient,
): NodeJS.Timeout {
  const SIX_HOURS = 6 * 60 * 60 * 1000;

  // Run once on startup (after a short delay for bot to fully initialize)
  setTimeout(() => {
    runReconciliation(guild, supabase, 'startup').catch(console.error);
  }, 30_000);

  // Then every 6 hours
  return setInterval(() => {
    runReconciliation(guild, supabase, 'scheduled').catch(console.error);
  }, SIX_HOURS);
}
