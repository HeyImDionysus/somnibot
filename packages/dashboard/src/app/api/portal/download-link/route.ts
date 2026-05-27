/**
 * POST /api/portal/download-link — Generate a signed download URL.
 *
 * V5 Audit Fix #5 — Replaces raw token-in-URL approach with short-lived
 * HMAC-signed download links. The portal token is verified via header,
 * then a 5-minute signed URL is returned.
 *
 * Request body: { productId: string, fileId: string }
 * Response:     { url: string }
 */
import { NextResponse, type NextRequest } from 'next/server';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { createHash } from 'crypto';
import { z } from 'zod';
import { generateSignedDownloadUrl } from '@/lib/api/signed-url';
import { rateLimits } from '@/lib/api/rate-limit';

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export async function POST(request: NextRequest) {
  try {
    // Authenticate via portal token header
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

    // V6 Audit §7.1: Rate-limit portal data reads per token
    const rl = await rateLimits.portalData(hashToken(token));
    if (rl.limited) {
      return NextResponse.json({ error: 'Too many requests' }, { status: 429 });
    }

    // Parse request body — V6 Audit §7.1: Zod validation
    const bodySchema = z.object({
      productId: z.string().uuid(),
      fileId: z.string().uuid(),
    });
    const parsed = bodySchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'productId (uuid) and fileId (uuid) are required' },
        { status: 400 },
      );
    }

    const { productId, fileId } = parsed.data;

    // Verify entitlement exists
    const { data: entitlement } = await admin
      .from('entitlements')
      .select('id')
      .eq('customer_id', session.customer_id)
      .eq('product_id', productId)
      .eq('guild_id', session.guild_id)
      .in('status', ['active', 'grace_period'])
      .limit(1)
      .maybeSingle();

    if (!entitlement) {
      return NextResponse.json({ error: 'No active entitlement for this product' }, { status: 403 });
    }

    // Verify file exists
    const { data: file } = await admin
      .from('product_files')
      .select('id')
      .eq('id', fileId)
      .eq('product_id', productId)
      .single();

    if (!file) {
      return NextResponse.json({ error: 'File not found' }, { status: 404 });
    }

    // Generate signed URL (5 min expiry)
    const url = generateSignedDownloadUrl({
      productId,
      fileId,
      customerId: session.customer_id,
      guildId: session.guild_id,
    });

    return NextResponse.json({ url });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Unknown error';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
