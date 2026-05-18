/**
 * /api/license-keys/[key] — License key lookup (admin).
 *
 * GET: Look up a key by hash or prefix+suffix
 * PUT: Update key status (revoke, suspend, etc.)
 */
import { NextRequest, NextResponse } from 'next/server';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { createHash } from 'crypto';
import { requireGuildOwner } from '@/lib/api/require-owner';
import { parseBody, schemas } from '@/lib/api/validation';

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ key: string }> },
) {
  const auth = await requireGuildOwner();
  if (!auth.ok) return auth.response;
  const { guildId } = auth.ctx;

  const { key } = await params;
  const supabase = createAdminSupabase();

  // Try by ID first
  let query = supabase
    .from('license_keys')
    .select('*, products(name), customers(discord_username, discord_id, email)')
    .eq('id', key)
    .maybeSingle();

  let { data } = await query;

  // If not found by ID, try by key hash
  if (!data) {
    const keyHash = createHash('sha256').update(key.toUpperCase()).digest('hex');
    const res = await supabase
      .from('license_keys')
      .select('*, products(name), customers(discord_username, discord_id, email)')
      .eq('key_hash', keyHash)
      .maybeSingle();
    data = res.data;
  }

  if (!data) {
    return NextResponse.json({ success: false, error: 'License key not found' }, { status: 404 });
  }

  // Fetch sessions
  const { data: sessions } = await supabase
    .from('license_sessions')
    .select('*')
    .eq('license_key_id', data.id)
    .order('last_seen_at', { ascending: false });

  return NextResponse.json({
    success: true,
    data: { ...data, sessions: sessions ?? [] },
  });
}

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ key: string }> },
) {
  const auth = await requireGuildOwner();
  if (!auth.ok) return auth.response;
  const { guildId } = auth.ctx;

  const { key: keyId } = await params;
  const supabase = createAdminSupabase();
  const parsed = await parseBody(req, schemas.licenseKey.update);
  if (!parsed.ok) return parsed.response;
  const body = parsed.data;

  const { status, revocation_reason } = body;

  if (!status) {
    return NextResponse.json({ success: false, error: 'Missing status' }, { status: 400 });
  }

  const updateData: Record<string, unknown> = {
    status,
    updated_at: new Date().toISOString(),
  };

  if (status === 'revoked') {
    updateData.revoked_at = new Date().toISOString();
    updateData.revocation_reason = revocation_reason ?? 'Admin revocation';

    // Also deactivate sessions
    await supabase
      .from('license_sessions')
      .update({
        active: false,
        deactivated_at: new Date().toISOString(),
        deactivation_reason: 'admin_revoked',
      })
      .eq('license_key_id', keyId)
      .eq('active', true);
  }

  const { data, error } = await supabase
    .from('license_keys')
    .update(updateData)
    .eq('id', keyId)
    .select()
    .single();

  if (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }

  return NextResponse.json({ success: true, data });
}
