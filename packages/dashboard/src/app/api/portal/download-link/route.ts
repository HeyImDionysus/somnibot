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
import { selectDownloadEntitlement } from '@/lib/portal/select-entitlement';
import { NextResponse, type NextRequest } from 'next/server';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { createHash } from 'crypto';
import { z } from 'zod';
import { parseBody } from '@/lib/api/validation';
import { generateSignedDownloadUrl } from '@/lib/api/signed-url';
import { rateLimits } from '@/lib/api/rate-limit';
import { isEntitlementAccessLive } from '@somnibot/shared';
import { writeCommerceAudit } from '@/lib/commerce-audit';

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

    // V8 Audit §7.P3a: Use centralized parseBody() for consistency
    const downloadLinkSchema = z.object({
      productId: z.string().uuid(),
      fileId: z.string().uuid(),
    });
    const parsed = await parseBody(request, downloadLinkSchema);
    if (!parsed.ok) return parsed.response;

    const { productId, fileId } = parsed.data;

    // Verify entitlement exists AND is currently live. W2 codex: a
    // `grace_period` row whose deadline has lapsed but which reconciliation
    // (runs every ~6h) has not yet expired must NOT mint a download link —
    // otherwise the portal keeps serving a customer whose license the SDK
    // already rejects. Recompute the grace window here with the same predicate
    // license/validate + heartbeat use.
    //
    // A customer may hold more than one candidate row for the same product (a
    // re-buy, or overlapping subscription + manual grant). Fetch the whole
    // candidate set — not an arbitrary `.limit(1)` row — and mint the link if
    // ANY of them is still live, so one lapsed grace row cannot mask another
    // that is active or in an unexpired grace window.
    const { data: entitlements } = await admin
      .from('entitlements')
      .select('id, order_id, status, grace_period_ends_at, created_at')
      .eq('customer_id', session.customer_id)
      .eq('product_id', productId)
      .eq('guild_id', session.guild_id)
      .in('status', ['active', 'grace_period']);

    // Deterministic selection, newest-paid first. An unordered find() bound
    // the signed URL — and therefore the delivery evidence the control room
    // reads — to an ARBITRARY live row; with a re-buy or an overlapping manual
    // grant, the download for the current purchase could be recorded against
    // an older order (or an orderless grant), and the current paid order then
    // reported as missing its required download.
    // Which of the customer's paid orders already recorded a delivery? An
    // undelivered purchase must be able to claim its evidence before a
    // delivered one is re-served.
    const liveCandidates = (entitlements ?? []).filter((e) => isEntitlementAccessLive(e));
    const candidateOrderIds = [...new Set(
      liveCandidates
        .map((candidate) => candidate.order_id)
        .filter((id): id is string => typeof id === 'string'),
    )];
    const deliveredOrderIds = new Set<string>();
    if (candidateOrderIds.length > 0) {
      const { data: deliveries, error: deliveriesError } = await admin
        .from('commerce_download_deliveries')
        .select('order_id')
        .in('order_id', candidateOrderIds);
      if (deliveriesError) {
        return NextResponse.json(
          {
            error: 'Could not verify delivery history right now. This is a temporary server fault — please retry.',
            retryable: true,
          },
          { status: 503, headers: { 'Retry-After': '30' } },
        );
      }
      for (const delivery of deliveries ?? []) {
        if (typeof delivery.order_id === 'string') deliveredOrderIds.add(delivery.order_id);
      }
    }
    const selectedEntitlement = selectDownloadEntitlement(liveCandidates, deliveredOrderIds);
    if (!selectedEntitlement) {
      // Auditable refusal: buyer requested a download they are not entitled to.
      await writeCommerceAudit(admin, {
        guildId: session.guild_id,
        actorType: 'user',
        actorId: session.customer_id,
        action: 'portal.download_denied',
        targetType: 'product',
        targetId: productId,
        details: { reason: 'no_entitlement', customerId: session.customer_id, fileId },
        success: false,
      });
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

    const { data: portalConfig } = await admin
      .from('guild_config')
      .select('download_link_ttl_ms')
      .eq('guild_id', session.guild_id)
      .maybeSingle();
    const configuredTtl = Number(portalConfig?.download_link_ttl_ms);
    const linkTtlMs = Number.isSafeInteger(configuredTtl)
      && configuredTtl >= 60_000
      && configuredTtl <= 3_600_000
      ? configuredTtl
      : 300_000;

    // Generate signed URL with the guild's bounded TTL.
    const url = generateSignedDownloadUrl({
      productId,
      fileId,
      customerId: session.customer_id,
      guildId: session.guild_id,
      entitlementId: selectedEntitlement.id,
    }, Math.floor(linkTtlMs / 1000));

    // Auditable state change: a signed download link was issued to the buyer.
    await writeCommerceAudit(admin, {
      guildId: session.guild_id,
      actorType: 'user',
      actorId: session.customer_id,
      action: 'portal.download_link_issued',
      targetType: 'product_file',
      targetId: fileId,
      details: {
        customerId: session.customer_id,
        productId,
        fileId,
        entitlementId: selectedEntitlement.id,
        orderId: selectedEntitlement.order_id,
      },
    });

    return NextResponse.json({ url });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Unknown error';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
