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
 * requires an ACTIVE plan with a `paypal_plan_id` (`if (!plan.paypal_plan_id)
 * return`) and charges the PAYPAL plan's price (the DB `plans.price_cents` is
 * never consulted at checkout, so it cannot be trusted to prove a plan is
 * free — nor to prove one is chargeable). `free` products are refused at
 * checkout.
 *
 *   type          | active | price/plan state                          | buyable
 *   ------------- | ------ | ----------------------------------------- | -------
 *   free          |   *    | *                                         | NO
 *   one_time      | false  | *                                         | NO
 *   one_time      | true   | price_cents <= 0                          | NO
 *   one_time      | true   | price_cents > 0                           | YES
 *   subscription  | false  | *                                         | NO
 *   subscription  | true   | CHEAPEST active plan has NO paypal id      | NO
 *   subscription  | true   | CHEAPEST active plan HAS a paypal_plan_id  | YES
 *
 * Chargeable plan = `active` AND `paypal_plan_id` set. A `paypal_plan_id` is
 * REQUIRED, not optional: checkout starts a subscription from
 * `paypal_plan_id` alone, and PayPal's billing plan — not our DB row — is
 * what charges, so a plan WITHOUT a PayPal id cannot move real money however
 * high its `price_cents`, while a zero-`price_cents` plan WITH a real PayPal
 * id can. `price_cents` therefore does not enter the chargeability decision.
 *
 * CRUCIAL (finding #3): chargeability is decided on the SINGLE plan checkout
 * would actually charge, NOT "any active plan with a PayPal id." Checkout
 * (payment-handler.ts) picks the CHEAPEST active plan for the product
 * (`order by price_cents asc limit 1`, guild-scoped) and refuses it if it has
 * no `paypal_plan_id`. So a product whose cheapest active plan lacks a PayPal
 * id is NOT buyable even if a pricier active plan carries one — checkout picks
 * the cheapest and stops. The wall mirrors that exact selection
 * (findSubscriptionsWithChargeablePlan), so wall and checkout never disagree.
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
 *                        paypal_subscription_id, status NOT in the
 *                        never-fulfilled set pending/cancelled/pending_review).
 *                        Historical buyers hold the role
 *                        with no per-user record, so V3 applies regardless of
 *                        the product's CURRENT type/active/price — historical
 *                        grants outlive config edits.
 *   V4 RECORDED HISTORY  `products.metadata.historical_grant_role_ids` —
 *                        SERVER-DERIVED evidence, written ONLY by
 *                        preserveSoldMetadataGrantHistory() when a product edit
 *                        strips a permanent V2 role that an `orders` lookup
 *                        proves was sold, so the evidence survives the metadata
 *                        change. NEVER trusted from client metadata: every
 *                        write path (product POST, product PUT) strips a
 *                        client-supplied `historical_grant_role_ids` and lets
 *                        only the server rebuild it from stored history plus
 *                        verified sales — an owner cannot forge sold-history to
 *                        block a role, nor omit it to hide one. Effectively
 *                        append-only, but the append is a server decision.
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

// ── Full-scan helper (compliance scans must never truncate) ─────────────────

/** Page size for paginated scans — the PostgREST/Supabase per-request cap. */
const SCAN_PAGE_SIZE = 1000;

/**
 * A minimal shape for the query builder after the filters are applied: a
 * thenable that also supports `.range(from, to)`. `PostgrestFilterBuilder`
 * satisfies this, but typing it structurally keeps the helper reusable for the
 * fakes the matrix tests inject.
 */
interface RangeableQuery<T> {
  range(from: number, to: number): PromiseLike<{ data: T[] | null; error: { message: string } | null }>;
}

/**
 * Read EVERY row a compliance scan depends on — never just the first page.
 *
 * A security scan that stops at PostgREST's default 1,000-row cap can MISS a
 * role/order/entitlement and let a real-money path slip the wall (finding #1,
 * same bug class as the past heist truncation). Instead of `.limit(1000)`,
 * every wall-governing scan pages through the full result set with `.range()`
 * until a short page proves the set is exhausted. `build()` must apply all
 * filters and return the query builder; it is re-invoked per page so each call
 * gets a fresh builder, and `fetchAllRows` appends the `.range()` window. Any
 * page error propagates (callers fail CLOSED — the write aborts / the payout
 * excludes every candidate).
 */
export async function fetchAllRows<T>(
  build: () => RangeableQuery<T>,
  label: string,
  pageSize: number = SCAN_PAGE_SIZE,
): Promise<T[]> {
  const all: T[] = [];
  for (let from = 0; ; from += pageSize) {
    const to = from + pageSize - 1;
    const { data, error } = await build().range(from, to);
    if (error) throw new Error(`${label}: ${error.message}`);
    const page = data ?? [];
    all.push(...page);
    // A page shorter than the window means we have reached the end. (A page of
    // exactly pageSize means there may be more; loop for the next window.)
    if (page.length < pageSize) break;
  }
  return all;
}

// ── Pure predicates (the truth table) ───────────────────────────────────────

/** Product fields the buyability predicate reads. */
export interface ProductWallFields {
  type?: string | null;
  active?: boolean | null;
  price_cents?: number | null;
}

/** A products row as read by the paginated V1 scan. */
interface ProductScanRow {
  id: string;
  type: string | null;
  active: boolean | null;
  price_cents: number | null;
  granted_role_ids: string[] | null;
}

/** A products row as read by the paginated V2/V3/V4 metadata scans. */
interface ProductMetaScanRow {
  id: string;
  type?: string | null;
  active?: boolean | null;
  price_cents?: number | null;
  metadata: unknown;
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
 * validated to non-empty strings. This value is SERVER-DERIVED — written only
 * by preserveSoldMetadataGrantHistory() from stored history plus a
 * sale-verified stripped permanent role — and NEVER trusted from an incoming
 * client metadata object (see sanitizeClientMetadataHistory / the POST path).
 * Because owners cannot write it, reading it as compliance evidence is safe.
 */
export function historicalGrantRoleIds(metadata: unknown): string[] {
  if (!metadata || typeof metadata !== 'object') return [];
  const raw = (metadata as Record<string, unknown>).historical_grant_role_ids;
  if (!Array.isArray(raw)) return [];
  return raw.filter((r): r is string => typeof r === 'string' && r.length > 0);
}

/**
 * Strip any client-supplied `historical_grant_role_ids` from an incoming
 * metadata object. This key is SERVER-OWNED compliance evidence: it may only
 * be set by preserveSoldMetadataGrantHistory() from server-verified sale
 * history, never accepted from an owner/client payload (an owner could
 * otherwise forge sold-history and block income config for arbitrary roles).
 * Every write path that accepts client metadata (product POST, and product
 * PUT before preserveSoldMetadataGrantHistory reconstitutes the true value)
 * must run the metadata through this first. Returns a cleaned copy; the
 * original is not mutated.
 */
export function sanitizeClientMetadataHistory(metadata: unknown): Record<string, unknown> {
  if (!metadata || typeof metadata !== 'object') return {};
  const clean = { ...(metadata as Record<string, unknown>) };
  delete clean.historical_grant_role_ids;
  return clean;
}

/**
 * Chargeable plan = a plan the checkout can start a real-money subscription
 * from. Verified against the only checkout path (payment-handler.ts
 * handleBuyButton, subscription branch): it selects the active plan, then
 * `if (!plan.paypal_plan_id) return` — a plan WITHOUT a `paypal_plan_id`
 * cannot start a subscription no matter what `price_cents` says, because
 * subscriptions charge through PayPal's billing plan (identified by
 * `paypal_plan_id`), never through our DB `price_cents` row. So a
 * `paypal_plan_id` is REQUIRED, not merely sufficient: a manually-staged plan
 * with `price_cents > 0` but no PayPal id is not yet a purchase path.
 * `active !== false` treats a missing flag as active (fail closed).
 */
export function isChargeablePlan(plan: PlanWallFields): boolean {
  const hasPayPalPlan =
    typeof plan.paypal_plan_id === 'string' && plan.paypal_plan_id.length > 0;
  return plan.active !== false && hasPayPalPlan;
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
  // Full scan (finding #1): a guild with >1000 income rows must not silently
  // drop a paying role, or a product/plan write could sell a role that pays.
  const data = await fetchAllRows<{ role_id: string }>(
    () =>
      supabase
        .from('economy_role_income')
        .select('role_id')
        .eq('guild_id', guildId)
        .in('role_id', roleIds)
        .gt('amount', 0) as unknown as RangeableQuery<{ role_id: string }>,
    'economy_role_income lookup failed',
  );
  return data.map((r) => r.role_id);
}

/**
 * Of `productIds` (subscription products), the subset the checkout can
 * actually charge — mirroring what checkout ACTUALLY selects (finding #3).
 *
 * Checkout (payment-handler.ts handleBuyButton, subscription branch) does NOT
 * accept "any active plan that has a paypal_plan_id": it selects the SINGLE
 * CHEAPEST active plan for the product (guild-scoped, `order by price_cents
 * asc`, `limit 1`) and then refuses it if that plan lacks a `paypal_plan_id`
 * (`if (!plan.paypal_plan_id) return`). So a product whose cheapest active
 * plan has NO paypal_plan_id is NOT buyable even if a pricier active plan does
 * — checkout would pick the cheapest, find no PayPal id, and stop.
 *
 * The wall must evaluate the SAME plan checkout would charge, or wall and
 * checkout disagree (wall over-blocks a product checkout can't buy, or the
 * old "any chargeable plan" rule under-blocks by matching a plan checkout
 * never reaches). So we per-product select the cheapest active plan and run
 * isChargeablePlan() on THAT one. One bounded (`limit 1`) query per product;
 * the candidate set is the subscription products overlapping the roles under
 * test — small — and being per-product it also cannot truncate (finding #1).
 */
export async function findSubscriptionsWithChargeablePlan(
  supabase: SupabaseClient,
  guildId: string,
  productIds: string[],
): Promise<Set<string>> {
  if (productIds.length === 0) return new Set();
  const chargeable = new Set<string>();
  for (const productId of productIds) {
    // Mirror checkout EXACTLY: cheapest active plan for this product, then the
    // paypal_plan_id gate. Guild-scoped so a foreign zero-price plan cannot be
    // considered (matches checkout's own guild scoping).
    const { data, error } = await supabase
      .from('plans')
      .select('product_id, active, price_cents, paypal_plan_id')
      .eq('guild_id', guildId)
      .eq('product_id', productId)
      .eq('active', true)
      .order('price_cents', { ascending: true })
      .limit(1);
    if (error) throw new Error(`plans lookup failed: ${error.message}`);
    const cheapestActive = (data ?? [])[0];
    if (cheapestActive && isChargeablePlan(cheapestActive as PlanWallFields)) {
      chargeable.add(productId);
    }
  }
  return chargeable;
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
 *   - status NOT in the NEVER-FULFILLED set (pending / cancelled /
 *     pending_review). Those never granted the metadata role: an amount
 *     mismatch parks the order in `pending_review` and handlePaymentCaptured
 *     returns BEFORE queuing fulfillment, so no buyer ever received the role.
 *     A genuinely-completed order is written BEFORE fulfillment runs, and
 *     refunds do NOT remove a permanent metadata role — only entitlement
 *     roles — so refunded/disputed still count.
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
      .not('status', 'in', '("pending","cancelled","pending_review")')
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
  // decided in JS by the shared predicate. Full scan (finding #1): a guild
  // with >1000 active non-free products granting the candidate role must not
  // truncate — a buyable product beyond page 1 would slip the wall.
  const arrayData = await fetchAllRows<ProductScanRow>(
    () =>
      supabase
        .from('products')
        .select('id, type, active, price_cents, granted_role_ids')
        .eq('guild_id', guildId)
        .neq('type', 'free')
        .eq('active', true)
        .overlaps('granted_role_ids', roleIds) as unknown as RangeableQuery<ProductScanRow>,
    'products lookup failed',
  );

  const subscriptionIds = arrayData
    .filter((p) => p.type === 'subscription')
    .map((p) => p.id);
  const chargeableSubs = await findSubscriptionsWithChargeablePlan(
    supabase,
    guildId,
    subscriptionIds,
  );

  for (const product of arrayData) {
    const buyable = isBuyableProduct(product, {
      hasChargeablePlan: chargeableSubs.has(product.id),
    });
    if (!buyable) continue;
    for (const roleId of product.granted_role_ids ?? []) {
      if (candidates.has(roleId)) conflicting.add(roleId);
    }
  }

  // ── V2 (live metadata) + V3 (sold metadata): one scan, JS decides ──
  // No type/active/price SQL filters: V3 applies regardless of current
  // product state (historical permanent grants outlive config edits). Full
  // scan (finding #1): >1000 products carrying a candidate metadata role must
  // not truncate.
  const metaData = await fetchAllRows<ProductMetaScanRow>(
    () =>
      supabase
        .from('products')
        .select('id, type, active, price_cents, metadata')
        .eq('guild_id', guildId)
        .in('metadata->>grant_role_id', roleIds) as unknown as RangeableQuery<ProductMetaScanRow>,
    'products metadata lookup failed',
  );

  const soldCheck: { id: string; roleId: string }[] = [];
  for (const product of metaData) {
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
      soldCheck.push({ id: product.id, roleId });
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
  // Full scan (finding #1): every product carrying server-recorded sold
  // history must be inspected; a truncated page could hide a blocked role.
  const histData = await fetchAllRows<{ id: string; metadata: unknown }>(
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
  for (const product of histData) {
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
 * The `historical_grant_role_ids` list is rebuilt from SERVER TRUTH ONLY —
 * never from the incoming client metadata (which could forge sold-history to
 * block arbitrary roles). It is the union of:
 *   1. PRESERVE: `historical_grant_role_ids` already STORED on the product
 *      (server-written on a prior edit — survives any client metadata; a
 *      client write can neither erase nor extend it), and
 *   2. RECORD: the stored PERMANENT `grant_role_id` when this edit strips it
 *      (removed, changed, or made temporary) AND an `orders` lookup proves the
 *      product had a real-money one-time sale. Those buyers hold the role with
 *      no per-user record, so it must keep blocking income config (V4) and
 *      stay visible to the collection guard.
 * Any `historical_grant_role_ids` the client PUT while supplying metadata is
 * discarded and replaced by this server-derived list.
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
  // Drop any client-supplied history from the incoming metadata: this key is
  // server-owned and rebuilt below from stored history + verified sales only.
  const next = sanitizeClientMetadataHistory(nextMetadata);

  // Server truth: history already recorded by a prior server write. The
  // incoming `next` contributes NOTHING to this set.
  const keep = new Set<string>(historicalGrantRoleIds(storedMetadata));

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

  const wanted = [...keep];
  // The client-supplied metadata (with its forged history already stripped) is
  // the current write; if the true history is empty we must still return the
  // sanitized object whenever it differs from what the caller sent, so a
  // forged `historical_grant_role_ids` never reaches the DB.
  const clientSuppliedHistory =
    !!nextMetadata &&
    typeof nextMetadata === 'object' &&
    'historical_grant_role_ids' in (nextMetadata as Record<string, unknown>);

  if (wanted.length === 0) {
    // No server-derived history to record. Return the sanitized metadata only
    // if the client tried to smuggle a history key in; otherwise it is already
    // correct and we can skip the write override.
    return clientSuppliedHistory ? next : null;
  }

  return { ...next, historical_grant_role_ids: wanted };
}
