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
 * A user holds a role via commerce when ANY of:
 *   1. An active/grace entitlement of theirs WITH A REAL-MONEY SOURCE lists
 *      the role in `entitlements.granted_role_ids` — linked to the user
 *      through `customers.discord_id`. (EntitlementService.grant path.)
 *      Entitlements whose `source` is a known non-purchase grant (giveaway /
 *      manual / automation — comped, no money moved) do NOT make the role
 *      commerce-held: a giveaway winner or admin-comped user legitimately
 *      collects income on the role.
 *   2. An unexpired `temp_role_grants` row with a commerce source grants them
 *      the role directly by Discord `user_id`. (CrossFeatureBridge.grantPurchaseRole
 *      TEMPORARY path — only written when metadata.role_duration_hours is set.)
 *   3. The role is the `metadata.grant_role_id` of any PAID product in the
 *      guild. (CrossFeatureBridge.grantPurchaseRole PERMANENT path — a permanent
 *      metadata grant adds the Discord role but writes NO temp_role_grants row
 *      and NO entitlement, so layers 1–2 never see it. The config wall forbids a
 *      paid product's granted role from also earning income, so any role a paid
 *      product grants is commerce-held for wall purposes regardless of which
 *      specific product the collecting user bought.)
 *
 * Returns the set of role IDs the user holds via commerce, so callers can
 * exclude them from any wagerable-currency payout.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

/** Entitlement statuses under which a commerce-granted role is still held. */
const ACTIVE_ENTITLEMENT_STATUSES = ['active', 'grace_period'] as const;

/**
 * `entitlements.source` values that are NOT real-money purchases. The DB CHECK
 * allows exactly ('purchase', 'giveaway', 'manual', 'automation') with DEFAULT
 * 'purchase' (initial_schema), matching EntitlementService.grant's source
 * union. This is a DENY-list on purpose: only sources we positively know moved
 * no real money are exempt, so a NULL or any future/unknown source value fails
 * CLOSED (treated as a purchase and blocked from income), consistent with this
 * module's favour-not-paying stance.
 */
export const NON_PURCHASE_ENTITLEMENT_SOURCES = ['giveaway', 'manual', 'automation'] as const;

const NON_PURCHASE_SOURCE_SET: ReadonlySet<string> = new Set(NON_PURCHASE_ENTITLEMENT_SOURCES);

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
        .select('granted_role_ids, source')
        .eq('guild_id', guildId)
        .in('customer_id', customerIds)
        .in('status', ACTIVE_ENTITLEMENT_STATUSES as unknown as string[])
        .limit(1000);
      if (entErr) throw new Error(`entitlements lookup failed: ${entErr.message}`);

      for (const ent of entitlements ?? []) {
        // Only real-money entitlements make a role commerce-held. Comped
        // grants (giveaway/manual/automation) moved no money — the holder may
        // collect income. Filtered in JS (not `.eq('source','purchase')`) so a
        // NULL/unknown source fails CLOSED as a purchase rather than being
        // silently dropped by the SQL filter.
        const source = (ent as { source?: string | null }).source;
        if (source != null && NON_PURCHASE_SOURCE_SET.has(source)) continue;

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

    // ── Layer 3: permanent metadata.grant_role_id on any PAID product ──
    // A permanent commerce role grant (no role_duration_hours) writes neither
    // an entitlement nor a temp_role_grants row — grantPurchaseRole just adds
    // the Discord role. So layers 1–2 can't see it. The config wall forbids a
    // paid product from granting a role that also earns income, so ANY role a
    // paid product grants via metadata is treated as commerce-held here. We only
    // query for the candidate roles (roles the user both holds and has income
    // configured for), so this stays cheap.
    //
    // DELIBERATELY BROADER than the dashboard's config-time wall: the config
    // wall (commerce-income-wall.ts) exempts inactive/zero-price products
    // because they cannot CURRENTLY be bought and every reactivation path
    // re-checks. This layer must NOT mirror that calibration — a permanent
    // metadata grant leaves no per-user record, so a role bought while the
    // product was active and paid is indistinguishable from a manually-added
    // one AFTER the owner deactivates or re-prices the product. Filtering on
    // active/price here would let those historical real-money holders collect
    // income (laundering path). The cost of staying broad: a staged (inactive,
    // never-sold) product's metadata role also never pays income via this
    // layer — the wall favours not paying over paying.
    const { data: metaProducts, error: metaErr } = await supabase
      .from('products')
      .select('metadata')
      .eq('guild_id', guildId)
      .neq('type', 'free')
      .in('metadata->>grant_role_id', [...candidates])
      .limit(1000);
    if (metaErr) throw new Error(`products metadata lookup failed: ${metaErr.message}`);

    for (const product of metaProducts ?? []) {
      const metadata = (product.metadata as Record<string, unknown> | null) ?? {};
      const roleId = metadata.grant_role_id;
      if (typeof roleId === 'string' && candidates.has(roleId)) commerceHeld.add(roleId);
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
