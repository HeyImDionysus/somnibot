/**
 * POST /api/license/deactivate — Device cleanup (app uninstall).
 *
 * Architecture doc §30.10.
 */
import { NextRequest, NextResponse } from 'next/server';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { createHash } from 'crypto';
import { parseBody, schemas } from '@/lib/api/validation';

function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

export async function POST(req: NextRequest) {
  const supabase = createAdminSupabase();

  let body: { session_id: string; license_key: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ success: false, error: 'Invalid request body' }, { status: 400 });
  }

  const { session_id, license_key } = body;

  if (!session_id || !license_key) {
    return NextResponse.json(
      { success: false, error: 'session_id and license_key are required' },
      { status: 400 },
    );
  }

  // Verify key ownership
  const keyHash = sha256(license_key);
  const { data: licenseKey } = await supabase
    .from('license_keys')
    .select('id')
    .eq('key_hash', keyHash)
    .single();

  if (!licenseKey) {
    return NextResponse.json({ success: false, error: 'Invalid license key' }, { status: 400 });
  }

  // Deactivate the session
  const { error } = await supabase
    .from('license_sessions')
    .update({
      active: false,
      deactivated_at: new Date().toISOString(),
      deactivation_reason: 'user_deactivated',
    })
    .eq('id', session_id)
    .eq('license_key_id', licenseKey.id);

  if (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}
