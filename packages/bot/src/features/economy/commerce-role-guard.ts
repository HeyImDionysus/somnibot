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
 *   L1b PENDING-REVOKED purchase role (finding #2). A refund / subscription
 *       cancellation / grace-expiry flips the entitlement to a TERMINAL status
 *       (`expired`) and only THEN enqueues an async `revoke_roles` action; the
 *       Discord role stays on the member until that queue action succeeds, and
 *       revoke_roles RETRIES on removal failure (and is never dead-lettered).
 *       So an entitlement can be terminal while the paid role is still held —
 *       L1's `active`/`grace_period` filter would stop excluding it and pay
 *       income on a real-money role. We therefore also exclude any candidate
 *       role named by a `bot_action_queue` `revoke_roles` row (for this
 *       discord user) whose status is NOT yet `completed` — i.e. the
 *       revocation has not actually completed. Mirrors L2's "row exists ⇒ role
 *       not yet removed" reasoning: key on the ACTUAL revocation completion,
 *       not on an entitlement status flag. Since `/collect-income` only passes
 *       roles the member currently holds, a not-yet-completed revocation of a
 *       held role = still commerce-held.
 *
 *   L2  An EXISTING `temp_role_grants` row with a commerce source grants them
 *       the role directly by Discord `user_id`. Keyed on the ROW's existence,
 *       NOT on `expires_at`: the sweeper (events/handler.ts) deletes the row
 *       only AFTER it removes the Discord role, so a row that still exists —
 *       whether its expiry just passed and the sweep hasn't run, or removal
 *       failed and the row is awaiting retry — means the paid role is STILL on
 *       the member and must stay excluded until removal actually succeeds.
 *       (CrossFeatureBridge.grantPurchaseRole TEMPORARY path — written only
 *       when `metadata.role_duration_hours` is set. Temporary metadata grants
 *       are COMPLETELY covered by this layer: they have per-user rows deleted
 *       on successful removal, so L3 must not match them — doing so would keep
 *       excluding a user whose grant was removed, or who never bought at all.)
 *
 *   L3  Product-level evidence for PERMANENT metadata grants, which leave NO
 *       per-user record (grantPurchaseRole just adds the Discord role):
 *         V3 — the role is the PERMANENT `metadata.grant_role_id` of a
 *              product with at least one REAL-MONEY ONE-TIME sale (an
 *              `orders` row: amount_cents > 0, source purchase/NULL,
 *              paypal_subscription_id NULL, status NOT in the never-fulfilled
 *              set pending/cancelled/pending_review — a pending_review order
 *              parked on an amount mismatch never granted the role). The
 *              evidence is judged on ORDERS, not on
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

/** Page size for paginated scans — the PostgREST/Supabase per-request cap. */
const SCAN_PAGE_SIZE = 1000;

/** A filtered query that supports `.range()` and resolves to rows/error. */
interface RangeableQuery<T> {
  range(from: number, to: number): PromiseLike<{ data: T[] | null; error: { message: string } | null }>;
}

/**
 * Read EVERY row a compliance scan depends on — never just the first page
 * (finding #1, mirrors the dashboard wall's fetchAllRows). A `.limit(1000)`
 * scan silently drops rows past the cap, so a guild with >1000 customers /
 * entitlements / temp grants / products could let a real-money-held role
 * collect income. Pages through with `.range()` until a short page proves the
 * set is exhausted. `build()` applies all filters and returns the builder;
 * it is re-invoked per page for a fresh builder. Errors propagate (the caller
 * fails CLOSED — every candidate role is excluded).
 */
async function fetchAllRows<T>(
  build: () => RangeableQuery<T>,
  label: string,
): Promise<T[]> {
  const all: T[] = [];
  for (let from = 0; ; from += SCAN_PAGE_SIZE) {
    const to = from + SCAN_PAGE_SIZE - 1;
    const { data, error } = await build().range(from, to);
    if (error) throw new Error(`${label}: ${error.message}`);
    const page = data ?? [];
    all.push(...page);
    if (page.length < SCAN_PAGE_SIZE) break;
  }
  return all;
}

/** Entitlement statuses under which a commerce-granted role is still held. */
const ACTIVE_ENTITLEMENT_STATUSES = ['active', 'grace_period'] as const;

/**
 * `bot_action_queue.status` values for a `revoke_roles` action whose Discord
 * role removal has NOT yet completed, so the paid role is STILL on the member
 * (L1b, finding #2). This is a DENY-list keyed on the actual revocation
 * lifecycle, not on the entitlement status flag:
 *   - `pending`    — queued / awaiting its next retry (`next_retry_at`), role
 *                    not yet removed.
 *   - `failed`     — retries EXHAUSTED; revoke_roles is not dead-lettered, so
 *                    the role stays granted on the member indefinitely.
 * A `completed` row means `member.roles.remove` succeeded and the role is off
 * the member — no longer commerce-held. Any other/unknown status fails CLOSED
 * (treated as not-yet-removed) below by testing NOT-completed rather than
 * matching this list, so a future status can never silently pay a stuck role.
 */
const REVOKE_ROLES_ACTION = 'revoke_roles' as const;

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
 * `orders.status` values that prove NO fulfillment ever ran, so the metadata
 * role was never granted to a buyer:
 *   - pending / cancelled — checkout abandoned or cancelled before capture.
 *   - pending_review — an amount mismatch parked the order; the webhook
 *     (handlePaymentCaptured) returns BEFORE queuing fulfillment, so
 *     `purchase.completed` never fires and the metadata role is never granted.
 * Everything else — completed, refunded, disputed — had money captured AND
 * fulfilled: refunds revoke ENTITLEMENT roles but never remove a permanent
 * metadata role, so those orders remain evidence. Deny-list: unknown future
 * statuses fail CLOSED (treated as fulfilled, kept as evidence).
 */
export const NEVER_FULFILLED_ORDER_STATUSES = ['pending', 'cancelled', 'pending_review'] as const;

/**
 * `NEVER_FULFILLED_ORDER_STATUSES` rendered as a PostgREST `in` list, e.g.
 * `("pending","cancelled","pending_review")`, so the sale-evidence query and
 * the constant above can never drift apart.
 */
const NEVER_FULFILLED_ORDER_STATUSES_IN_LIST = `(${NEVER_FULFILLED_ORDER_STATUSES.map(
  (s) => `"${s}"`,
).join(',')})`;

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
      .not('status', 'in', NEVER_FULFILLED_ORDER_STATUSES_IN_LIST)
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
    // entitlements' granted roles. Full scans (finding #1).
    const customers = await fetchAllRows<{ id: string }>(
      () =>
        supabase
          .from('customers')
          .select('id')
          .eq('guild_id', guildId)
          .eq('discord_id', userId) as unknown as RangeableQuery<{ id: string }>,
      'customers lookup failed',
    );

    const customerIds = customers.map((c) => c.id);
    if (customerIds.length > 0) {
      const entitlements = await fetchAllRows<{ granted_role_ids: string[] | null; source?: string | null }>(
        () =>
          supabase
            .from('entitlements')
            .select('granted_role_ids, source')
            .eq('guild_id', guildId)
            .in('customer_id', customerIds)
            .in('status', ACTIVE_ENTITLEMENT_STATUSES as unknown as string[]) as unknown as RangeableQuery<{
            granted_role_ids: string[] | null;
            source?: string | null;
          }>,
        'entitlements lookup failed',
      );

      for (const ent of entitlements) {
        // Only real-money entitlements make a role commerce-held. Comped
        // grants (giveaway/manual/automation) moved no money — the holder may
        // collect income. Filtered in JS (not `.eq('source','purchase')`) so a
        // NULL/unknown source fails CLOSED as a purchase rather than being
        // silently dropped by the SQL filter.
        const source = ent.source;
        if (source != null && NON_PURCHASE_SOURCE_SET.has(source)) continue;

        const roleIds = ent.granted_role_ids ?? [];
        for (const roleId of roleIds) {
          if (candidates.has(roleId)) commerceHeld.add(roleId);
        }
      }
    }

    // ── L1b: PENDING-REVOKED purchase roles (finding #2) ──
    // A refund/cancel/grace-expiry flips the entitlement to a terminal status
    // (`expired`) BEFORE the async `revoke_roles` action removes the Discord
    // role, and revoke_roles retries on failure (never dead-lettered). So the
    // paid role can still be on the member while L1's active/grace filter no
    // longer matches. Exclude any candidate role named by a NOT-yet-completed
    // `revoke_roles` queue row for this user — keyed on actual revocation
    // completion, not on the entitlement flag. `status != 'completed'` (rather
    // than an in-list of pending/failed) fails CLOSED: any unknown/future
    // non-completed status still keeps the still-held role excluded.
    const revokeRows = await fetchAllRows<{ status: string | null; payload: unknown }>(
      () =>
        supabase
          .from('bot_action_queue')
          .select('status, payload')
          .eq('guild_id', guildId)
          .eq('action', REVOKE_ROLES_ACTION)
          .neq('status', 'completed')
          .eq('payload->>discord_id', userId) as unknown as RangeableQuery<{
          status: string | null;
          payload: unknown;
        }>,
      'bot_action_queue revoke lookup failed',
    );

    for (const row of revokeRows) {
      const payload = (row.payload ?? {}) as { role_ids?: unknown };
      const roleIds = Array.isArray(payload.role_ids) ? payload.role_ids : [];
      for (const roleId of roleIds) {
        if (typeof roleId === 'string' && candidates.has(roleId)) commerceHeld.add(roleId);
      }
    }

    // ── L2: EXISTING commerce temp_role_grants (by discord user_id) ──
    // Key on the ROW's existence, not on `expires_at`. The sweeper
    // (events/handler.ts) deletes a temp grant row ONLY AFTER it successfully
    // removes the Discord role; on removal failure the row survives for retry,
    // and even in the happy path the row outlives `expires_at` until the next
    // 15-min sweep. Filtering to future `expires_at` would stop excluding a
    // role the member STILL holds during that gap, letting them collect income
    // from a paid role. Since /collect-income only passes roles the member
    // currently holds, an existing commerce grant row = a real-money role not
    // yet removed = still commerce-held, expired or not.
    const tempGrants = await fetchAllRows<{ role_id: string }>(
      () =>
        supabase
          .from('temp_role_grants')
          .select('role_id')
          .eq('guild_id', guildId)
          .eq('user_id', userId)
          .in('source', COMMERCE_TEMP_ROLE_SOURCES as unknown as string[]) as unknown as RangeableQuery<{
          role_id: string;
        }>,
      'temp_role_grants lookup failed',
    );

    for (const grant of tempGrants) {
      const roleId = grant.role_id;
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
    const metaProducts = await fetchAllRows<{ id: string; metadata: unknown }>(
      () =>
        supabase
          .from('products')
          .select('id, metadata')
          .eq('guild_id', guildId)
          .in('metadata->>grant_role_id', [...candidates]) as unknown as RangeableQuery<{
          id: string;
          metadata: unknown;
        }>,
      'products metadata lookup failed',
    );

    const soldCheck: { id: string; roleId: string }[] = [];
    for (const product of metaProducts) {
      const roleId = metadataGrantRoleId(product.metadata);
      if (!roleId || !candidates.has(roleId)) continue;
      if (isTemporaryMetadataGrant(product.metadata)) continue;
      soldCheck.push({ id: product.id, roleId });
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
    const histProducts = await fetchAllRows<{ id: string; metadata: unknown }>(
      () =>
        supabase
          .from('products')
          .select('id, metadata')
          .eq('guild_id', guildId)
          .not('metadata->historical_grant_role_ids', 'is', null) as unknown as RangeableQuery<{
          id: string;
          metadata: unknown;
        }>,
      'products history lookup failed',
    );

    for (const product of histProducts) {
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
