import { NextResponse, type NextRequest } from 'next/server';
import { createAdminSupabase } from '@/lib/supabase/admin';

/** Public, non-customer-specific portal chrome. No session or purchase data is exposed. */
export async function GET(request: NextRequest) {
  const guildId = request.nextUrl.searchParams.get('guild')?.trim() ?? '';
  if (!guildId || guildId.length > 64) {
    return NextResponse.json({ error: 'Guild is required' }, { status: 400 });
  }

  const admin = createAdminSupabase();
  const [{ data: guild }, { data: config }] = await Promise.all([
    admin.from('guild').select('name').eq('id', guildId).maybeSingle(),
    admin.from('guild_config').select('store_brand_source, store_brand_name, portal_brand_source, brand_primary_color, brand_accent_color, store_show_powered_by, brand_logo_url, brand_header_url, brand_background_url').eq('guild_id', guildId).maybeSingle(),
  ]);

  const source = config?.portal_brand_source === 'custom' ? 'custom' : 'guild-profile';
  const name = source === 'custom' && typeof config?.store_brand_name === 'string' && config.store_brand_name.trim()
    ? config.store_brand_name.trim()
    : (guild?.name ?? 'Customer Portal');
  return NextResponse.json({
    brandName: name,
    primaryColor: config?.brand_primary_color ?? null,
    accentColor: config?.brand_accent_color ?? null,
    logoUrl: config?.brand_logo_url ?? null,
    headerUrl: config?.brand_header_url ?? null,
    backgroundUrl: config?.brand_background_url ?? null,
    poweredBy: config?.store_show_powered_by !== false,
  }, { headers: { 'Cache-Control': 'public, max-age=60' } });
}
