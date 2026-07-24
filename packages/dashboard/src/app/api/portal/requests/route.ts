/**
 * POST /api/portal/requests — Buyer self-service refund / service request.
 *
 * Commerce-portal contracts self-service refund-requests and service-requests
 * (both default-ON). This endpoint lets an authenticated portal customer file a
 * request that lands in the owner's dashboard queue. It NEVER mutates payments,
 * orders, or entitlements — it only queues an owner decision.
 *
 * Auth: x-portal-token header (same session model as the other portal routes).
 * Body: { type: 'refund' | 'service', order_id?: uuid, reason?: string }
 */
import { NextResponse, type NextRequest } from 'next/server';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { createHash } from 'crypto';
import { z } from 'zod';
import { parseBody } from '@/lib/api/validation';
import { rateLimits } from '@/lib/api/rate-limit';

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

const portalRequestSchema = z.object({
  type: z.enum(['refund', 'service']),
  order_id: z.string().uuid().optional().nullable(),
  reason: z.string().max(2000).optional().nullable(),
});

export async function POST(request: NextRequest) {
  try {
    const token = request.headers.get('x-portal-token');
    if (!token) {
      return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
    }

    const admin = createAdminSupabase();
    const { data: session } = await admin
      .from('portal_sessions')
      .select('customer_id, guild_id')
      .eq('token_hash', hashToken(token))
      .eq('revoked', false)
      .gt('expires_at', new Date().toISOString())
      .single();

    if (!session) {
      return NextResponse.json({ error: 'Invalid or expired session' }, { status: 401 });
    }

    const rl = await rateLimits.portalData(hashToken(token));
    if (rl.limited) {
      return NextResponse.json({ error: 'Too many requests' }, { status: 429 });
    }

    const parsed = await parseBody(request, portalRequestSchema);
    if (!parsed.ok) return parsed.response;
    const { type, order_id, reason } = parsed.data;

    // If an order is referenced, it MUST belong to this customer in this guild —
    // never reveal or act on another customer's / guild's order.
    if (order_id) {
      const { data: order } = await admin
        .from('orders')
        .select('id')
        .eq('id', order_id)
        .eq('customer_id', session.customer_id)
        .eq('guild_id', session.guild_id)
        .maybeSingle();
      if (!order) {
        return NextResponse.json({ error: 'Order not found' }, { status: 404 });
      }
    }

    // Idempotency: a repeated filing resolves to the single existing pending
    // request rather than stacking duplicates (the partial unique index
    // uniq_pending_portal_request is the backstop for concurrent races).
    const dedupeBase = admin
      .from('commerce_portal_requests')
      .select('id, type, status, order_id, reason, created_at')
      .eq('customer_id', session.customer_id)
      .eq('type', type)
      .eq('status', 'pending');
    const { data: existing } = order_id
      ? await dedupeBase.eq('order_id', order_id).maybeSingle()
      : await dedupeBase.is('order_id', null).maybeSingle();

    if (existing) {
      return NextResponse.json(
        { success: true, data: existing, deduped: true, message: 'request-received' },
      );
    }

    const { data: created, error: insertError } = await admin
      .from('commerce_portal_requests')
      .insert({
        guild_id: session.guild_id,
        customer_id: session.customer_id,
        order_id: order_id ?? null,
        type,
        reason: reason ?? null,
        status: 'pending',
      })
      .select('id, type, status, order_id, reason, created_at')
      .single();

    if (insertError) {
      // 23505 = a concurrent filing already opened the pending request. Resolve
      // idempotently to the existing entry.
      if (insertError.code === '23505') {
        const raceBase = admin
          .from('commerce_portal_requests')
          .select('id, type, status, order_id, reason, created_at')
          .eq('customer_id', session.customer_id)
          .eq('type', type)
          .eq('status', 'pending');
        const { data: raced } = order_id
          ? await raceBase.eq('order_id', order_id).maybeSingle()
          : await raceBase.is('order_id', null).maybeSingle();
        return NextResponse.json(
          { success: true, data: raced, deduped: true, message: 'request-received' },
        );
      }
      return NextResponse.json({ error: insertError.message }, { status: 500 });
    }

    return NextResponse.json(
      { success: true, data: created, message: 'request-received' },
      { status: 201 },
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Unknown error';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
