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
 * CALIBRATION — the wall blocks only ACTUAL real-money purchase paths. A
 * product blocks income config (and income config blocks it) only when it is
 * BUYABLE: non-free type AND active AND able to charge real money (one-time
 * products charge `price_cents`, so they charge only when priced > 0;
 * subscriptions charge through PayPal plans, so a non-free subscription is
 * conservatively always treated as chargeable — a paid plan may exist or be
 * added). A product that CANNOT be bought (inactive, or zero-price one-time)
 * must NOT lock owners out of legitimate role-income config.
 *
 * THE REACTIVATION DANCE — because inactive/zero-price products do not block
 * income config, every path that can make such a product buyable again MUST
 * re-run the wall:
 *   - /api/store/products PUT re-checks whenever `active`, `price_cents`,
 *     `type`, `granted_role_ids`, or `metadata` change, using effective
 *     (stored + updated) values — so flipping active false→true or price
 *     0→paid on a product whose role meanwhile gained income is rejected.
 *   - /api/store/plans POST/PUT re-check before a paid active plan is written
 *     for a buyable parent product (a plan price change is the one path that
 *     makes a subscription chargeable without touching the product row).
 * The bot's collect-income guard stays as defense-in-depth and is deliberately
 * BROADER than this config-time predicate (see commerce-role-guard.ts): a
 * permanent purchase grant outlives product deactivation/price changes, so
 * collection-time cannot safely mirror this calibration.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Extract the single role a product grants via `metadata.grant_role_id` (the
 * bot's purchase.completed → grantPurchaseRole path), as a 0-or-1-element array
 * so callers can spread it alongside `granted_role_ids`. Non-string / missing
 * values yield [].
 */
export function metadataGrantRoleIds(metadata: unknown): string[] {
  if (!metadata || typeof metadata !== 'object') return [];
  const roleId = (metadata as Record<string, unknown>).grant_role_id;
  return typeof roleId === 'string' && roleId.length > 0 ? [roleId] : [];
}

/**
 * Buyable = an actual real-money purchase path: non-free type, active, and
 * able to charge. One-time products charge `price_cents`, so they are buyable
 * only when priced > 0. Subscriptions charge through PayPal plans (the
 * product-level price_cents may be 0), so a non-free active subscription is
 * always treated as buyable — a paid plan cannot be ruled out from the product
 * row alone. `active !== false` treats a missing/omitted flag as active
 * (fail closed toward blocking).
 *
 * This single predicate is the calibration shared by the product POST and PUT
 * walls; findPaidProductRoles expresses the same predicate as SQL filters.
 */
export function isBuyableProduct(product: {
  type?: string | null;
  active?: boolean | null;
  price_cents?: number | null;
}): boolean {
  const chargesRealMoney =
    product.type === 'subscription' || (product.price_cents ?? 0) > 0;
  return product.type !== 'free' && product.active !== false && chargesRealMoney;
}

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
 * Roles granted by any BUYABLE product in a guild, via EITHER grant vector:
 *   - `products.granted_role_ids` (array of roles), OR
 *   - `products.metadata.grant_role_id` (single role, granted by the bot's
 *     purchase.completed → grantPurchaseRole path).
 *
 * Returns the subset of `roleIds` that some buyable product grants by either
 * vector.
 *
 * CALIBRATION: only buyable products conflict — the SQL filters mirror
 * isBuyableProduct(): non-free type, `active = true`, and chargeable
 * (`type = subscription OR price_cents > 0`). An owner who deactivated a
 * product (or keeps a zero-price one-time product around) must not be locked
 * out of configuring income on its role: the product cannot be bought, so no
 * real money can reach the role. This is safe ONLY because reactivating or
 * re-pricing that product re-runs the product-side wall (/api/store/products
 * PUT re-checks on `active`/`price_cents`/`type` changes, /api/store/plans
 * re-checks before a paid active plan lands) and blocks the collision then —
 * see "THE REACTIVATION DANCE" in the module header.
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

  // SQL form of isBuyableProduct()'s "chargeable" arm (PostgREST OR filter).
  const CHARGEABLE_FILTER = 'type.eq.subscription,price_cents.gt.0';

  // Vector 1: products.granted_role_ids array overlap.
  let arrayQuery = supabase
    .from('products')
    .select('id, granted_role_ids')
    .eq('guild_id', guildId)
    .neq('type', 'free')
    .eq('active', true)
    .or(CHARGEABLE_FILTER)
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
    .eq('active', true)
    .or(CHARGEABLE_FILTER)
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
 * ROLE-INCOME SIDE: reject configuring role-income on a role that any BUYABLE
 * product grants. Call before writing an `economy_role_income` row.
 *
 * Roles attached only to inactive or zero-price-one-time products do NOT
 * block: those products cannot currently be bought, and the product-side
 * walls re-check on reactivation/re-pricing (see findPaidProductRoles).
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
