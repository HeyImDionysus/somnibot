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
import { checkAdminRateLimit } from '@/lib/api/admin-rate-limit';

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ key: string }> },
) {
  const auth = await requireGuildOwner();
  if (!auth.ok) return auth.response;
  const { guildId } = auth.ctx;

  const { key } = await params;
  const supabase = createAdminSupabase();

  // V47-C2: scope to the caller's guild so an unrelated owner cannot enumerate
  // license keys (and the bound customer PII) by UUID guess or hash collision.
  let query = supabase
    .from('license_keys')
    .select('*, products(name), customers(discord_username, discord_id, email)')
    .eq('id', key)
    .eq('guild_id', guildId)
    .maybeSingle();

  let { data } = await query;

  // If not found by ID, try by key hash (still constrained to this guild)
  if (!data) {
    const keyHash = createHash('sha256').update(key.toUpperCase()).digest('hex');
    const res = await supabase
      .from('license_keys')
      .select('*, products(name), customers(discord_username, discord_id, email)')
      .eq('key_hash', keyHash)
      .eq('guild_id', guildId)
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
    .order('last_seen_at', { ascending: false })
    .limit(500);

  return NextResponse.json({
    success: true,
    data: { ...data, sessions: sessions ?? [] },
  });
}

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ key: string }> },
) {
  const rateLimited = await checkAdminRateLimit(req, 'write');
  if (rateLimited) return rateLimited;

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

  // V47-C2: confirm the target key belongs to this owner's guild BEFORE
  // touching any session rows. Without this gate any guild owner could
  // revoke another guild's license keys and deactivate every device session.
  const { data: keyRow } = await supabase
    .from('license_keys')
    .select('id')
    .eq('id', keyId)
    .eq('guild_id', guildId)
    .maybeSingle();

  if (!keyRow) {
    return NextResponse.json({ success: false, error: 'License key not found' }, { status: 404 });
  }

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
    .eq('guild_id', guildId)
    .select()
    .single();

  if (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }

  return NextResponse.json({ success: true, data });
}
