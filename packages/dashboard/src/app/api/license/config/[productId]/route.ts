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
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
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

  const { data, error } = await supabase
    .from('product_license_config')
    .upsert(
      {
        product_id: productId,
        license_mode: license_mode ?? 'portal_only',
        max_devices: max_devices ?? 3,
        heartbeat_interval_seconds: heartbeat_interval_seconds ?? 300,
        offline_grace_period_seconds: offline_grace_period_seconds ?? 86400,
        feature_flags: feature_flags ?? [],
        tier: tier ?? null,
        watermark_config: watermark_config ?? null,
        require_discord_guild_membership: require_discord_guild_membership ?? true,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'product_id' },
    )
    .select()
    .single();

  if (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }

  return NextResponse.json({ success: true, data });
}
