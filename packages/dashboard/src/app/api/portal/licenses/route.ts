/**
 * GET /api/portal/licenses — Customer's license keys and active sessions.
 * Requires: x-portal-token header.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { createHash } from 'crypto';

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

    const admin = createAdminSupabase();

    // Get license keys
    const { data: keys } = await admin
      .from('license_keys')
      .select('*, products(name, type), license_sessions(id, device_name, device_fingerprint, ip_address, active, first_seen_at, last_seen_at)')
      .eq('customer_id', session.customer_id)
      .order('created_at', { ascending: false });

    return NextResponse.json({ success: true, data: keys || [] });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Unknown error';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
