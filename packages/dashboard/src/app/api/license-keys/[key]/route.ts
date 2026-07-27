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
import { dbError } from '@/lib/api/response';
import { writeCommerceAudit } from '@/lib/commerce-audit';
import { recordAdminChange } from '@/lib/admin-changes';

/**
 * `ABCD…WXYZ` — how an owner recognises a key they never see in full.
 * Only the prefix and suffix are stored at rest; the key itself is hashed.
 */
function keyFingerprint(row: { key_prefix?: unknown; key_suffix?: unknown }): string {
  const prefix = typeof row.key_prefix === 'string' ? row.key_prefix : '';
  const suffix = typeof row.key_suffix === 'string' ? row.key_suffix : '';
  return prefix || suffix ? `${prefix}…${suffix}` : 'this key';
}

/** Read an embedded `products(name)` / `customers(discord_username)` field. */
function embedded(row: Record<string, unknown>, key: string, field: string): unknown {
  const value = row[key];
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return (value as Record<string, unknown>)[field];
  }
  return undefined;
}

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
  const { guildId, discordId } = auth.ctx;

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
  //
  // This is also the pre-write read for the change record: the prior status and
  // the names are gone once the update below lands.
  const { data: keyRow } = await supabase
    .from('license_keys')
    .select('id, status, key_prefix, key_suffix, products(name), customers(discord_username)')
    .eq('id', keyId)
    .eq('guild_id', guildId)
    .maybeSingle();

  if (!keyRow) {
    return NextResponse.json({ success: false, error: 'License key not found' }, { status: 404 });
  }

  let sessionsRevoked = 0;
  if (status === 'revoked') {
    updateData.revoked_at = new Date().toISOString();
    updateData.revocation_reason = revocation_reason ?? 'Admin revocation';

    // Also deactivate sessions
    const { data: revokedSessions } = await supabase
      .from('license_sessions')
      .update({
        active: false,
        deactivated_at: new Date().toISOString(),
        deactivation_reason: 'admin_revoked',
      })
      .eq('license_key_id', keyId)
      .eq('active', true)
      .select('id');
    sessionsRevoked = revokedSessions?.length ?? 0;
  }

  const { data, error } = await supabase
    .from('license_keys')
    .update(updateData)
    .eq('id', keyId)
    .eq('guild_id', guildId)
    .select()
    .single();

  if (error) {
    return dbError(error, 'license-keys');
  }

  // Append-only audit: license-key status change (revoke/suspend/reactivate).
  // Previously only /license activate was audited — revocation and the cascade
  // of device-session deactivations left no durable trail.
  await writeCommerceAudit(supabase, {
    guildId,
    actorType: 'user',
    actorId: discordId,
    action: status === 'revoked' ? 'license.revoked' : 'license.status_changed',
    targetType: 'license_key',
    targetId: keyId,
    details: {
      status,
      revocationReason: status === 'revoked' ? (revocation_reason ?? 'Admin revocation') : undefined,
      sessionsRevoked,
    },
  });

  // The audit_logs row above is the append-only compliance trail; this is the
  // owner-facing "what changed in my server" entry, which the audit log is not.
  const row = keyRow as Record<string, unknown>;
  const fingerprint = keyFingerprint(row);
  const productName = embedded(row, 'products', 'name');
  const forProduct = typeof productName === 'string' && productName !== ''
    ? ` for the store product "${productName}"`
    : '';
  const username = embedded(row, 'customers', 'discord_username');
  const forCustomer = typeof username === 'string' && username !== ''
    ? ` (customer ${username})`
    : '';
  const sessionClause = sessionsRevoked > 0
    ? `, signing out ${sessionsRevoked} active device${sessionsRevoked === 1 ? '' : 's'}`
    : '';

  await recordAdminChange(
    {
      guildId,
      actorId: discordId,
      action: status === 'revoked' ? 'license.key_revoked' : 'license.key_status_changed',
      targetType: 'license key',
      targetId: keyId,
      description: status === 'revoked'
        ? `Revoked the license key ${fingerprint}${forProduct}${forCustomer} — their `
          + `installed copy stops working${sessionClause}`
        : `Changed the license key ${fingerprint}${forProduct}${forCustomer} from `
          + `${row.status ?? 'its previous status'} to ${status}`,
      before: { status: row.status ?? null },
      after: {
        status,
        ...(status === 'revoked'
          ? {
              revocation_reason: revocation_reason ?? 'Admin revocation',
              sessions_revoked: sessionsRevoked,
            }
          : {}),
      },
      // A revoked or suspended key breaks a paying customer's working install.
      blastRadius: status === 'revoked' || status === 'suspended' ? 'high' : 'medium',
      // `license_keys` is deliberately absent from the undo allowlist, and the
      // device sessions this revocation deactivated are not restored by a
      // license_keys row update — an undo button would only look like it worked.
      // The key STRING itself is untouched (it is never regenerated here), so
      // setting the status back does make the customer's existing key valid
      // again; they just have to activate their devices afresh.
      undoReason: status === 'revoked'
        ? 'undo cannot restore a revoked key — set its status back to active by hand; '
          + 'the customer\'s existing key string still works, but the devices it signed '
          + 'out must be activated again'
        : 'license key status changes are outside the dashboard undo system — set the '
          + 'status back by hand',
    },
    supabase,
  );

  return NextResponse.json({ success: true, data });
}
