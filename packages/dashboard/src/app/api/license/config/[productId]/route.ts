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
  'max_devices',
  'heartbeat_interval_seconds',
  'offline_grace_period_seconds',
  'feature_flags',
  'tier',
  'watermark_config',
  'require_discord_guild_membership',
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

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ productId: string }> },
) {
  const auth = await requireGuildOwner();
  if (!auth.ok) return auth.response;
  const { guildId } = auth.ctx;

  const { productId } = await params;
  const supabase = createAdminSupabase();

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
        max_devices: 3,
        heartbeat_interval_seconds: 300,
        offline_grace_period_seconds: 86400,
        feature_flags: [],
        tier: null,
        watermark_config: null,
        require_discord_guild_membership: true,
      },
    });
  }

  return NextResponse.json({ success: true, data });
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
    max_devices,
    heartbeat_interval_seconds,
    offline_grace_period_seconds,
    feature_flags,
    tier,
    watermark_config,
    require_discord_guild_membership,
  } = body;

  const written: Record<string, unknown> = {
    license_mode: license_mode ?? 'portal_only',
    max_devices: max_devices ?? 3,
    heartbeat_interval_seconds: heartbeat_interval_seconds ?? 300,
    offline_grace_period_seconds: offline_grace_period_seconds ?? 86400,
    feature_flags: feature_flags ?? [],
    tier: tier ?? null,
    watermark_config: watermark_config ?? null,
    require_discord_guild_membership: require_discord_guild_membership ?? true,
  };

  // Resolve the product THROUGH this guild. It supplies the product name for
  // the change description, and its absence is the signal that the row being
  // written does not belong to the caller — in which case no undo is offered,
  // because the undo route's tenancy check would refuse it at click time.
  const { data: product } = await supabase
    .from('products')
    .select('id, name')
    .eq('id', productId)
    .eq('guild_id', guildId)
    .maybeSingle();

  // Prior values, read before the upsert: this is what an undo restores.
  const before = await readRowBefore(
    supabase,
    'product_license_config',
    { product_id: productId },
  );

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

  // The upsert always writes all eight columns, so listing them all would
  // describe every save as changing everything. Report only what really moved.
  const changed = before
    ? LICENSE_CONFIG_COLUMNS.filter((column) => !sameValue(before[column], written[column]))
    : [...LICENSE_CONFIG_COLUMNS];

  if (changed.length > 0) {
    const priorForChanged = before
      ? Object.fromEntries(
          changed.filter((column) => column in before).map((column) => [column, before[column]]),
        )
      : null;
    const canRestore = product != null
      && priorForChanged != null
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
          + `product "${(product as { name?: string } | null)?.name ?? productId}"`,
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
