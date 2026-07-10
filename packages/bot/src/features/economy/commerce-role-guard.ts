/**
 * Commerce role-income compliance guard (collection-time, defense-in-depth).
 *
 * COMPLIANCE WALL: real money must never buy wagerable game currency. A paid
 * product can grant a Discord role (products.granted_role_ids); role-income
 * (economy_role_income) pays wagerable game currency for holding a role. If a
 * commerce-granted role also has role-income configured, a buyer would collect
 * wagerable currency funded by a real-money purchase — exactly the laundering
 * path the wall forbids.
 *
 * The dashboard rejects that CONFIG (a role can never be both commerce-granted
 * and income-earning). This module is the second layer: even if a role slips
 * through config, `/collect-income` must never pay for a role the collecting
 * user holds via a commerce grant.
 *
 * A user holds a role via commerce when EITHER:
 *   1. An active/grace entitlement of theirs lists the role in
 *      `entitlements.granted_role_ids` — linked to the user through
 *      `customers.discord_id`. (EntitlementService.grant path.)
 *   2. An unexpired `temp_role_grants` row with a commerce source grants them
 *      the role directly by Discord `user_id`. (CrossFeatureBridge.grantPurchaseRole path.)
 *
 * Returns the set of role IDs the user holds via commerce, so callers can
 * exclude them from any wagerable-currency payout.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

/** Entitlement statuses under which a commerce-granted role is still held. */
const ACTIVE_ENTITLEMENT_STATUSES = ['active', 'grace_period'] as const;

/** `temp_role_grants.source` values that denote a real-money commerce grant. */
export const COMMERCE_TEMP_ROLE_SOURCES = ['commerce_purchase', 'purchase'] as const;

/**
 * Return the subset of `candidateRoleIds` that `userId` holds via a commerce
 * grant in `guildId`. Failures are treated as fail-CLOSED for the queried
 * layer is not appropriate here (we cannot invent roles), but a query error
 * must never silently pay out a commerce role — so on error we conservatively
 * return ALL candidate roles as "commerce-held" so nothing is paid, and let
 * the caller surface the situation. The wall favours not paying over paying.
 */
export async function getCommerceHeldRoleIds(
  supabase: SupabaseClient,
  guildId: string,
  userId: string,
  candidateRoleIds: string[],
): Promise<Set<string>> {
  const candidates = new Set(candidateRoleIds);
  if (candidates.size === 0) return new Set();

  try {
    const commerceHeld = new Set<string>();

    // ── Layer 1: entitlements.granted_role_ids (via customers.discord_id) ──
    // Resolve the caller's customer rows in this guild, then their active
    // entitlements' granted roles.
    const { data: customers, error: custErr } = await supabase
      .from('customers')
      .select('id')
      .eq('guild_id', guildId)
      .eq('discord_id', userId)
      .limit(1000);
    if (custErr) throw new Error(`customers lookup failed: ${custErr.message}`);

    const customerIds = (customers ?? []).map((c) => c.id as string);
    if (customerIds.length > 0) {
      const { data: entitlements, error: entErr } = await supabase
        .from('entitlements')
        .select('granted_role_ids')
        .eq('guild_id', guildId)
        .in('customer_id', customerIds)
        .in('status', ACTIVE_ENTITLEMENT_STATUSES as unknown as string[])
        .limit(1000);
      if (entErr) throw new Error(`entitlements lookup failed: ${entErr.message}`);

      for (const ent of entitlements ?? []) {
        const roleIds = (ent.granted_role_ids as string[] | null) ?? [];
        for (const roleId of roleIds) {
          if (candidates.has(roleId)) commerceHeld.add(roleId);
        }
      }
    }

    // ── Layer 2: unexpired commerce temp_role_grants (by discord user_id) ──
    const nowIso = new Date().toISOString();
    const { data: tempGrants, error: tempErr } = await supabase
      .from('temp_role_grants')
      .select('role_id')
      .eq('guild_id', guildId)
      .eq('user_id', userId)
      .in('source', COMMERCE_TEMP_ROLE_SOURCES as unknown as string[])
      .gt('expires_at', nowIso)
      .limit(1000);
    if (tempErr) throw new Error(`temp_role_grants lookup failed: ${tempErr.message}`);

    for (const grant of tempGrants ?? []) {
      const roleId = grant.role_id as string;
      if (candidates.has(roleId)) commerceHeld.add(roleId);
    }

    return commerceHeld;
  } catch {
    // Fail closed: if we cannot prove a role is NOT commerce-held, do not pay
    // for it. Excluding every candidate is safe (no wagerable currency is
    // credited for a real-money-adjacent role) and self-healing (the next
    // successful collection pays legitimately-earned roles).
    return new Set(candidateRoleIds);
  }
}
