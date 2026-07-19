/**
 * Commerce/role-income compliance wall.
 *
 * Permanent product roles live only in `products.granted_role_ids`; typed
 * temporary roles live in `commerce_product_temp_role_config`. The effective
 * truth table unions both vectors. A product is buyable when it is active and either:
 *   - it is a positive-price one-time product, or
 *   - it is a subscription with an active PayPal-backed plan.
 *
 * Subscription checkout and every configuration precheck use the same
 * deterministic plan selector: filter to active rows with a non-empty
 * `paypal_plan_id`, then order by `(price_cents, id)`.
 *
 * Every route evaluates the complete effective post-write product and plan
 * state. Database triggers enforce the same invariant authoritatively for
 * races and writes that bypass these routes.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

const SCAN_PAGE_SIZE = 1000;
const IN_FILTER_CHUNK_SIZE = 100;

export const COMMERCE_INCOME_WALL_CONFLICT_MARKER = 'COMMERCE_INCOME_WALL_CONFLICT';

export const COMMERCE_INCOME_WALL_MESSAGE =
  'Compliance: a paid product cannot grant a role that earns game-economy role-income. ' +
  'Remove role-income from the granted role first, or grant a different role.';

interface KeysetQuery<T> {
  gt(column: string, value: string): KeysetQuery<T>;
  order(column: string, options: { ascending: boolean }): KeysetQuery<T>;
  limit(count: number): PromiseLike<{
    data: T[] | null;
    error: { message: string } | null;
  }>;
}

/**
 * Read a complete, deterministically ordered result set using an immutable id
 * cursor. Offset pagination is unsafe for compliance scans because concurrent
 * inserts or deletes can shift later pages. Null pages, malformed cursors, and
 * non-increasing results fail closed.
 */
export async function fetchAllRows<T extends { id: string }>(
  build: () => KeysetQuery<T>,
  label: string,
  pageSize: number = SCAN_PAGE_SIZE,
): Promise<T[]> {
  const all: T[] = [];
  let cursor: string | null = null;

  for (;;) {
    let query = build();
    if (cursor !== null) query = query.gt('id', cursor);
    const { data, error } = await query
      .order('id', { ascending: true })
      .limit(pageSize);

    if (error) throw new Error(`${label}: ${error.message}`);
    if (data === null) throw new Error(`${label}: query returned no data`);

    let previous = cursor;
    for (const row of data) {
      if (!row || typeof row.id !== 'string' || row.id.length === 0) {
        throw new Error(`${label}: row has no stable id cursor`);
      }
      if (previous !== null && row.id <= previous) {
        throw new Error(`${label}: rows are not strictly ordered by id`);
      }
      previous = row.id;
    }

    all.push(...data);
    if (data.length < pageSize) return all;
    cursor = data[data.length - 1]!.id;
  }
}

export interface ProductWallFields {
  type: string;
  active: boolean;
  price_cents: number;
  granted_role_ids: string[];
}

export interface PlanWallFields {
  id: string;
  active: boolean;
  price_cents: number;
  paypal_plan_id: string | null;
}

export interface EffectiveProductEvaluation {
  buyable: boolean;
  grantedRoleIds: string[];
  selectedPlan: PlanWallFields | null;
}

function validateProduct(product: ProductWallFields): void {
  if (!['free', 'one_time', 'subscription'].includes(product.type)) {
    throw new Error('commerce product state has an unknown type');
  }
  if (typeof product.active !== 'boolean') {
    throw new Error('commerce product state has no active flag');
  }
  if (
    typeof product.price_cents !== 'number' ||
    !Number.isSafeInteger(product.price_cents) ||
    product.price_cents < 0
  ) {
    throw new Error('commerce product state has an invalid price');
  }
  if (
    !Array.isArray(product.granted_role_ids) ||
    product.granted_role_ids.some((roleId) => typeof roleId !== 'string' || roleId.length === 0)
  ) {
    throw new Error('commerce product state has invalid granted_role_ids');
  }
}

function validatePlan(plan: PlanWallFields): void {
  if (!plan || typeof plan.id !== 'string' || plan.id.length === 0) {
    throw new Error('commerce plan state has no stable id');
  }
  if (typeof plan.active !== 'boolean') {
    throw new Error('commerce plan state has no active flag');
  }
  if (
    typeof plan.price_cents !== 'number' ||
    !Number.isSafeInteger(plan.price_cents) ||
    plan.price_cents < 0
  ) {
    throw new Error('commerce plan state has an invalid price');
  }
  if (plan.paypal_plan_id !== null && typeof plan.paypal_plan_id !== 'string') {
    throw new Error('commerce plan state has an invalid paypal_plan_id');
  }
}

/** Deterministically select the plan checkout is allowed to start. */
export function selectCheapestActivePayPalPlan(
  plans: readonly PlanWallFields[],
): PlanWallFields | null {
  if (!Array.isArray(plans)) throw new Error('commerce plan state is missing');
  for (const plan of plans) validatePlan(plan);

  const eligible = plans.filter(
    (plan) => plan.active && plan.paypal_plan_id !== null && plan.paypal_plan_id.trim().length > 0,
  );
  eligible.sort((left, right) => {
    if (left.price_cents !== right.price_cents) return left.price_cents - right.price_cents;
    if (left.id < right.id) return -1;
    if (left.id > right.id) return 1;
    return 0;
  });
  return eligible[0] ?? null;
}

/**
 * The one pure truth-table evaluator used for product, plan, and income-side
 * checks. Callers must pass complete post-write state, never just the edited
 * row.
 */
export function evaluateEffectivePostWriteProduct(
  product: ProductWallFields,
  plans: readonly PlanWallFields[],
  temporaryRoleIds: readonly string[],
): EffectiveProductEvaluation {
  validateProduct(product);
  if (
    !Array.isArray(temporaryRoleIds) ||
    temporaryRoleIds.some((roleId) => typeof roleId !== 'string' || roleId.length === 0)
  ) {
    throw new Error('commerce product state has invalid temporary role ids');
  }
  const selectedPlan = selectCheapestActivePayPalPlan(plans);

  let buyable = false;
  if (product.active) {
    if (product.type === 'one_time') buyable = product.price_cents > 0;
    if (product.type === 'subscription') buyable = selectedPlan !== null;
  }

  return {
    buyable,
    grantedRoleIds: [...new Set([...product.granted_role_ids, ...temporaryRoleIds])],
    selectedPlan,
  };
}

export type WallCheckResult =
  | { ok: true }
  | { ok: false; conflictingRoleIds: string[]; message: string };

interface IncomeRow {
  id: string;
  role_id: string;
}

interface ProductScanRow {
  id: string;
  type: string;
  active: boolean;
  price_cents: number;
  granted_role_ids: string[];
}

interface TemporaryRoleScanRow {
  id: string;
  product_id: string;
  role_id: string;
}

/** Load every plan for one guild-owned product using deterministic keysets. */
export async function loadProductPlans(
  supabase: SupabaseClient,
  guildId: string,
  productId: string,
): Promise<PlanWallFields[]> {
  return fetchAllRows<PlanWallFields>(
    () =>
      supabase
        .from('plans')
        .select('id, active, price_cents, paypal_plan_id')
        .eq('guild_id', guildId)
        .eq('product_id', productId) as unknown as KeysetQuery<PlanWallFields>,
    'plans lookup failed',
  );
}

function validateTemporaryRoleRows(
  rows: TemporaryRoleScanRow[],
  label: string,
): TemporaryRoleScanRow[] {
  for (const row of rows) {
    if (
      typeof row.product_id !== 'string' ||
      row.product_id.length === 0 ||
      typeof row.role_id !== 'string' ||
      row.role_id.length === 0
    ) {
      throw new Error(`${label}: row has invalid product or role identity`);
    }
  }
  return rows;
}

/** Load every typed temporary role for one product using its stable UUID id. */
export async function loadProductTemporaryRoleIds(
  supabase: SupabaseClient,
  guildId: string,
  productId: string,
): Promise<string[]> {
  const rows = await fetchAllRows<TemporaryRoleScanRow>(
    () =>
      supabase
        .from('commerce_product_temp_role_config')
        .select('id, product_id, role_id')
        .eq('guild_id', guildId)
        .eq('product_id', productId) as unknown as KeysetQuery<TemporaryRoleScanRow>,
    'temporary role config lookup failed',
  );
  validateTemporaryRoleRows(rows, 'temporary role config lookup failed');
  return [...new Set(rows.map((row) => row.role_id))];
}

/** Load the guild's complete typed temporary-role vector without truncation. */
async function loadGuildTemporaryRoleRows(
  supabase: SupabaseClient,
  guildId: string,
): Promise<TemporaryRoleScanRow[]> {
  const rows = await fetchAllRows<TemporaryRoleScanRow>(
    () =>
      supabase
        .from('commerce_product_temp_role_config')
        .select('id, product_id, role_id')
        .eq('guild_id', guildId) as unknown as KeysetQuery<TemporaryRoleScanRow>,
    'temporary role config lookup failed',
  );
  return validateTemporaryRoleRows(rows, 'temporary role config lookup failed');
}

async function loadGuildProductsByIds(
  supabase: SupabaseClient,
  guildId: string,
  productIds: string[],
): Promise<ProductScanRow[]> {
  const products: ProductScanRow[] = [];
  for (let offset = 0; offset < productIds.length; offset += IN_FILTER_CHUNK_SIZE) {
    const chunk = productIds.slice(offset, offset + IN_FILTER_CHUNK_SIZE);
    products.push(...await fetchAllRows<ProductScanRow>(
      () =>
        supabase
          .from('products')
          .select('id, type, active, price_cents, granted_role_ids')
          .eq('guild_id', guildId)
          .in('id', chunk) as unknown as KeysetQuery<ProductScanRow>,
      'products lookup failed',
    ));
  }

  const found = new Set(products.map((product) => product.id));
  const missing = productIds.filter((productId) => !found.has(productId));
  if (missing.length > 0) {
    throw new Error(`products lookup failed: temporary role config references missing product ${missing[0]}`);
  }
  return products;
}

/** Paying role-income rows for the requested roles, in request order. */
export async function findIncomeRoles(
  supabase: SupabaseClient,
  guildId: string,
  roleIds: string[],
): Promise<string[]> {
  const uniqueRoleIds = [...new Set(roleIds)];
  if (uniqueRoleIds.length === 0) return [];

  const rows = await fetchAllRows<IncomeRow>(
    () =>
      supabase
        .from('economy_role_income')
        .select('id, role_id')
        .eq('guild_id', guildId)
        .in('role_id', uniqueRoleIds)
        .gt('amount', 0) as unknown as KeysetQuery<IncomeRow>,
    'economy_role_income lookup failed',
  );
  const found = new Set(rows.map((row) => row.role_id));
  return uniqueRoleIds.filter((roleId) => found.has(roleId));
}

/** Subscription product ids that have a deterministic PayPal-backed plan. */
export async function findSubscriptionsWithChargeablePlan(
  supabase: SupabaseClient,
  guildId: string,
  productIds: string[],
): Promise<Set<string>> {
  const result = new Set<string>();
  for (const productId of [...new Set(productIds)]) {
    const plans = await loadProductPlans(supabase, guildId, productId);
    if (selectCheapestActivePayPalPlan(plans)) result.add(productId);
  }
  return result;
}

/** Canonical income-side lookup. Legacy metadata is deliberately ignored. */
export async function findPaidProductRoles(
  supabase: SupabaseClient,
  guildId: string,
  roleIds: string[],
): Promise<string[]> {
  const uniqueRoleIds = [...new Set(roleIds)];
  if (uniqueRoleIds.length === 0) return [];

  const canonicalProducts = await fetchAllRows<ProductScanRow>(
    () =>
      supabase
        .from('products')
        .select('id, type, active, price_cents, granted_role_ids')
        .eq('guild_id', guildId)
        .overlaps('granted_role_ids', uniqueRoleIds) as unknown as KeysetQuery<ProductScanRow>,
    'products lookup failed',
  );

  const candidates = new Set(uniqueRoleIds);
  const temporaryRows = await loadGuildTemporaryRoleRows(supabase, guildId);
  const temporaryRolesByProduct = new Map<string, string[]>();
  const candidateProductIds = new Set(canonicalProducts.map((product) => product.id));
  for (const row of temporaryRows) {
    const roles = temporaryRolesByProduct.get(row.product_id) ?? [];
    roles.push(row.role_id);
    temporaryRolesByProduct.set(row.product_id, roles);
    if (candidates.has(row.role_id)) candidateProductIds.add(row.product_id);
  }

  const productsById = new Map(canonicalProducts.map((product) => [product.id, product]));
  const missingProductIds = [...candidateProductIds]
    .filter((productId) => !productsById.has(productId))
    .sort();
  for (const product of await loadGuildProductsByIds(supabase, guildId, missingProductIds)) {
    productsById.set(product.id, product);
  }

  const blocked = new Set<string>();
  for (const productId of [...candidateProductIds].sort()) {
    const product = productsById.get(productId);
    if (!product) throw new Error(`products lookup failed: missing product ${productId}`);
    const plans = product.type === 'subscription'
      ? await loadProductPlans(supabase, guildId, product.id)
      : [];
    const evaluation = evaluateEffectivePostWriteProduct(
      product,
      plans,
      temporaryRolesByProduct.get(product.id) ?? [],
    );
    if (!evaluation.buyable) continue;
    for (const roleId of evaluation.grantedRoleIds) {
      if (candidates.has(roleId)) blocked.add(roleId);
    }
  }

  return uniqueRoleIds.filter((roleId) => blocked.has(roleId));
}

export async function assertProductRolesNotIncomeEarning(
  supabase: SupabaseClient,
  guildId: string,
  evaluation: EffectiveProductEvaluation,
): Promise<WallCheckResult> {
  if (!evaluation.buyable || evaluation.grantedRoleIds.length === 0) return { ok: true };
  const conflicting = await findIncomeRoles(supabase, guildId, evaluation.grantedRoleIds);
  if (conflicting.length === 0) return { ok: true };
  return {
    ok: false,
    conflictingRoleIds: conflicting,
    message: `${COMMERCE_INCOME_WALL_MESSAGE} Conflicting role(s): ${conflicting.join(', ')}.`,
  };
}

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
      'Compliance: this role is granted by a currently buyable paid product and cannot ' +
      'also earn game-economy role-income. Remove it from the paid product first, or ' +
      'choose a role that is not sold.',
  };
}

/** Only the stable trigger marker maps to a user-visible invariant conflict. */
export function isCommerceIncomeWallConflictError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { code?: unknown; message?: unknown };
  return (
    candidate.code === 'P0001' &&
    typeof candidate.message === 'string' &&
    candidate.message.startsWith(COMMERCE_INCOME_WALL_CONFLICT_MARKER)
  );
}
