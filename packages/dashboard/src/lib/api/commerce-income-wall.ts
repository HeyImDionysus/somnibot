/**
 * Compliance-wall enforcement helpers (config-time).
 *
 * COMPLIANCE WALL: real money must never buy wagerable game currency. Two
 * config surfaces can breach it if they overlap on a Discord role:
 *   - a paid product grants the role for real money, via EITHER
 *       · `products.granted_role_ids` (array of roles), OR
 *       · `products.metadata.grant_role_id` (single role granted by the bot's
 *         CrossFeatureBridge.grantPurchaseRole path on `purchase.completed`);
 *   - `economy_role_income`        — holding the role earns wagerable game currency.
 *
 * If ANY paid product grants role X (by either grant vector) and role X ALSO
 * has role-income configured, a buyer can convert a real-money purchase into
 * wagerable currency. So a role must never be BOTH commerce-granted and
 * income-earning. This is enforced at config time (unambiguous, prevents the
 * state ever existing) in both the store product routes and the role-income
 * route, with the bot's collect-income guard as defense-in-depth.
 *
 * A product is "paid" for wall purposes when its `type` is not `'free'`. A free
 * product grants no real money, so its roles are safe to also earn income —
 * but note the store product route only offers `one_time | subscription | free`
 * and always creates PayPal catalog entries for non-free priced products.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

/** Result of a wall check: either clear, or blocked with the offending roles. */
export type WallCheckResult =
  | { ok: true }
  | { ok: false; conflictingRoleIds: string[]; message: string };

/**
 * Roles configured with role-income in a guild. Returns the subset of
 * `roleIds` that already have an `economy_role_income` row.
 */
export async function findIncomeRoles(
  supabase: SupabaseClient,
  guildId: string,
  roleIds: string[],
): Promise<string[]> {
  if (roleIds.length === 0) return [];
  const { data, error } = await supabase
    .from('economy_role_income')
    .select('role_id')
    .eq('guild_id', guildId)
    .in('role_id', roleIds)
    .limit(1000);
  if (error) throw new Error(`economy_role_income lookup failed: ${error.message}`);
  return (data ?? []).map((r) => r.role_id as string);
}

/**
 * Roles granted by any PAID product in a guild, via EITHER grant vector:
 *   - `products.granted_role_ids` (array of roles), OR
 *   - `products.metadata.grant_role_id` (single role, granted by the bot's
 *     purchase.completed → grantPurchaseRole path).
 *
 * Returns the subset of `roleIds` that some non-free product grants by either
 * vector.
 *
 * Postgres array overlap (`&&`) is expressed via PostgREST's `overlaps`
 * filter, so the DB does the array intersection; the single-role metadata
 * vector is matched with an `in(metadata->>grant_role_id, …)` filter. Because
 * PostgREST joins multiple filters with AND, the two vectors are queried
 * separately and unioned in JS. We still return the precise offending role IDs
 * by intersecting against the candidate set.
 */
export async function findPaidProductRoles(
  supabase: SupabaseClient,
  guildId: string,
  roleIds: string[],
  opts: { excludeProductId?: string } = {},
): Promise<string[]> {
  if (roleIds.length === 0) return [];
  const candidate = new Set(roleIds);
  const conflicting = new Set<string>();

  // Vector 1: products.granted_role_ids array overlap.
  let arrayQuery = supabase
    .from('products')
    .select('id, granted_role_ids')
    .eq('guild_id', guildId)
    .neq('type', 'free')
    .overlaps('granted_role_ids', roleIds)
    .limit(1000);
  if (opts.excludeProductId) {
    arrayQuery = arrayQuery.neq('id', opts.excludeProductId);
  }
  const { data: arrayData, error: arrayErr } = await arrayQuery;
  if (arrayErr) throw new Error(`products lookup failed: ${arrayErr.message}`);
  for (const product of arrayData ?? []) {
    const granted = (product.granted_role_ids as string[] | null) ?? [];
    for (const roleId of granted) {
      if (candidate.has(roleId)) conflicting.add(roleId);
    }
  }

  // Vector 2: products.metadata.grant_role_id single-role grant.
  let metaQuery = supabase
    .from('products')
    .select('id, metadata')
    .eq('guild_id', guildId)
    .neq('type', 'free')
    .in('metadata->>grant_role_id', roleIds)
    .limit(1000);
  if (opts.excludeProductId) {
    metaQuery = metaQuery.neq('id', opts.excludeProductId);
  }
  const { data: metaData, error: metaErr } = await metaQuery;
  if (metaErr) throw new Error(`products metadata lookup failed: ${metaErr.message}`);
  for (const product of metaData ?? []) {
    const metadata = (product.metadata as Record<string, unknown> | null) ?? {};
    const roleId = metadata.grant_role_id;
    if (typeof roleId === 'string' && candidate.has(roleId)) conflicting.add(roleId);
  }

  return [...conflicting];
}

/**
 * PRODUCT SIDE: reject making a PAID product grant any role that already earns
 * role-income. Call before writing a product's grant configuration.
 *
 * Covers BOTH grant vectors: the `granted_role_ids` array and the single
 * `metadata.grant_role_id` role. Pass every role the product would grant via
 * `grantedRoleIds` (the caller folds in the metadata role, if any).
 *
 * `isPaid` lets the caller skip the check for free products (free products
 * move no real money, so overlap is harmless).
 */
export async function assertProductRolesNotIncomeEarning(
  supabase: SupabaseClient,
  guildId: string,
  grantedRoleIds: string[],
  isPaid: boolean,
): Promise<WallCheckResult> {
  // Dedupe so a role listed in both grant vectors is queried once.
  const uniqueRoleIds = [...new Set(grantedRoleIds)];
  if (!isPaid || uniqueRoleIds.length === 0) return { ok: true };
  const conflicting = await findIncomeRoles(supabase, guildId, uniqueRoleIds);
  if (conflicting.length === 0) return { ok: true };
  return {
    ok: false,
    conflictingRoleIds: conflicting,
    message:
      'Compliance: these roles already earn game-economy role-income and cannot ' +
      'also be granted by a paid product. Selling a role that pays wagerable ' +
      'currency would let a real-money purchase fund in-game gambling currency. ' +
      `Remove role-income for role(s) ${conflicting.join(', ')} first, or grant a ` +
      'different role.',
  };
}

/**
 * ROLE-INCOME SIDE: reject configuring role-income on a role that any PAID
 * product grants. Call before writing an `economy_role_income` row.
 */
export async function assertIncomeRoleNotCommerceGranted(
  supabase: SupabaseClient,
  guildId: string,
  roleId: string,
): Promise<WallCheckResult> {
  const conflicting = await findPaidProductRoles(supabase, guildId, [roleId]);
  if (conflicting.length === 0) return { ok: true };
  return {
    ok: false,
    conflictingRoleIds: conflicting,
    message:
      'Compliance: this role is granted by a paid product and cannot also earn ' +
      'game-economy role-income. Paying wagerable currency for a role that real ' +
      'money can buy would let a purchase fund in-game gambling currency. Remove ' +
      'the role from every paid product first, or choose a role that is not sold.',
  };
}
