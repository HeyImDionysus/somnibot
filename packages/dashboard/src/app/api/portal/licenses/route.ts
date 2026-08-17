/**
 * GET /api/portal/licenses — Customer's license keys and active sessions.
 * Requires: x-portal-token header.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { createHash } from 'crypto';
import { rateLimits } from '@/lib/api/rate-limit';

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

async function getPortalCustomer(request: NextRequest) {
  const token = request.headers.get('x-portal-token');
  if (!token) return null;

  const admin = createAdminSupabase();
  const { data: session } = await admin
    .from('portal_sessions')
    .select('customer_id, guild_id')
    .eq('token_hash', hashToken(token))
    .eq('revoked', false)
    .gt('expires_at', new Date().toISOString())
    .single();

  return session;
}

export async function GET(request: NextRequest) {
  try {
    const session = await getPortalCustomer(request);
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    // V6 Audit §7.1: Rate-limit portal data reads per token
    const token = request.headers.get('x-portal-token')!;
    const rl = await rateLimits.portalData(hashToken(token));
    if (rl.limited) {
      return NextResponse.json({ error: 'Too many requests' }, { status: 429 });
    }

    const admin = createAdminSupabase();

    // Get license keys
    const { data: keys, error: keysError } = await admin
      .from('license_keys')
      .select('id, key_prefix, key_suffix, status, max_devices, expires_at, created_at, products(name, type, product_license_config(rotation_policy, self_service_device_removal)), entitlements(status, type, grace_period_ends_at), license_sessions(id, device_name, device_fingerprint, ip_address, active, first_seen_at, last_seen_at)')
      .eq('customer_id', session.customer_id)
      .eq('guild_id', session.guild_id)
      .order('created_at', { ascending: false })
      .limit(500);
    if (keysError) {
      return NextResponse.json({ error: 'Licenses could not be loaded.' }, { status: 503 });
    }

    return NextResponse.json({ success: true, data: keys || [] });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Unknown error';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
