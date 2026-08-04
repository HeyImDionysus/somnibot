/**
 * /api/license/config/[productId] — Product license configuration.
 *
 * GET: Fetch license config for a product
 * PUT: Update license config for a product (upsert)
 */
import { NextRequest, NextResponse } from 'next/server';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { requireGuildOwner } from '@/lib/api/require-owner';
import { parseBody, schemas } from '@/lib/api/validation';
import { checkAdminRateLimit } from '@/lib/api/admin-rate-limit';
import { dbError } from '@/lib/api/response';
import {
  describeSettingChange,
  readRowBefore,
  recordAdminChange,
  undoByRestoring,
} from '@/lib/admin-changes';

/**
 * The columns the upsert below writes on every save. Listed explicitly (not
 * derived from the request) so the recorded before/after and the undo payload
 * can only ever name real, allowlisted `product_license_config` columns.
 */
const LICENSE_CONFIG_COLUMNS = [
  'license_mode',
  'key_prefix',
  'max_devices',
  'heartbeat_interval_seconds',
  'sdk_cache_ttl_ms',
  'offline_grace_period_seconds',
  'feature_flags',
  'tier',
  'watermark_config',
  'require_discord_guild_membership',
  'rotation_policy',
  'self_service_device_removal',
] as const;

/** Structural equality good enough for scalars, string arrays and small JSON. */
function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  try {
    return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  } catch {
    return false;
  }
}

/**
 * Resolve a product THROUGH the caller's guild.
 *
 * `product_license_config` is keyed by `product_id` alone and carries no
 * `guild_id`, and every query here runs on the service-role client, which is
 * exempt from row-level security. Both handlers previously destructured
 * `guildId` from the auth context and then never used it — so naming any
 * product's UUID read, and overwrote, that product's licence configuration
 * regardless of which guild owned it. Tenancy for this table lives entirely in
 * the parent `products` row, so it has to be checked here or not at all.
 *
 * Returns null when the product does not exist OR belongs to another guild.
 * Callers answer 404 for both: confirming that someone else's product id is
 * real would leak catalogue membership across tenants.
 */
async function findOwnedProduct(
  supabase: ReturnType<typeof createAdminSupabase>,
  productId: string,
  guildId: string,
): Promise<{ id: string; name: string } | null> {
  const { data } = await supabase
    .from('products')
    .select('id, name')
    .eq('id', productId)
    .eq('guild_id', guildId)
    .maybeSingle();
  return (data as { id: string; name: string } | null) ?? null;
}

/** Uniform answer for "not yours" and "not there" — deliberately identical. */
function productNotFound() {
  return NextResponse.json(
    { success: false, error: 'Product not found' },
    { status: 404 },
  );
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ productId: string }> },
) {
  const auth = await requireGuildOwner();
  if (!auth.ok) return auth.response;
  const { guildId } = auth.ctx;

  const { productId } = await params;
  const supabase = createAdminSupabase();

  // Tenancy gate. Without this, any owner could read any guild's licence
  // configuration — device caps, tiers, offline grace — by naming its product id.
  if (!(await findOwnedProduct(supabase, productId, guildId))) {
    return productNotFound();
  }

  const { data, error } = await supabase
    .from('product_license_config')
    .select('*')
    .eq('product_id', productId)
    .maybeSingle();

  if (error) {
    return dbError(error, 'license/config');
  }

  // Return defaults if no config exists
  if (!data) {
    return NextResponse.json({
      success: true,
      data: {
        product_id: productId,
        license_mode: 'portal_only',
        key_prefix: 'SMNI',
        max_devices: 3,
        heartbeat_interval_seconds: 300,
        heartbeat_interval_ms: 300000,
        sdk_cache_ttl_ms: 60000,
        offline_grace_period_seconds: 86400,
        feature_flags: [],
        tier: null,
        watermark_config: null,
        require_discord_guild_membership: true,
        // Hash-only storage is a security invariant, never an editable flag.
        store_keys_hashed: true,
        rotation_policy: 'rotate-and-invalidate',
        self_service_device_removal: true,
      },
    });
  }

  return NextResponse.json({
    success: true,
    data: {
      ...data,
      heartbeat_interval_ms:
        typeof data.heartbeat_interval_seconds === 'number'
          ? data.heartbeat_interval_seconds * 1000
          : null,
      // This is deliberately read-only: no plaintext key column exists and
      // all issuance/rotation paths hash before persistence.
      store_keys_hashed: true,
    },
  });
}

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ productId: string }> },
) {
  const rateLimited = await checkAdminRateLimit(req, 'write');
  if (rateLimited) return rateLimited;

  const auth = await requireGuildOwner();
  if (!auth.ok) return auth.response;
  const { guildId } = auth.ctx;

  const { productId } = await params;
  const supabase = createAdminSupabase();
  const parsed = await parseBody(req, schemas.license.config);
  if (!parsed.ok) return parsed.response;
  const body = parsed.data;

  const {
    license_mode,
    key_prefix,
    max_devices,
    heartbeat_interval_seconds,
    heartbeat_interval_ms,
    sdk_cache_ttl_ms,
    offline_grace_period_seconds,
    feature_flags,
    tier,
    watermark_config,
    require_discord_guild_membership,
    rotation_policy,
    self_service_device_removal,
  } = body;

  // Tenancy gate, BEFORE reading or writing the product config. The service
  // role bypasses RLS, so ownership must be established explicitly.
  const product = await findOwnedProduct(supabase, productId, guildId);
  if (!product) {
    return productNotFound();
  }

  // Read the current row before constructing defaults. A partial owner save
  // must not silently reset another policy (especially a custom key prefix).
  const before = await readRowBefore(
    supabase,
    'product_license_config',
    { product_id: productId },
  );

  const priorFeatureFlags = before?.feature_flags;
  const normalizedPriorFeatureFlags = Array.isArray(priorFeatureFlags)
    ? priorFeatureFlags
    : priorFeatureFlags && typeof priorFeatureFlags === 'object'
      ? Object.entries(priorFeatureFlags as Record<string, unknown>)
          .filter(([, enabled]) => enabled !== false && enabled !== null)
          .map(([flag]) => flag)
      : [];

  const normalizedFeatureFlags = feature_flags === undefined
    ? normalizedPriorFeatureFlags
    : Array.isArray(feature_flags)
      ? feature_flags
      : feature_flags && typeof feature_flags === 'object'
        ? Object.entries(feature_flags)
          .filter(([, enabled]) => enabled !== false && enabled !== null)
          .map(([flag]) => flag)
        : [];

  const written: Record<string, unknown> = {
    license_mode: license_mode ?? before?.license_mode ?? 'portal_only',
    key_prefix: key_prefix ?? before?.key_prefix ?? 'SMNI',
    max_devices: max_devices ?? before?.max_devices ?? 3,
    heartbeat_interval_seconds:
      heartbeat_interval_seconds
      ?? (heartbeat_interval_ms !== undefined
        ? heartbeat_interval_ms / 1000
        : before?.heartbeat_interval_seconds ?? 300),
    sdk_cache_ttl_ms: sdk_cache_ttl_ms ?? before?.sdk_cache_ttl_ms ?? 60000,
    offline_grace_period_seconds: offline_grace_period_seconds ?? before?.offline_grace_period_seconds ?? 86400,
    feature_flags: normalizedFeatureFlags,
    tier: tier ?? before?.tier ?? null,
    watermark_config: watermark_config ?? before?.watermark_config ?? null,
    require_discord_guild_membership: require_discord_guild_membership ?? before?.require_discord_guild_membership ?? true,
    rotation_policy: rotation_policy ?? before?.rotation_policy ?? 'rotate-and-invalidate',
    self_service_device_removal: self_service_device_removal ?? before?.self_service_device_removal ?? true,
  };

  const { data, error } = await supabase
    .from('product_license_config')
    .upsert(
      {
        product_id: productId,
        ...written,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'product_id' },
    )
    .select()
    .single();

  if (error) {
    return dbError(error, 'license/config');
  }

  // The upsert always writes all configured columns, so listing them all would
  // describe every save as changing everything. Report only what really moved.
  const changed = before
    ? LICENSE_CONFIG_COLUMNS.filter((column) => {
        // Rows created before the owner-controls migration legitimately lack
        // the new columns. Treat those absent values as their shipped
        // defaults, and normalize the historical object-shaped feature_flags
        // payload, so a no-op save does not emit a false audit event.
        const priorValue = column === 'feature_flags' && before[column] && typeof before[column] === 'object' && !Array.isArray(before[column])
          ? Object.entries(before[column] as Record<string, unknown>)
              .filter(([, enabled]) => enabled !== false && enabled !== null)
              .map(([flag]) => flag)
          : before[column] ?? written[column];
        return !sameValue(priorValue, written[column]);
      })
    : [...LICENSE_CONFIG_COLUMNS];

  if (changed.length > 0) {
    const priorForChanged = before
      ? Object.fromEntries(
          changed.filter((column) => column in before).map((column) => [column, before[column]]),
        )
      : null;
    // Ownership is no longer part of this test — an unowned product can no
    // longer reach here at all.
    const canRestore = priorForChanged != null
      && Object.keys(priorForChanged).length === changed.length;

    await recordAdminChange(
      {
        guildId,
        actorId: auth.ctx.discordId,
        action: 'license.config_updated',
        targetType: 'product license settings',
        targetId: productId,
        description:
          `${describeSettingChange([...changed])} in the license settings for the store `
          + `product "${product.name}"`,
        before: priorForChanged ?? undefined,
        after: Object.fromEntries(changed.map((column) => [column, written[column]])),
        // These settings decide whether a paying customer's installed copy keeps
        // working — how many devices, how long offline, which tier.
        blastRadius: 'high',
        ...(canRestore
          ? {
              undo: undoByRestoring(
                'product_license_config',
                { product_id: productId },
                priorForChanged,
              ),
            }
          : {
              undoReason: before
                ? 'the previous license settings could not be read, so there is nothing to restore'
                : 'this product had no saved license settings before, so there is nothing to restore',
            }),
      },
      supabase,
    );
  }

  return NextResponse.json({ success: true, data });
}
