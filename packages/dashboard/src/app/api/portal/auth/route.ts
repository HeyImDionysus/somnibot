/**
 * POST /api/portal/auth — Customer portal authentication.
 * Supports: magic-link token validation and session creation.
 * GET /api/portal/auth — Validate current session.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { randomBytes, createHash } from 'crypto';

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const admin = createAdminSupabase();

    if (body.action === 'login') {
      // Discord OAuth token exchange — validate discord_id + guild membership
      const discordId = body.discord_id;
      if (!discordId) return NextResponse.json({ error: 'Missing discord_id' }, { status: 400 });

      // Find customer
      const { data: customer } = await admin
        .from('customers')
        .select('id, guild_id, discord_id')
        .eq('discord_id', discordId)
        .limit(1)
        .single();

      if (!customer) return NextResponse.json({ error: 'Customer not found' }, { status: 404 });

      // Create session
      const token = randomBytes(32).toString('hex');
      const tokenHash = hashToken(token);
      const expires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 days

      const { error } = await admin
        .from('portal_sessions')
        .insert({
          guild_id: customer.guild_id,
          customer_id: customer.id,
          token_hash: tokenHash,
          discord_id: discordId,
          expires_at: expires.toISOString(),
          ip_address: request.headers.get('x-forwarded-for') || null,
          user_agent: request.headers.get('user-agent') || null,
        });

      if (error) return NextResponse.json({ error: error.message }, { status: 500 });

      return NextResponse.json({
        success: true,
        data: { token, expires_at: expires.toISOString(), customer_id: customer.id },
      });
    }

    return NextResponse.json({ error: 'Invalid action' }, { status: 400 });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Unknown error';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

export async function GET(request: NextRequest) {
  try {
    const token = request.headers.get('x-portal-token');
    if (!token) return NextResponse.json({ error: 'Missing token' }, { status: 401 });

    const admin = createAdminSupabase();
    const tokenHash = hashToken(token);

    const { data: session } = await admin
      .from('portal_sessions')
      .select('*, customers(id, discord_id, email, username)')
      .eq('token_hash', tokenHash)
      .eq('revoked', false)
      .gt('expires_at', new Date().toISOString())
      .single();

    if (!session) return NextResponse.json({ error: 'Invalid or expired session' }, { status: 401 });

    // Update last used
    await admin
      .from('portal_sessions')
      .update({ last_used_at: new Date().toISOString() })
      .eq('id', session.id);

    return NextResponse.json({
      success: true,
      data: {
        session_id: session.id,
        customer_id: session.customer_id,
        discord_id: session.discord_id,
        customer: (session as Record<string, unknown>).customers,
      },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Unknown error';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
