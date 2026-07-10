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
import { createLogger } from '@somnibot/shared';

const log = createLogger('Reconciliation');

/**
 * V11 Audit H-2: Page size for cursor-based pagination.
 * Replaces the old `.limit(1000)` hard cap that silently skipped data.
 */
const PAGE_SIZE = 1_000;

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
      guild_id: guild.id,
      trigger,
      status: 'running',
    })
    .select('id')
    .single();

  const runId = run?.id;
  log.info(`Starting ${trigger} run ${runId ?? 'unknown'}`);

  try {
    // ── 1. Check active entitlements → Discord roles ──
    // V5 audit 5.1/14.1 — JOIN instead of N+1 per-entitlement customer lookup
    // V11 Audit H-2: Cursor-based pagination to avoid silently skipping rows.
    // W2: isolated in its own try/catch — a failure sweeping active
    // entitlements must never prevent the grace-expiry sweep below from
    // running, or lapsed grace_period rows would sit unreconciled forever.
    try {
      let offset = 0;
      let hasMore = true;
      while (hasMore) {
        const { data: page } = await supabase
          .from('entitlements')
          .select('id, customer_id, granted_role_ids, product_id, customers(discord_id)')
          .eq('guild_id', guild.id)
          .eq('status', 'active')
          .range(offset, offset + PAGE_SIZE - 1);

        const rows = page ?? [];
        hasMore = rows.length === PAGE_SIZE;
        offset += PAGE_SIZE;

        for (const ent of rows) {
          findings.entitlements_checked++;
          const roleIds = ent.granted_role_ids ?? [];
          if (!roleIds.length) continue;

          const custJoin = Array.isArray(ent.customers) ? ent.customers[0] : ent.customers;
          const discordId = (custJoin as { discord_id: string } | null)?.discord_id;
          if (!discordId) continue;

          try {
            const member = await guild.members.fetch(discordId);

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
      } // end while
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      findings.errors.push(`Active entitlement sweep failed: ${msg}`);
    }

    // ── 2. Expire grace periods that have ended ──
    // V11 Audit H-2: Cursor-based pagination.
    // W2: deterministic revocation — status-guarded transition (never
    // clobbers a concurrent reactivation), audit trail per entitlement,
    // operator alert resolution, and durable (queued) role revocation when
    // the inline removal fails.
    const now = new Date().toISOString();
    {
      let offset = 0;
      let hasMore = true;
      const allGracePeriod: Array<{
        id: string;
        customer_id: string;
        granted_role_ids: string[] | null;
        product_id: string | null;
        license_key_id: string | null;
        grace_period_ends_at: string | null;
      }> = [];

      while (hasMore) {
        const { data: gracePage, error: graceError } = await supabase
          .from('entitlements')
          .select('id, customer_id, granted_role_ids, product_id, license_key_id, grace_period_ends_at')
          .eq('guild_id', guild.id)
          .eq('status', 'grace_period')
          .lt('grace_period_ends_at', now)
          .range(offset, offset + PAGE_SIZE - 1);

        if (graceError) {
          findings.errors.push(`Grace-period query failed: ${graceError.message}`);
          break;
        }

        const rows = gracePage ?? [];
        for (const r of rows) allGracePeriod.push(r);
        hasMore = rows.length === PAGE_SIZE;
        offset += PAGE_SIZE;
      }

      if (allGracePeriod.length > 0) {
        // V11 Audit M-1: Batch customer lookup instead of N+1 per-entitlement.
        const graceCustomerIds = [...new Set(allGracePeriod.map((e) => e.customer_id).filter(Boolean))];
        const customerMap = new Map<string, string>();
        if (graceCustomerIds.length > 0) {
          const { data: customers } = await supabase
            .from('customers')
            .select('id, discord_id')
            .in('id', graceCustomerIds);
          for (const c of customers ?? []) {
            if (c.discord_id) customerMap.set(c.id, c.discord_id);
          }
        }

        for (const ent of allGracePeriod) {
          // Expire the entitlement. Guarded on the current status so a
          // payment that recovered between the page query and this update
          // (reactivate → 'active') is never clobbered back to expired.
          const { data: transitioned, error: expireError } = await supabase
            .from('entitlements')
            .update({
              status: 'expired',
              updated_at: now,
            })
            .eq('id', ent.id)
            .eq('status', 'grace_period')
            .select('id');

          if (expireError) {
            findings.errors.push(`Entitlement ${ent.id}: expire failed: ${expireError.message}`);
            continue;
          }
          if (!transitioned || transitioned.length === 0) {
            // Concurrently reactivated (or already transitioned) — skip.
            continue;
          }

          findings.grace_periods_expired++;

          const discordId = customerMap.get(ent.customer_id);
          const roleIds = ent.granted_role_ids ?? [];

          // Audit trail for the automatic revocation.
          const { error: auditError } = await supabase.from('audit_logs').insert({
            guild_id: guild.id,
            actor_type: 'system',
            actor_id: 'reconciliation',
            action: 'entitlement.grace_expired',
            target_type: 'entitlement',
            target_id: ent.id,
            details: {
              reason: 'grace_period_expired',
              customer_id: ent.customer_id,
              product_id: ent.product_id,
              discord_id: discordId ?? null,
              role_ids: roleIds,
              grace_period_ends_at: ent.grace_period_ends_at,
            },
          });
          if (auditError) {
            findings.errors.push(`Entitlement ${ent.id}: audit log failed: ${auditError.message}`);
          }

          // Deactivate the entitlement's live license sessions — parity with
          // EntitlementService.revoke. Validation/heartbeat already reject a
          // revoked entitlement, but the session rows must not claim to be
          // active for up to a day until the heartbeat-timeout reaper runs.
          // NOTE: license_sessions has no guild_id column — the key id (from
          // a guild-scoped entitlement) is the scope.
          if (ent.license_key_id) {
            const { error: sessionError } = await supabase
              .from('license_sessions')
              .update({
                active: false,
                deactivated_at: now,
                deactivation_reason: 'entitlement_revoked',
              })
              .eq('license_key_id', ent.license_key_id)
              .eq('active', true);
            if (sessionError) {
              findings.errors.push(
                `Entitlement ${ent.id}: session deactivation failed: ${sessionError.message}`,
              );
            }
          }

          // Terminal state reached — resolve the operator "in grace" alert.
          const { error: alertError } = await supabase
            .from('alerts')
            .update({ resolved: true, resolved_at: now, updated_at: now })
            .eq('guild_id', guild.id)
            .eq('alert_type', 'entitlement_grace_period')
            .eq('metadata->>entitlement_id', ent.id)
            .eq('resolved', false);
          if (alertError) {
            findings.errors.push(`Entitlement ${ent.id}: alert resolve failed: ${alertError.message}`);
          }

          // Revoke roles inline; anything that fails is queued as a durable
          // `revoke_roles` bot action instead of being dropped. The row is
          // already 'expired' so this sweep will never see it again — a
          // silently dropped removal here would leave the paid role granted
          // forever.
          if (!roleIds.length) continue;
          if (!discordId) continue;

          const failedRoleIds: string[] = [];
          try {
            const member = await guild.members.fetch(discordId);
            for (const roleId of roleIds) {
              if (member.roles.cache.has(roleId)) {
                try {
                  await member.roles.remove(roleId, 'Reconciliation: grace period expired');
                } catch {
                  failedRoleIds.push(roleId);
                }
              }
            }
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            if (msg.includes('Unknown Member') || msg.includes('not found')) {
              // Member left the guild — their roles went with the membership.
            } else {
              failedRoleIds.push(...roleIds);
            }
          }

          if (failedRoleIds.length > 0) {
            const { error: queueError } = await supabase.from('bot_action_queue').insert({
              guild_id: guild.id,
              action: 'revoke_roles',
              payload: {
                discord_id: discordId,
                role_ids: failedRoleIds,
                reason: 'grace_period_expired',
                entitlement_id: ent.id,
              },
              status: 'pending',
            });
            if (queueError) {
              findings.errors.push(
                `Entitlement ${ent.id}: failed to queue role revocation: ${queueError.message}`,
              );
            }
          }
        }
      }
    } // end block

    // ── 3. Timeout stale license sessions ──
    // V11 Audit H-2: Cursor-based pagination.
    {
      let offset = 0;
      let hasMore = true;
      const allStaleSessions: Array<{
        id: string;
        last_seen_at: string;
        license_key_id: string;
        license_keys: { product_id: string } | { product_id: string }[];
      }> = [];

      while (hasMore) {
        const { data: sessionPage } = await supabase
          .from('license_sessions')
          .select(`
            id,
            last_seen_at,
            license_key_id,
            license_keys!inner(product_id)
          `)
          .eq('active', true)
          .range(offset, offset + PAGE_SIZE - 1);

        const rows = (sessionPage ?? []) as typeof allStaleSessions;
        for (const r of rows) allStaleSessions.push(r);
        hasMore = rows.length === PAGE_SIZE;
        offset += PAGE_SIZE;
      }

      if (allStaleSessions.length > 0) {
        // Pre-fetch all product license configs to avoid N+1 queries (Finding #5)
        const productIds = [
          ...new Set(
            allStaleSessions
              .map((s) => {
                const lk = Array.isArray(s.license_keys) ? s.license_keys[0] : s.license_keys;
                return (lk as { product_id: string })?.product_id;
              })
              .filter(Boolean),
          ),
        ];
        const configMap = new Map<string, number>();
        if (productIds.length > 0) {
          const { data: configs } = await supabase
            .from('product_license_config')
            .select('product_id, offline_grace_period_seconds')
            .in('product_id', productIds);
          for (const c of configs ?? []) {
            configMap.set(c.product_id, c.offline_grace_period_seconds);
          }
        }

        for (const session of allStaleSessions) {
          const lkJoin = Array.isArray(session.license_keys) ? session.license_keys[0] : session.license_keys;
          const productId = (lkJoin as { product_id: string })?.product_id;
          if (!productId) continue;

          const gracePeriodSeconds = configMap.get(productId) ?? 86400;
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
    } // end block

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

    log.info(
      `[Reconciliation] Completed: ${findings.entitlements_checked} checked, ` +
      `${findings.roles_regranted} roles re-granted, ` +
      `${findings.grace_periods_expired} grace periods expired, ` +
      `${findings.sessions_timed_out} sessions timed out`,
    );
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    log.error(`Error: ${errMsg}`);
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
    runReconciliation(guild, supabase, 'startup').catch((e) => log.error("Unhandled error", { error: String(e) }));
  }, 30_000);

  // Then every 6 hours
  return setInterval(() => {
    runReconciliation(guild, supabase, 'scheduled').catch((e) => log.error("Unhandled error", { error: String(e) }));
  }, SIX_HOURS);
}
