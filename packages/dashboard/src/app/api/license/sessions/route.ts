/**
 * GET /api/license/sessions — List sessions for a license key (admin).
 *
 * Query param: key_id (license_keys.id)
 */
import { NextRequest, NextResponse } from 'next/server';
import { createAdminSupabase } from '@/lib/supabase/admin';

export async function GET(req: NextRequest) {
  const supabase = createAdminSupabase();
  const { searchParams } = new URL(req.url);
  const keyId = searchParams.get('key_id');

  if (!keyId) {
    return NextResponse.json({ success: false, error: 'Missing key_id' }, { status: 400 });
  }

  // Get license config for max_devices
  const { data: licenseKey } = await supabase
    .from('license_keys')
    .select('product_id')
    .eq('id', keyId)
    .single();

  let maxDevices = 3;
  if (licenseKey) {
    const { data: config } = await supabase
      .from('product_license_config')
      .select('max_devices')
      .eq('product_id', licenseKey.product_id)
      .maybeSingle();
    if (config) maxDevices = config.max_devices;
  }

  const { data: sessions, error } = await supabase
    .from('license_sessions')
    .select('*')
    .eq('license_key_id', keyId)
    .order('last_seen_at', { ascending: false });

  if (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }

  const activeCount = (sessions ?? []).filter((s) => s.active).length;

  return NextResponse.json({
    success: true,
    data: {
      sessions: sessions ?? [],
      max_devices: maxDevices,
      active_count: activeCount,
    },
  });
}
