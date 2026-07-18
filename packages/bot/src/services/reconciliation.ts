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
const LOOKUP_CHUNK_SIZE = 500;

function isNonBlankString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.trim() === value;
}

function requireStrictKeysetPage<T extends { id: string }>(
  value: unknown,
  cursor: string | null,
  label: string,
): T[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} returned a malformed result`);
  }

  let previousId = cursor;
  for (const candidate of value) {
    if (
      !candidate
      || typeof candidate !== 'object'
      || typeof (candidate as { id?: unknown }).id !== 'string'
      || (candidate as { id: string }).id.length === 0
      || (candidate as { id: string }).id.trim() !== (candidate as { id: string }).id
      || (previousId !== null && (candidate as { id: string }).id <= previousId)
    ) {
      throw new Error(`${label} returned a malformed or non-increasing ID page`);
    }
    previousId = (candidate as { id: string }).id;
  }

  return value as T[];
}

function requireUniqueSortedIds(values: unknown[], label: string): string[] {
  if (!values.every(isNonBlankString)) {
    throw new Error(`${label} contains a malformed ID`);
  }
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

async function loadGraceCustomerMap(
  supabase: SupabaseClient,
  guildId: string,
  customerIds: string[],
): Promise<Map<string, string>> {
  const customerMap = new Map<string, string>();
  for (let index = 0; index < customerIds.length; index += LOOKUP_CHUNK_SIZE) {
    const chunk = customerIds.slice(index, index + LOOKUP_CHUNK_SIZE);
    const requested = new Set(chunk);
    const { data, error } = await supabase
      .from('customers')
      .select('id, guild_id, discord_id')
      .eq('guild_id', guildId)
      .in('id', chunk)
      .order('id', { ascending: true })
      .limit(chunk.length);
    if (error) throw new Error(`customer lookup failed: ${error.message}`);

    const rows = requireStrictKeysetPage<{
      id: string;
      guild_id: string;
      discord_id: string;
    }>(data, null, 'Grace customer lookup');
    if (rows.length !== chunk.length) {
      throw new Error('Grace customer lookup returned an incomplete result');
    }
    for (const row of rows) {
      if (
        !requested.has(row.id)
        || row.guild_id !== guildId
        || !isNonBlankString(row.discord_id)
        || customerMap.has(row.id)
      ) {
        throw new Error('Grace customer lookup returned a malformed or mismatched result');
      }
      customerMap.set(row.id, row.discord_id);
    }
  }
  return customerMap;
}

async function loadLicenseConfigMap(
  supabase: SupabaseClient,
  productIds: string[],
): Promise<Map<string, number>> {
  const configMap = new Map<string, number>();
  for (let index = 0; index < productIds.length; index += LOOKUP_CHUNK_SIZE) {
    const chunk = productIds.slice(index, index + LOOKUP_CHUNK_SIZE);
    const requested = new Set(chunk);
    const { data, error } = await supabase
      .from('product_license_config')
      .select('product_id, offline_grace_period_seconds')
      .in('product_id', chunk)
      .order('product_id', { ascending: true })
      .limit(chunk.length);
    if (error) throw new Error(`license config lookup failed: ${error.message}`);
    if (!Array.isArray(data)) {
      throw new Error('License config lookup returned a malformed result');
    }

    let previousProductId: string | null = null;
    for (const value of data) {
      const row = value as Record<string, unknown> | null;
      if (
        !row
        || !isNonBlankString(row.product_id)
        || !requested.has(row.product_id)
        || (previousProductId !== null && row.product_id <= previousProductId)
        || !Number.isSafeInteger(row.offline_grace_period_seconds)
        || Number(row.offline_grace_period_seconds) < 0
        || configMap.has(row.product_id)
      ) {
        throw new Error('License config lookup returned a malformed or mismatched result');
      }
      previousProductId = row.product_id;
      configMap.set(row.product_id, Number(row.offline_grace_period_seconds));
    }
  }
  return configMap;
}

interface ReconciliationFindings {
  entitlements_checked: number;
  roles_missing: number;
  roles_regranted: number;
  role_repairs_queued: number;
  role_cleanups_queued: number;
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
    role_repairs_queued: 0,
    role_cleanups_queued: 0,
    grace_periods_expired: 0,
    sessions_timed_out: 0,
    errors: [],
  };

  // Create a reconciliation run record
  const { data: run, error: runError } = await supabase
    .from('reconciliation_runs')
    .insert({
      guild_id: guild.id,
      trigger,
      status: 'running',
    })
    .select('id')
    .single();

  const runId = run?.id;
  if (runError || !isNonBlankString(runId)) {
    throw new Error(`Failed to create reconciliation run: ${runError?.message ?? 'missing run id'}`);
  }
  log.info(`Starting ${trigger} run ${runId ?? 'unknown'}`);

  try {
    // Re-enqueue only unresolved durable delivery intents. Settled tombstones
    // are historical evidence, not perpetual Discord removal authority.
    try {
      let intentCursor: string | null = null;
      while (true) {
        let intentQuery = supabase
          .from('commerce_role_delivery_intents')
          .select('id, guild_id, state')
          .eq('guild_id', guild.id)
          .in('state', ['cleanup_required', 'operator_required']);
        if (intentCursor !== null) intentQuery = intentQuery.gt('id', intentCursor);

        const { data: intentPage, error: intentPageError } = await intentQuery
          .order('id', { ascending: true })
          .limit(PAGE_SIZE);
        if (intentPageError) throw new Error(intentPageError.message);
        const intents: Array<{
          id: string;
          guild_id: string;
          state: string;
        }> = requireStrictKeysetPage(intentPage, intentCursor, 'Unresolved paid-role intent query');

        for (const intent of intents) {
          if (
            intent.guild_id !== guild.id
            || (intent.state !== 'cleanup_required' && intent.state !== 'operator_required')
          ) {
            throw new Error('Unresolved paid-role intent query returned mismatched evidence');
          }
          const { data: carrierValue, error: carrierError } = await (
            supabase.rpc as (
              fn: string,
              params: Record<string, unknown>,
            ) => ReturnType<typeof supabase.rpc>
          )('commerce_ensure_role_delivery_cleanup_action', {
            p_intent_id: intent.id,
          });
          if (carrierError) {
            throw new Error(`unresolved paid-role cleanup enqueue failed: ${carrierError.message}`);
          }
          const carrier = Array.isArray(carrierValue) ? carrierValue[0] : carrierValue;
          if (
            !carrier
            || typeof carrier !== 'object'
            || Array.isArray(carrier)
            || !isNonBlankString(carrier.action_id)
            || !['pending', 'processing'].includes(String(carrier.action_status))
          ) {
            throw new Error('unresolved paid-role cleanup carrier returned malformed evidence');
          }
          findings.role_cleanups_queued++;
        }

        if (intents.length < PAGE_SIZE) break;
        intentCursor = intents[intents.length - 1].id;
      }
    } catch (err) {
      findings.errors.push(
        `Unresolved paid-role intent sweep failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // ── 1. Check every access-retaining entitlement → Discord roles ──
    // V5 audit 5.1/14.1 — JOIN instead of N+1 per-entitlement customer lookup
    // V11 Audit H-2: Cursor-based pagination to avoid silently skipping rows.
    // W2: isolated in its own try/catch — a failure sweeping active
    // entitlements must never prevent the grace-expiry sweep below from
    // running, or lapsed grace_period rows would sit unreconciled forever.
    try {
      let cursor: string | null = null;
      while (true) {
        let query = supabase
          .from('entitlements')
          .select('id, customer_id, granted_role_ids, product_id, plan_id, order_id, type, status, source, customers(id, guild_id, discord_id)')
          .eq('guild_id', guild.id)
          .in('status', ['active', 'pending', 'grace_period', 'suspended']);
        if (cursor !== null) query = query.gt('id', cursor);

        const { data: page, error: pageError } = await query
          .order('id', { ascending: true })
          .limit(PAGE_SIZE);
        if (pageError) throw new Error(pageError.message);

        const rows: Array<{
          id: string;
          customer_id: string;
          granted_role_ids: string[] | null;
          product_id: string | null;
          plan_id: string | null;
          order_id: string | null;
          type: string;
          status: string;
          source: string | null;
          customers: { id: string; guild_id: string; discord_id: string }
            | Array<{ id: string; guild_id: string; discord_id: string }>
            | null;
        }> = requireStrictKeysetPage(page, cursor, 'Active entitlement query');

        if (rows.length === 0) break;

        for (const ent of rows) {
          findings.entitlements_checked++;
          const roleIds = ent.granted_role_ids ?? [];
          if (
            !Array.isArray(roleIds)
            || roleIds.some((roleId) => !isNonBlankString(roleId))
            || new Set(roleIds).size !== roleIds.length
          ) {
            findings.errors.push(
              `Entitlement ${ent.id}: granted role snapshot is malformed`,
            );
            continue;
          }
          if (!roleIds.length) continue;

          const customerRows = Array.isArray(ent.customers)
            ? ent.customers
            : ent.customers ? [ent.customers] : [];
          if (
            customerRows.length !== 1
            || customerRows[0]?.id !== ent.customer_id
            || customerRows[0]?.guild_id !== guild.id
            || !isNonBlankString(customerRows[0]?.discord_id)
          ) {
            findings.errors.push(
              `Entitlement ${ent.id}: active customer identity is missing or malformed`,
            );
            continue;
          }
          const discordId = customerRows[0].discord_id;

          try {
            let member = await guild.members.fetch({ user: discordId, force: true });
            const missingRoleIds = roleIds.filter((roleId) => !member.roles.cache.has(roleId));
            findings.roles_missing += missingRoleIds.length;
            if (missingRoleIds.length === 0) continue;

            for (const roleId of missingRoleIds) {
              if (!guild.roles.cache.get(roleId)) {
                findings.errors.push(
                  `Entitlement ${ent.id}: configured guild role ${roleId} is unavailable`,
                );
              }
            }

            const isPaidOrUnclassified = ent.source === 'purchase' || ent.source === null;
            if (isPaidOrUnclassified) {
              // Source-null rows are not presumed paid. This security-definer
              // classifier re-proves the exact order/payment/snapshot/customer
              // contract and converges on one deterministic queue carrier.
              // No row means no current paid repair authority, so Discord is
              // intentionally left untouched.
              const { data: carrierValue, error: carrierError } = await (
                supabase.rpc as (
                  fn: string,
                  params: Record<string, unknown>,
                ) => ReturnType<typeof supabase.rpc>
              )('commerce_ensure_live_role_delivery_action', {
                p_entitlement_id: ent.id,
              });
              if (carrierError) {
                throw new Error(`paid role repair classifier failed: ${carrierError.message}`);
              }
              const carrier = Array.isArray(carrierValue) ? carrierValue[0] : carrierValue;
              if (carrier === null || carrier === undefined) {
                findings.errors.push(
                  `Entitlement ${ent.id}: missing role preserved because no exact paid repair carrier was authorized`,
                );
                continue;
              }
              if (
                typeof carrier !== 'object'
                || Array.isArray(carrier)
                || !isNonBlankString(carrier.action_id)
                || !['pending', 'processing'].includes(String(carrier.action_status))
              ) {
                throw new Error('paid role repair carrier returned malformed evidence');
              }
              findings.role_repairs_queued++;
              continue;
            }

            for (const roleId of missingRoleIds) {
              await member.roles.add(roleId, 'Reconciliation: re-granting missing role');
              member = await guild.members.fetch({ user: discordId, force: true });
              if (!member.roles.cache.has(roleId)) {
                findings.errors.push(
                  `Entitlement ${ent.id}: Discord did not confirm re-granted role ${roleId}`,
                );
                continue;
              }
              findings.roles_regranted++;
            }
          } catch (err) {
            // Member not in guild — that's okay, roles will be granted when they rejoin
            const msg = err instanceof Error ? err.message : String(err);
            if (!msg.includes('Unknown Member') && !msg.includes('not found')) {
              findings.errors.push(`Entitlement ${ent.id}: ${msg}`);
            }
          }
        }
        if (rows.length < PAGE_SIZE) break;
        cursor = rows[rows.length - 1].id;
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
      let cursor: string | null = null;
      let graceScanComplete = true;
      const allGracePeriod: Array<{
        id: string;
        customer_id: string;
        granted_role_ids: string[] | null;
        product_id: string | null;
        order_id: string | null;
        license_key_id: string | null;
        grace_period_ends_at: string | null;
        source: string | null;
        type: string;
      }> = [];

      try {
        while (true) {
          let query = supabase
            .from('entitlements')
            .select('id, customer_id, granted_role_ids, product_id, order_id, license_key_id, grace_period_ends_at, source, type')
            .eq('guild_id', guild.id)
            .eq('status', 'grace_period')
            .lt('grace_period_ends_at', now);
          if (cursor !== null) query = query.gt('id', cursor);

          const { data: gracePage, error: graceError } = await query
            .order('id', { ascending: true })
            .limit(PAGE_SIZE);
          if (graceError) throw new Error(graceError.message);

          const rows: Array<(typeof allGracePeriod)[number]> = requireStrictKeysetPage(
            gracePage,
            cursor,
            'Grace-period query',
          );
          for (const row of rows) allGracePeriod.push(row);
          if (rows.length < PAGE_SIZE) break;
          cursor = rows[rows.length - 1].id;
        }
      } catch (err) {
        graceScanComplete = false;
        const msg = err instanceof Error ? err.message : String(err);
        findings.errors.push(`Grace-period sweep failed: ${msg}`);
      }

      const validatedGracePeriod: typeof allGracePeriod = [];
      if (graceScanComplete) {
        const nowMs = Date.parse(now);
        for (const entitlement of allGracePeriod) {
          const roleIds = entitlement.granted_role_ids;
          const deadline = typeof entitlement.grace_period_ends_at === 'string'
            ? Date.parse(entitlement.grace_period_ends_at)
            : Number.NaN;
          const sourceValid = entitlement.source === null
            || ['purchase', 'giveaway', 'manual', 'automation'].includes(entitlement.source);
          const paidRoleIdentityValid = !(
            (entitlement.source === null || entitlement.source === 'purchase')
            && Array.isArray(roleIds)
            && roleIds.length > 0
            && !isNonBlankString(entitlement.order_id)
          );
          if (
            !isNonBlankString(entitlement.customer_id)
            || !isNonBlankString(entitlement.product_id)
            || !Array.isArray(roleIds)
            || roleIds.some((roleId) => !isNonBlankString(roleId))
            || new Set(roleIds).size !== roleIds.length
            || !Number.isFinite(deadline)
            || deadline >= nowMs
            || (entitlement.license_key_id !== null && !isNonBlankString(entitlement.license_key_id))
            || !sourceValid
            || (entitlement.type !== 'one_time' && entitlement.type !== 'subscription')
            || !paidRoleIdentityValid
          ) {
            findings.errors.push(
              `Entitlement ${entitlement.id}: grace-period row is malformed; transition preserved`,
            );
            continue;
          }
          validatedGracePeriod.push(entitlement);
        }
      }

      let customerMap = new Map<string, string>();
      if (graceScanComplete && validatedGracePeriod.length > 0) {
        try {
          const graceCustomerIds = requireUniqueSortedIds(
            validatedGracePeriod.map((entitlement) => entitlement.customer_id),
            'Grace entitlement page',
          );
          customerMap = await loadGraceCustomerMap(supabase, guild.id, graceCustomerIds);
        } catch (err) {
          graceScanComplete = false;
          const msg = err instanceof Error ? err.message : String(err);
          findings.errors.push(`Grace-period customer hydration failed: ${msg}`);
        }
      }

      if (graceScanComplete && validatedGracePeriod.length > 0) {
        for (const ent of validatedGracePeriod) {
          // Expire the entitlement. Guarded on the current status AND a
          // re-check of the deadline so neither concurrent path is clobbered:
          // a payment that recovered between the page query and this update
          // (reactivate → 'active') fails the status guard, and one that
          // recovered and then re-entered a NEW grace window (reactivate +
          // suspend → 'grace_period' with a future deadline) fails the
          // deadline guard.
          const { data: transitioned, error: expireError } = await supabase
            .from('entitlements')
            .update({
              status: 'expired',
              updated_at: now,
            })
            .eq('id', ent.id)
            .eq('status', 'grace_period')
            .lt('grace_period_ends_at', now)
            .select('id');

          if (expireError) {
            findings.errors.push(`Entitlement ${ent.id}: expire failed: ${expireError.message}`);
            continue;
          }
          if (Array.isArray(transitioned) && transitioned.length === 0) {
            // Concurrently reactivated (or already transitioned) — skip.
            continue;
          }
          if (
            !Array.isArray(transitioned)
            || transitioned.length !== 1
            || transitioned[0]?.id !== ent.id
          ) {
            findings.errors.push(
              `Entitlement ${ent.id}: expire transition returned malformed evidence`,
            );
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

          // Paid/source-null transitions atomically enqueue their exact
          // identity-rich revoke action in the database trigger above. Do not
          // race that action with an inline or partial-identity removal here:
          // only the queue consumer performs shared-owner verification.
          const usesDurablePaidRoleRevocation = ent.source == null || ent.source === 'purchase';
          if (usesDurablePaidRoleRevocation) continue;

          // Non-commerce grace rows are anomalous and have no trigger-backed,
          // full-identity outbox contract. Do not make a source-blind direct
          // removal that could strip another paid/temp/manual owner; preserve
          // access and expose an explicit operator finding.
          if (!roleIds.length) continue;
          if (!discordId) continue;
          findings.errors.push(
            `Entitlement ${ent.id}: non-commerce role revocation requires operator reconciliation for role(s): ${roleIds.join(', ')}`,
          );
        }
      }
    } // end block

    // ── 3. Timeout stale license sessions ──
    // V11 Audit H-2: Cursor-based pagination.
    {
      let cursor: string | null = null;
      let sessionScanComplete = true;
      const allStaleSessions: Array<{
        id: string;
        last_seen_at: string;
        license_key_id: string;
        license_keys: { product_id: string; guild_id: string }
          | Array<{ product_id: string; guild_id: string }>;
      }> = [];

      try {
        while (true) {
          let query = supabase
            .from('license_sessions')
            .select(`
              id,
              last_seen_at,
              license_key_id,
              license_keys!inner(product_id, guild_id)
            `)
            .eq('active', true)
            .eq('license_keys.guild_id', guild.id);
          if (cursor !== null) query = query.gt('id', cursor);

          const { data: sessionPage, error: sessionError } = await query
            .order('id', { ascending: true })
            .limit(PAGE_SIZE);
          if (sessionError) throw new Error(sessionError.message);

          const rows: Array<(typeof allStaleSessions)[number]> = requireStrictKeysetPage(
            sessionPage,
            cursor,
            'License-session query',
          );
          for (const row of rows) allStaleSessions.push(row);
          if (rows.length < PAGE_SIZE) break;
          cursor = rows[rows.length - 1].id;
        }
      } catch (err) {
        sessionScanComplete = false;
        const msg = err instanceof Error ? err.message : String(err);
        findings.errors.push(`License-session sweep failed: ${msg}`);
      }

      let configMap = new Map<string, number>();
      if (sessionScanComplete && allStaleSessions.length > 0) {
        try {
          const productIds: string[] = [];
          for (const session of allStaleSessions) {
            const licenseRows = Array.isArray(session.license_keys)
              ? session.license_keys
              : session.license_keys ? [session.license_keys] : [];
            if (
              !isNonBlankString(session.license_key_id)
              || !Number.isFinite(Date.parse(session.last_seen_at))
              || licenseRows.length !== 1
              || !isNonBlankString(licenseRows[0]?.product_id)
              || licenseRows[0]?.guild_id !== guild.id
            ) {
              throw new Error('License-session query returned a malformed or cross-guild row');
            }
            productIds.push(licenseRows[0].product_id);
          }
          configMap = await loadLicenseConfigMap(
            supabase,
            requireUniqueSortedIds(productIds, 'License-session product set'),
          );
        } catch (err) {
          sessionScanComplete = false;
          const msg = err instanceof Error ? err.message : String(err);
          findings.errors.push(`License-session hydration failed: ${msg}`);
        }
      }

      if (sessionScanComplete && allStaleSessions.length > 0) {
        for (const session of allStaleSessions) {
          const lkJoin = Array.isArray(session.license_keys) ? session.license_keys[0] : session.license_keys;
          const productId = lkJoin?.product_id;
          if (!productId) continue;

          const gracePeriodSeconds = configMap.get(productId) ?? 86400;
          const lastSeen = new Date(session.last_seen_at).getTime();
          const nowMs = Date.now();

          if (nowMs - lastSeen > gracePeriodSeconds * 1000) {
            const { data: updated, error: updateError } = await supabase
              .from('license_sessions')
              .update({
                active: false,
                deactivated_at: new Date().toISOString(),
                deactivation_reason: 'heartbeat_timeout',
              })
              .eq('id', session.id)
              .eq('active', true)
              .select('id');

            if (updateError) {
              findings.errors.push(
                `License session ${session.id}: timeout update failed: ${updateError.message}`,
              );
              continue;
            }
            if (!Array.isArray(updated) || updated.length > 1) {
              findings.errors.push(
                `License session ${session.id}: timeout update returned malformed evidence`,
              );
              continue;
            }
            if (updated.length === 0) continue;
            if (updated[0]?.id !== session.id) {
              findings.errors.push(
                `License session ${session.id}: timeout update returned mismatched evidence`,
              );
              continue;
            }

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
