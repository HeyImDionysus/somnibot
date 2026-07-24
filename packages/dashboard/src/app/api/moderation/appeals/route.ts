/**
 * /api/moderation/appeals — review queue for member infraction appeals.
 *
 * GET:   List appeals for the active guild (optional status filter, pagination).
 * PATCH: Decide a pending appeal (approve / deny).
 *
 * Deciding is ATOMIC on `status = 'pending'`, so a double-click or two owners
 * acting at once cannot re-decide an already-resolved appeal. The member DM is
 * delivered out-of-band by the bot's appeals maintenance sweep (it watches for
 * decided-but-unnotified rows), so this route never talks to Discord directly.
 */
import { NextRequest, NextResponse } from 'next/server';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { requireGuildOwner } from '@/lib/api/require-owner';
import { checkAdminRateLimit } from '@/lib/api/admin-rate-limit';
import { dbError } from '@/lib/api/response';

const VALID_STATUSES = ['pending', 'approved', 'denied', 'expired'] as const;
type AppealStatus = (typeof VALID_STATUSES)[number];

const ACTION_TO_STATUS: Record<string, Extract<AppealStatus, 'approved' | 'denied'>> = {
  approve: 'approved',
  deny: 'denied',
};

export async function GET(req: NextRequest) {
  const auth = await requireGuildOwner();
  if (!auth.ok) return auth.response;
  const { guildId } = auth.ctx;

  const supabase = createAdminSupabase();
  const { searchParams } = new URL(req.url);

  const statusParam = searchParams.get('status');
  const limit = Math.min(Math.max(parseInt(searchParams.get('limit') ?? '50', 10) || 50, 1), 100);
  const offset = Math.max(parseInt(searchParams.get('offset') ?? '0', 10) || 0, 0);

  let query = supabase
    .from('appeals')
    .select('*', { count: 'exact' })
    .eq('guild_id', guildId)
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1)
    .limit(1000);

  if (statusParam) {
    if (!VALID_STATUSES.includes(statusParam as AppealStatus)) {
      return NextResponse.json(
        { success: false, error: `Invalid status. Must be one of: ${VALID_STATUSES.join(', ')}` },
        { status: 400 },
      );
    }
    query = query.eq('status', statusParam);
  }

  const { data, error, count } = await query;
  if (error) {
    return dbError(error, 'moderation/appeals');
  }

  return NextResponse.json({
    success: true,
    data: data ?? [],
    total: count ?? 0,
    limit,
    offset,
  });
}

export async function PATCH(req: NextRequest) {
  const rateLimited = await checkAdminRateLimit(req, 'write');
  if (rateLimited) return rateLimited;

  const auth = await requireGuildOwner();
  if (!auth.ok) return auth.response;
  const { guildId, discordId } = auth.ctx;

  const supabase = createAdminSupabase();

  let body: { id?: unknown; action?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ success: false, error: 'Invalid JSON body' }, { status: 400 });
  }

  const id = typeof body.id === 'string' ? body.id : '';
  const action = typeof body.action === 'string' ? body.action : '';

  if (!id) {
    return NextResponse.json({ success: false, error: 'Missing appeal id' }, { status: 400 });
  }

  const nextStatus = ACTION_TO_STATUS[action];
  if (!nextStatus) {
    return NextResponse.json(
      { success: false, error: 'Unknown action. Must be one of: approve, deny' },
      { status: 400 },
    );
  }

  // Atomic decision: only a still-pending appeal in THIS guild can be decided.
  // decision_notified is reset so the bot's sweep DMs the member exactly once.
  const { data, error } = await supabase
    .from('appeals')
    .update({
      status: nextStatus,
      reviewer_id: discordId,
      decided_at: new Date().toISOString(),
      decision_notified: false,
    })
    .eq('id', id)
    .eq('guild_id', guildId)
    .eq('status', 'pending')
    .select()
    .maybeSingle();

  if (error) {
    return dbError(error, 'moderation/appeals');
  }

  if (!data) {
    // Not found in this guild, or no longer pending (already decided/expired).
    return NextResponse.json(
      { success: false, error: 'Appeal not found or already decided.' },
      { status: 409 },
    );
  }

  // TODO(audit): appeal.approved / appeal.denied — emit an audit event once the
  // audit wave wires appeal.* into events.ts / audit-service.ts.

  return NextResponse.json({ success: true, data });
}
