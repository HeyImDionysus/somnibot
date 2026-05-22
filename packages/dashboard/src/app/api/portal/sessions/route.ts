/**
 * /api/portal/sessions — Manage customer portal sessions.
 *
 * V53 Phase 3 (Finding 1.9): Portal Session Revocation UI.
 *
 * GET:    List active sessions for a customer
 * DELETE: Revoke one or all sessions for a customer
 */
import { NextRequest, NextResponse } from 'next/server';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { requireGuildOwner } from '@/lib/api/require-owner';

const MAX_CONCURRENT_SESSIONS = 3;

export async function GET(req: NextRequest) {
  const auth = await requireGuildOwner();
  if (!auth.ok) return auth.response;
  const { guildId } = auth.ctx;

  const { searchParams } = new URL(req.url);
  const customerId = searchParams.get('customer_id');
  if (!customerId) {
    return NextResponse.json({ success: false, error: 'customer_id required' }, { status: 400 });
  }

  const supabase = createAdminSupabase();

  const { data, error } = await supabase
    .from('portal_sessions')
    .select('id, customer_id, discord_id, ip_address, user_agent, created_at, last_used_at, expires_at, revoked')
    .eq('guild_id', guildId)
    .eq('customer_id', customerId)
    .eq('revoked', false)
    .gt('expires_at', new Date().toISOString())
    .order('created_at', { ascending: false });

  if (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }

  return NextResponse.json({
    success: true,
    data: data ?? [],
    maxConcurrent: MAX_CONCURRENT_SESSIONS,
  });
}

export async function DELETE(req: NextRequest) {
  const auth = await requireGuildOwner();
  if (!auth.ok) return auth.response;
  const { guildId } = auth.ctx;

  const body = await req.json().catch(() => ({}));
  const { customer_id, session_id, revoke_all } = body as {
    customer_id?: string;
    session_id?: string;
    revoke_all?: boolean;
  };

  if (!customer_id) {
    return NextResponse.json({ success: false, error: 'customer_id required' }, { status: 400 });
  }

  const supabase = createAdminSupabase();

  if (revoke_all) {
    // Revoke all active sessions
    const { error } = await supabase
      .from('portal_sessions')
      .update({ revoked: true })
      .eq('guild_id', guildId)
      .eq('customer_id', customer_id)
      .eq('revoked', false);

    if (error) {
      return NextResponse.json({ success: false, error: error.message }, { status: 500 });
    }
    return NextResponse.json({ success: true, message: 'All sessions revoked' });
  }

  if (!session_id) {
    return NextResponse.json({ success: false, error: 'session_id or revoke_all required' }, { status: 400 });
  }

  // Revoke a single session
  const { error } = await supabase
    .from('portal_sessions')
    .update({ revoked: true })
    .eq('id', session_id)
    .eq('guild_id', guildId)
    .eq('customer_id', customer_id);

  if (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }

  return NextResponse.json({ success: true, message: 'Session revoked' });
}
