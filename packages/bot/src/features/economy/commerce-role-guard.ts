/**
 * Commerce role-income compliance guard (collection-time, defense-in-depth).
 *
 * COMPLIANCE WALL: real money must never buy wagerable game currency. This
 * module implements the COLLECTION GUARD column of the DECISION MATRIX
 * documented in packages/dashboard/src/lib/api/commerce-income-wall.ts (the
 * dashboard enforces the CONFIG WALL columns; the bot cannot import that
 * module, so the shared predicates are mirrored here and kept in sync with
 * that header). Even if a role slips through config, `/collect-income` must
 * never pay for a role the collecting user holds via a real-money grant.
 *
 * A user holds a role via commerce when ANY of:
 *
 *   L1  An active/grace entitlement of theirs WITH A REAL-MONEY SOURCE lists
 *       the role in `entitlements.granted_role_ids` — linked to the user
 *       through `customers.discord_id`. (EntitlementService.grant path, used
 *       by BOTH one-time and subscription fulfillment.) Entitlements whose
 *       `source` is a known non-purchase grant (giveaway / manual /
 *       automation — comped, no money moved) do NOT make the role
 *       commerce-held: a giveaway winner or admin-comped user legitimately
 *       collects income. NULL/unknown sources fail CLOSED as purchases.
 *
 *   L2  An unexpired `temp_role_grants` row with a commerce source grants
 *       them the role directly by Discord `user_id`.
 *       (CrossFeatureBridge.grantPurchaseRole TEMPORARY path — written only
 *       when `metadata.role_duration_hours` is set. Temporary metadata grants
 *       are COMPLETELY covered by this layer: they have per-user rows and an
 *       expiry, so L3 must not match them — doing so would keep excluding a
 *       user whose temp grant already expired, or who never bought at all.)
 *
 *   L3  Product-level evidence for PERMANENT metadata grants, which leave NO
 *       per-user record (grantPurchaseRole just adds the Discord role):
 *         V3 — the role is the PERMANENT `metadata.grant_role_id` of a
 *              product with at least one REAL-MONEY ONE-TIME sale (an
 *              `orders` row: amount_cents > 0, source purchase/NULL,
 *              paypal_subscription_id NULL, status other than
 *              pending/cancelled). The evidence is judged on ORDERS, not on
 *              the product's current type/active/price: historical buyers
 *              keep the role after the owner deactivates, re-prices, or
 *              re-types the product, and only the sale record proves they
 *              exist. Conversely a product that NEVER sold has no commerce
 *              holders — everyone holding its metadata role got it some
 *              other way and may collect. (A buyer cannot outrun the check:
 *              the webhook writes the completed order BEFORE fulfillment
 *              grants the role.) The one-time-order scoping is verified
 *              behaviour: only one-time fulfillment emits
 *              `purchase.completed`, the sole consumer of
 *              `metadata.grant_role_id` — subscriptions grant exclusively
 *              via `granted_role_ids` (covered by L1).
 *         V4 — the role is in `metadata.historical_grant_role_ids`, the
 *              append-only record the dashboard writes when an edit strips a
 *              sold permanent metadata role (evidence outliving the edit).
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
 * `orders.status` values that prove NO fulfillment ever ran (checkout was
 * abandoned or cancelled before capture). Everything else — completed,
 * refunded, disputed, pending_review — had money captured; refunds revoke
 * ENTITLEMENT roles but never remove a permanent metadata role, so those
 * orders remain evidence. Deny-list: unknown future statuses fail CLOSED.
 */
export const NEVER_FULFILLED_ORDER_STATUSES = ['pending', 'cancelled'] as const;

/**
 * Mirror of the dashboard matrix's isTemporaryMetadataGrant(): a metadata
 * grant with `role_duration_hours > 0` writes a per-user temp_role_grants row
 * (L2's territory) instead of a record-less permanent grant.
 */
function isTemporaryMetadataGrant(metadata: unknown): boolean {
  if (!metadata || typeof metadata !== 'object') return false;
  const hours = (metadata as Record<string, unknown>).role_duration_hours;
  return typeof hours === 'number' && hours > 0;
}

/** Mirror of the dashboard matrix's metadataGrantRoleId(). */
function metadataGrantRoleId(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== 'object') return null;
  const roleId = (metadata as Record<string, unknown>).grant_role_id;
  return typeof roleId === 'string' && roleId.length > 0 ? roleId : null;
}

/** Mirror of the dashboard matrix's historicalGrantRoleIds(). */
function historicalGrantRoleIds(metadata: unknown): string[] {
  if (!metadata || typeof metadata !== 'object') return [];
  const raw = (metadata as Record<string, unknown>).historical_grant_role_ids;
  if (!Array.isArray(raw)) return [];
  return raw.filter((r): r is string => typeof r === 'string' && r.length > 0);
}

/**
 * Of `productIds`, the subset with at least one real-money one-time sale —
 * the V3 evidence query (see the module header for the filter rationale).
 * One existence probe per product; the candidate set is tiny.
 */
async function findProductsWithRealMoneyOneTimeSales(
  supabase: SupabaseClient,
  guildId: string,
  productIds: string[],
): Promise<Set<string>> {
  const sold = new Set<string>();
  for (const productId of productIds) {
    const { data, error } = await supabase
      .from('orders')
      .select('id')
      .eq('guild_id', guildId)
      .eq('product_id', productId)
      .gt('amount_cents', 0)
      .is('paypal_subscription_id', null)
      .not('status', 'in', '("pending","cancelled")')
      .or('source.eq.purchase,source.is.null')
      .limit(1);
    if (error) throw new Error(`orders lookup failed: ${error.message}`);
    if ((data ?? []).length > 0) sold.add(productId);
  }
  return sold;
}

/**
 * Return the subset of `candidateRoleIds` that `userId` holds via a commerce
 * grant in `guildId`. A query error must never silently pay out a commerce
 * role — on error we conservatively return ALL candidate roles as
 * "commerce-held" so nothing is paid, and let the caller surface the
 * situation. The wall favours not paying over paying.
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

    // ── L1: entitlements.granted_role_ids (via customers.discord_id) ──
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

    // ── L2: unexpired commerce temp_role_grants (by discord user_id) ──
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

    // ── L3/V3: permanent metadata.grant_role_id on a product that SOLD ──
    // No type/active/price filters: the sale record — not the product's
    // current config — is what proves record-less permanent buyers exist
    // (deactivating, re-pricing, or re-typing a product does not take the
    // role away from them). Only candidate roles are queried, so this stays
    // cheap. TEMPORARY metadata grants are skipped: L2 owns them (per-user
    // rows with expiry), and matching them here would exclude holders whose
    // grant expired or who never bought at all.
    const { data: metaProducts, error: metaErr } = await supabase
      .from('products')
      .select('id, metadata')
      .eq('guild_id', guildId)
      .in('metadata->>grant_role_id', [...candidates])
      .limit(1000);
    if (metaErr) throw new Error(`products metadata lookup failed: ${metaErr.message}`);

    const soldCheck: { id: string; roleId: string }[] = [];
    for (const product of metaProducts ?? []) {
      const roleId = metadataGrantRoleId(product.metadata);
      if (!roleId || !candidates.has(roleId)) continue;
      if (isTemporaryMetadataGrant(product.metadata)) continue;
      soldCheck.push({ id: product.id as string, roleId });
    }
    if (soldCheck.length > 0) {
      const sold = await findProductsWithRealMoneyOneTimeSales(
        supabase,
        guildId,
        soldCheck.map((p) => p.id),
      );
      for (const { id, roleId } of soldCheck) {
        if (sold.has(id)) commerceHeld.add(roleId);
      }
    }

    // ── L3/V4: recorded historical grants (append-only dashboard record of
    // sold permanent metadata roles stripped by later edits) ──
    const { data: histProducts, error: histErr } = await supabase
      .from('products')
      .select('id, metadata')
      .eq('guild_id', guildId)
      .not('metadata->historical_grant_role_ids', 'is', null)
      .limit(1000);
    if (histErr) throw new Error(`products history lookup failed: ${histErr.message}`);

    for (const product of histProducts ?? []) {
      for (const roleId of historicalGrantRoleIds(product.metadata)) {
        if (candidates.has(roleId)) commerceHeld.add(roleId);
      }
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
