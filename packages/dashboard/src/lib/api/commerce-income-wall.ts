/**
 * Commerce ⇄ role-income compliance wall — THE DECISION MATRIX.
 *
 * COMPLIANCE WALL: real money must never buy wagerable game currency. The two
 * economies meet on Discord roles: paid products can GRANT roles, and
 * `economy_role_income` PAYS wagerable game currency for holding a role. This
 * module is the single source of truth for when that overlap is a real-money
 * laundering path (blocked) versus harmless config (allowed). Every
 * enforcement site consumes the predicates below:
 *
 *   - /api/store/products POST + PUT   (product-side wall)
 *   - /api/store/plans    POST + PUT   (plan-side wall)
 *   - /api/economy/role-income POST    (income-side wall)
 *   - bot /collect-income guard        (collection-time backstop —
 *     packages/bot/src/features/economy/commerce-role-guard.ts implements the
 *     COLLECTION GUARD column of this same matrix; it cannot import this
 *     dashboard module, so it mirrors the predicates and cites this header)
 *   - bot checkout (payment-handler.ts handleBuyButton) enforces the
 *     BUYABILITY column at the point of sale, so the wall's model of "what can
 *     be bought" is exactly what the checkout permits.
 *
 * ── BUYABILITY(product) — can real money flow through this product NOW? ─────
 *
 * Verified against the only checkout path (bot /store → handleBuyButton):
 * one-time checkout charges `products.price_cents`; subscription checkout
 * requires an ACTIVE plan with a `paypal_plan_id` and charges the PAYPAL
 * plan's price (the DB `plans.price_cents` is never consulted at checkout, so
 * it cannot be trusted to prove a plan is free). `free` products are refused
 * at checkout.
 *
 *   type          | active | price/plan state                        | buyable
 *   ------------- | ------ | --------------------------------------- | -------
 *   free          |   *    | *                                       | NO
 *   one_time      | false  | *                                       | NO
 *   one_time      | true   | price_cents <= 0                        | NO
 *   one_time      | true   | price_cents > 0                         | YES
 *   subscription  | false  | *                                       | NO
 *   subscription  | true   | no chargeable plan                      | NO
 *   subscription  | true   | >=1 active plan with price_cents > 0    | YES
 *   subscription  | true   |     ... or with a paypal_plan_id        | YES
 *
 * Chargeable plan = `active` AND (`price_cents > 0` OR `paypal_plan_id` set).
 * The `paypal_plan_id` arm is deliberate fail-closed: checkout starts a
 * subscription from `paypal_plan_id` alone, and PayPal's plan price — not our
 * DB row — is what gets charged, so a zero-`price_cents` plan with a real
 * PayPal id must still count as a purchase path.
 *
 * ── GRANT VECTORS(product, role) — how a purchase grants a role ────────────
 *
 * Verified against fulfillment (dashboard webhook → action queue → bot
 * commerce-fulfillment.ts / cross-feature-bridge.ts):
 *
 *   V1 LIVE ARRAY        `products.granted_role_ids` — granted on BOTH
 *                        one-time capture and subscription activation via
 *                        EntitlementService.grant. Per-user record: an
 *                        `entitlements` row (with `source`).
 *   V2 LIVE METADATA     `products.metadata.grant_role_id` — granted ONLY by
 *                        the `purchase.completed` event, which is emitted
 *                        ONLY for one-time fulfillment
 *                        (commerce-fulfillment.ts handleOneTimePurchase);
 *                        subscription activation emits
 *                        `subscription.activated` and never consumes the
 *                        metadata role. With `metadata.role_duration_hours`
 *                        the grant is TEMPORARY (per-user `temp_role_grants`
 *                        row, source `commerce_purchase`); without it the
 *                        grant is PERMANENT and leaves NO per-user record.
 *   V3 SOLD METADATA     A PERMANENT V2 role on a product that HAS at least
 *                        one real-money one-time sale (an `orders` row with
 *                        amount_cents > 0, source purchase/NULL, no
 *                        paypal_subscription_id, status other than
 *                        pending/cancelled). Historical buyers hold the role
 *                        with no per-user record, so V3 applies regardless of
 *                        the product's CURRENT type/active/price — historical
 *                        grants outlive config edits.
 *   V4 RECORDED HISTORY  `products.metadata.historical_grant_role_ids` —
 *                        written by preserveSoldMetadataGrantHistory() when a
 *                        product edit strips a sold permanent V2 role, so the
 *                        evidence survives the metadata change. Append-only
 *                        through the API (client-supplied metadata cannot
 *                        remove entries).
 *
 * ── CONFIG WALL — when is role R blocked from role-income config? ──────────
 *
 *   Blocked  ⇔  ∃ product P:
 *     (a) BUYABLE(P)              ∧ R ∈ V1(P), or
 *     (b) BUYABLE(P) ∧ V2 fires for P.type (one_time) ∧ R = V2(P)
 *         (temporary AND permanent metadata grants both block config — a
 *         temp grant still moves real money onto the role), or
 *     (c) V3(P, R)  — sold permanent metadata, any current product state, or
 *     (d) V4(P, R)  — recorded history, any current product state.
 *
 *   The same test runs mirrored from the product/plan side: a product (or
 *   plan) write is rejected when it would make BUYABLE a product granting an
 *   income-earning role. Zero-amount `economy_role_income` rows are IGNORED
 *   (amount <= 0 cannot pay currency; /collect-income skips them), so they
 *   never block a product/plan write. All lookups FAIL CLOSED: an error
 *   aborts the write (5xx) rather than letting a partial view pass the wall.
 *
 *   Deliberately NOT blocked (each row exists to keep the wall calibrated —
 *   blocking them would lock owners out of legitimate config):
 *     - inactive products (not buyable; every reactivation path re-checks:
 *       products PUT re-runs on active/price_cents/type/roles/metadata,
 *       plans POST/PUT re-run before a chargeable plan lands),
 *     - zero-price one-time products (charge nothing),
 *     - subscriptions with no chargeable plan (checkout cannot start them),
 *     - V2 metadata on subscription-typed products (never consumed — but see
 *       V3: if the product sold one-time under an earlier type, it blocks),
 *     - roles only ever granted by comped paths (entitlement source
 *       giveaway/manual/automation, zero-amount orders),
 *     - zero-amount income rows (cannot pay).
 *
 * ── COLLECTION GUARD — when is user U's role R excluded from payout? ───────
 *
 *   Implemented in the bot (commerce-role-guard.ts), same matrix:
 *     L1  active/grace entitlement with a REAL-MONEY source listing R
 *         (source deny-list giveaway/manual/automation; NULL/unknown source
 *         fails closed as a purchase),
 *     L2  unexpired `temp_role_grants` row with a commerce source,
 *     L3  product-level evidence for record-less permanent grants: V3 or V4.
 *         (Not temporary metadata grants — those are L2's job and expire; not
 *         never-sold products — no commerce holder can exist without a
 *         completed order, which is written BEFORE fulfillment runs.)
 *   Any query error fails CLOSED: every candidate role is excluded.
 *
 * ── THE REACTIVATION DANCE ──────────────────────────────────────────────────
 *
 * Because non-buyable products do not block income config, every path that
 * can make a product buyable re-runs the wall with effective (stored +
 * updated) values: products PUT re-checks when `active`, `price_cents`,
 * `type`, `granted_role_ids`, or `metadata` change; plans POST/PUT re-check
 * before a chargeable plan is written (created, re-priced, re-activated,
 * given a paypal_plan_id, or moved to another product). The checkout guard
 * and the collection guard backstop anything that slips through.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

// ── Pure predicates (the truth table) ───────────────────────────────────────

/** Product fields the buyability predicate reads. */
export interface ProductWallFields {
  type?: string | null;
  active?: boolean | null;
  price_cents?: number | null;
}

/** Plan fields the chargeability predicate reads. */
export interface PlanWallFields {
  active?: boolean | null;
  price_cents?: number | null;
  paypal_plan_id?: string | null;
}

/**
 * The single role a product grants via `metadata.grant_role_id`, or null.
 * Non-string / empty values yield null.
 */
export function metadataGrantRoleId(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== 'object') return null;
  const roleId = (metadata as Record<string, unknown>).grant_role_id;
  return typeof roleId === 'string' && roleId.length > 0 ? roleId : null;
}

/**
 * `metadataGrantRoleId` as a 0-or-1-element array so callers can spread it
 * alongside `granted_role_ids`.
 */
export function metadataGrantRoleIds(metadata: unknown): string[] {
  const roleId = metadataGrantRoleId(metadata);
  return roleId ? [roleId] : [];
}

/**
 * A metadata grant with `role_duration_hours > 0` is TEMPORARY: fulfillment
 * writes a per-user `temp_role_grants` row (source commerce_purchase) and the
 * role expires. Without it the grant is PERMANENT and leaves no record.
 */
export function isTemporaryMetadataGrant(metadata: unknown): boolean {
  if (!metadata || typeof metadata !== 'object') return false;
  const hours = (metadata as Record<string, unknown>).role_duration_hours;
  return typeof hours === 'number' && hours > 0;
}

/** The V2 role when the grant is PERMANENT (no duration), else null. */
export function permanentMetadataGrantRoleId(metadata: unknown): string | null {
  if (isTemporaryMetadataGrant(metadata)) return null;
  return metadataGrantRoleId(metadata);
}

/**
 * Does the V2 metadata vector fire for this product type? Verified: only the
 * one-time fulfillment path emits `purchase.completed`, which is the only
 * consumer of `metadata.grant_role_id`; subscription activation grants
 * exclusively via `granted_role_ids`. Free products are never buyable.
 * Unknown/future types fail CLOSED (treated as firing).
 */
export function metadataGrantVectorApplies(type: string | null | undefined): boolean {
  return type !== 'subscription' && type !== 'free';
}

/**
 * The V4 recorded-history roles: `metadata.historical_grant_role_ids`,
 * validated to non-empty strings. Written only by
 * preserveSoldMetadataGrantHistory() when a sold permanent V2 role is
 * stripped by an edit.
 */
export function historicalGrantRoleIds(metadata: unknown): string[] {
  if (!metadata || typeof metadata !== 'object') return [];
  const raw = (metadata as Record<string, unknown>).historical_grant_role_ids;
  if (!Array.isArray(raw)) return [];
  return raw.filter((r): r is string => typeof r === 'string' && r.length > 0);
}

/**
 * Chargeable plan = a plan the checkout can start a real-money subscription
 * from. `active !== false` treats a missing flag as active (fail closed).
 * `paypal_plan_id` alone is enough: checkout only requires the PayPal id and
 * PayPal's plan price — not our `price_cents` — is what gets charged.
 */
export function isChargeablePlan(plan: PlanWallFields): boolean {
  const hasPayPalPlan =
    typeof plan.paypal_plan_id === 'string' && plan.paypal_plan_id.length > 0;
  return plan.active !== false && ((plan.price_cents ?? 0) > 0 || hasPayPalPlan);
}

/**
 * BUYABILITY — the truth table in the module header, as one predicate.
 *
 * `hasChargeablePlan` is REQUIRED so every caller decides the subscription
 * column explicitly: product POST derives it from the plan definitions in
 * the request, product PUT queries the product's stored plans, the plans
 * routes pass true (the write itself creates the chargeable plan), and
 * findPaidProductRoles queries plans in bulk. `active !== false` treats a
 * missing flag as active (fail closed toward blocking). Unknown non-free
 * types fail CLOSED: buyable when active and EITHER charge path exists.
 */
export function isBuyableProduct(
  product: ProductWallFields,
  opts: { hasChargeablePlan: boolean },
): boolean {
  if (product.type === 'free' || product.active === false) return false;
  if (product.type === 'one_time') return (product.price_cents ?? 0) > 0;
  if (product.type === 'subscription') return opts.hasChargeablePlan;
  // Unknown/future type: fail closed — either charge path counts.
  return (product.price_cents ?? 0) > 0 || opts.hasChargeablePlan;
}

/** Result of a wall check: either clear, or blocked with the offending roles. */
export type WallCheckResult =
  | { ok: true }
  | { ok: false; conflictingRoleIds: string[]; message: string };

// ── Query helpers (SQL faces of the predicates) ─────────────────────────────

/**
 * Roles configured with PAYING role-income in a guild: the subset of
 * `roleIds` that has an `economy_role_income` row with `amount > 0`.
 * Zero/negative-amount rows cannot pay wagerable currency (`/collect-income`
 * skips them and the schema rejects new ones), so a legacy zero row never
 * blocks a product or plan write.
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
    .gt('amount', 0)
    .limit(1000);
  if (error) throw new Error(`economy_role_income lookup failed: ${error.message}`);
  return (data ?? []).map((r) => r.role_id as string);
}

/**
 * Of `productIds` (subscription products), the subset with at least one
 * chargeable plan — see isChargeablePlan(). The SQL OR is a prefilter; the
 * shared predicate makes the final call in JS.
 */
export async function findSubscriptionsWithChargeablePlan(
  supabase: SupabaseClient,
  guildId: string,
  productIds: string[],
): Promise<Set<string>> {
  if (productIds.length === 0) return new Set();
  const { data, error } = await supabase
    .from('plans')
    .select('product_id, active, price_cents, paypal_plan_id')
    .eq('guild_id', guildId)
    .in('product_id', productIds)
    .eq('active', true)
    .or('price_cents.gt.0,paypal_plan_id.not.is.null')
    .limit(1000);
  if (error) throw new Error(`plans lookup failed: ${error.message}`);
  return new Set(
    (data ?? [])
      .filter((plan) => isChargeablePlan(plan as PlanWallFields))
      .map((plan) => plan.product_id as string),
  );
}

/**
 * Of `productIds`, the subset with at least one REAL-MONEY ONE-TIME sale —
 * the V3 evidence that a permanent metadata grant reached a paying buyer:
 *   - amount_cents > 0            (zero-amount orders moved no money),
 *   - source purchase or NULL     (giveaway/manual/automation are comped;
 *                                  NULL fails closed as purchase, matching
 *                                  the DB default),
 *   - paypal_subscription_id NULL (subscription orders never consume the
 *                                  metadata vector),
 *   - status other than pending/cancelled (those never fulfilled; a
 *     completed order is written BEFORE fulfillment runs, and refunds do NOT
 *     remove a permanent metadata role — only entitlement roles — so
 *     refunded/disputed still count).
 * One existence query per product: the candidate set here is tiny (products
 * whose metadata role overlaps the roles under test).
 */
export async function findProductsWithRealMoneyOneTimeSales(
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
 * CONFIG WALL, income side: the subset of `roleIds` blocked by any product
 * through vectors V1–V4 (see the module header). Throws on any lookup error
 * (fail closed — the caller aborts the write).
 */
export async function findPaidProductRoles(
  supabase: SupabaseClient,
  guildId: string,
  roleIds: string[],
): Promise<string[]> {
  if (roleIds.length === 0) return [];
  const candidates = new Set(roleIds);
  const conflicting = new Set<string>();

  // ── V1: granted_role_ids on a BUYABLE product ──
  // SQL prefilters the cheap arms (non-free, active, role overlap); the
  // price/plan arm needs plan rows for subscriptions, so buyability is
  // decided in JS by the shared predicate.
  const { data: arrayData, error: arrayErr } = await supabase
    .from('products')
    .select('id, type, active, price_cents, granted_role_ids')
    .eq('guild_id', guildId)
    .neq('type', 'free')
    .eq('active', true)
    .overlaps('granted_role_ids', roleIds)
    .limit(1000);
  if (arrayErr) throw new Error(`products lookup failed: ${arrayErr.message}`);

  const subscriptionIds = (arrayData ?? [])
    .filter((p) => p.type === 'subscription')
    .map((p) => p.id as string);
  const chargeableSubs = await findSubscriptionsWithChargeablePlan(
    supabase,
    guildId,
    subscriptionIds,
  );

  for (const product of arrayData ?? []) {
    const buyable = isBuyableProduct(product as ProductWallFields, {
      hasChargeablePlan: chargeableSubs.has(product.id as string),
    });
    if (!buyable) continue;
    for (const roleId of (product.granted_role_ids as string[] | null) ?? []) {
      if (candidates.has(roleId)) conflicting.add(roleId);
    }
  }

  // ── V2 (live metadata) + V3 (sold metadata): one query, JS decides ──
  // No type/active/price SQL filters: V3 applies regardless of current
  // product state (historical permanent grants outlive config edits).
  const { data: metaData, error: metaErr } = await supabase
    .from('products')
    .select('id, type, active, price_cents, metadata')
    .eq('guild_id', guildId)
    .in('metadata->>grant_role_id', roleIds)
    .limit(1000);
  if (metaErr) throw new Error(`products metadata lookup failed: ${metaErr.message}`);

  const soldCheck: { id: string; roleId: string }[] = [];
  for (const product of metaData ?? []) {
    const roleId = metadataGrantRoleId(product.metadata);
    if (!roleId || !candidates.has(roleId)) continue;
    // V2: the metadata vector only fires for one-time checkout, and only a
    // buyable product moves money. Temporary and permanent grants both block
    // at config time (a temp grant still moves real money onto the role).
    if (
      metadataGrantVectorApplies(product.type as string | null) &&
      isBuyableProduct(product as ProductWallFields, { hasChargeablePlan: false })
    ) {
      conflicting.add(roleId);
      continue;
    }
    // V3: a PERMANENT metadata grant that has actually sold blocks forever,
    // whatever the product's current type/active/price.
    if (permanentMetadataGrantRoleId(product.metadata) === roleId) {
      soldCheck.push({ id: product.id as string, roleId });
    }
  }
  if (soldCheck.length > 0) {
    const sold = await findProductsWithRealMoneyOneTimeSales(
      supabase,
      guildId,
      soldCheck.map((p) => p.id),
    );
    for (const { id, roleId } of soldCheck) {
      if (sold.has(id)) conflicting.add(roleId);
    }
  }

  // ── V4: recorded historical grants — any product state ──
  const { data: histData, error: histErr } = await supabase
    .from('products')
    .select('id, metadata')
    .eq('guild_id', guildId)
    .not('metadata->historical_grant_role_ids', 'is', null)
    .limit(1000);
  if (histErr) throw new Error(`products history lookup failed: ${histErr.message}`);
  for (const product of histData ?? []) {
    for (const roleId of historicalGrantRoleIds(product.metadata)) {
      if (candidates.has(roleId)) conflicting.add(roleId);
    }
  }

  return [...conflicting];
}

/**
 * PRODUCT/PLAN SIDE: reject making a BUYABLE product grant any role that
 * already earns (positive-amount) role-income. Pass every role the write
 * would put on a purchase path via `grantedRoleIds` — the caller folds in
 * the metadata role only when the V2 vector fires for the product's type.
 *
 * `isBuyable` is the caller-evaluated BUYABILITY cell (see isBuyableProduct);
 * non-buyable writes are never blocked.
 */
export async function assertProductRolesNotIncomeEarning(
  supabase: SupabaseClient,
  guildId: string,
  grantedRoleIds: string[],
  isBuyable: boolean,
): Promise<WallCheckResult> {
  const uniqueRoleIds = [...new Set(grantedRoleIds)];
  if (!isBuyable || uniqueRoleIds.length === 0) return { ok: true };
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
 * INCOME SIDE: reject configuring role-income on a role any product blocks
 * through vectors V1–V4. Call before writing an `economy_role_income` row.
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
      'Compliance: this role is granted by a paid product (or was sold by one ' +
      'in the past) and cannot also earn game-economy role-income. Paying ' +
      'wagerable currency for a role that real money can buy would let a ' +
      'purchase fund in-game gambling currency. Remove the role from every paid ' +
      'product first, or choose a role that is not sold.',
  };
}

/**
 * V4 MAINTENANCE — call from the products PUT path when `metadata` is being
 * replaced. Returns the metadata object that MUST be written instead of the
 * caller's, or null when the caller's metadata is already correct.
 *
 * Two invariants, both append-only through the API:
 *   1. PRESERVE: `historical_grant_role_ids` already stored on the product
 *      survives any client-supplied metadata (a client write cannot erase
 *      the compliance record).
 *   2. RECORD: when the edit strips the stored PERMANENT `grant_role_id`
 *      (removed, changed, or made temporary) and the product HAS a
 *      real-money one-time sale, the stripped role is appended — its buyers
 *      hold it with no per-user record, so the role must keep blocking
 *      income config (V4) and stay visible to the collection guard.
 *
 * Throws on lookup errors (fail closed — the caller aborts the update).
 */
export async function preserveSoldMetadataGrantHistory(
  supabase: SupabaseClient,
  guildId: string,
  productId: string,
  storedMetadata: unknown,
  nextMetadata: unknown,
): Promise<Record<string, unknown> | null> {
  const next =
    nextMetadata && typeof nextMetadata === 'object'
      ? { ...(nextMetadata as Record<string, unknown>) }
      : {};

  const keep = new Set<string>([
    ...historicalGrantRoleIds(storedMetadata),
    ...historicalGrantRoleIds(next),
  ]);

  const storedPermanentRole = permanentMetadataGrantRoleId(storedMetadata);
  const nextPermanentRole = permanentMetadataGrantRoleId(next);
  if (
    storedPermanentRole &&
    storedPermanentRole !== nextPermanentRole &&
    !keep.has(storedPermanentRole)
  ) {
    const sold = await findProductsWithRealMoneyOneTimeSales(supabase, guildId, [
      productId,
    ]);
    if (sold.has(productId)) keep.add(storedPermanentRole);
  }

  const current = historicalGrantRoleIds(next);
  const wanted = [...keep];
  const unchanged =
    current.length === wanted.length && wanted.every((r) => current.includes(r));
  if (unchanged) return null;

  return { ...next, historical_grant_role_ids: wanted };
}
