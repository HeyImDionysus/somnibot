/**
 * GET /api/downloads/[productId]/[fileId] — Protected file downloads.
 *
 * V5 Audit Fix #5 — Now authenticates via HMAC-signed URL parameters
 * instead of raw portal tokens in query strings. Falls back to
 * x-portal-token header for backwards compatibility.
 *
 * Signed URL params: sig, exp, cid (customer ID), gid (guild ID)
 */
import { NextRequest, NextResponse } from 'next/server';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { createHash } from 'crypto';
import { verifySignedDownloadUrl } from '@/lib/api/signed-url';
import { consumeDownloadNonce } from '@/lib/api/download-nonce';
import { rateLimits } from '@/lib/api/rate-limit';
import { isEntitlementAccessLive } from '@somnibot/shared';

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * 503 for "we could not check" — deliberately distinct from 401/403 ("you may
 * not") and 404 ("it isn't there"). See `@/lib/api/license-status` for the full
 * reasoning; this route uses a plain `{ error }` body to match its own shape.
 * The underlying message is logged, never returned (V11 Re-Audit N-1).
 */
function serviceUnavailable(context: string, error: { message: string }): NextResponse {
  console.error(`[${context}] download check undetermined:`, error.message);
  return NextResponse.json(
    {
      error: 'Could not verify your access right now. This is a temporary server fault — please retry.',
      retryable: true,
    },
    { status: 503, headers: { 'Retry-After': '30' } },
  );
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ productId: string; fileId: string }> },
) {
  const { productId, fileId } = await params;
  const supabase = createAdminSupabase();

  // ── Auth: prefer signed URL, fall back to portal token header ──
  let customerId: string;
  let guildId: string;

  const sig = req.nextUrl.searchParams.get('sig');
  const exp = req.nextUrl.searchParams.get('exp');
  const cid = req.nextUrl.searchParams.get('cid');
  const gid = req.nextUrl.searchParams.get('gid');

  const nonce = req.nextUrl.searchParams.get('nonce');

  if (sig && exp && cid && gid) {
    // Signed URL authentication (preferred — no raw token in URL)
    const verified = verifySignedDownloadUrl(productId, fileId, sig, exp, cid, gid, nonce ?? undefined);
    if (!verified) {
      return NextResponse.json({ error: 'Invalid or expired download link' }, { status: 401 });
    }

    // Single-use enforcement: each nonce can only be consumed once.
    // If the nonce was already used, reject the request.
    if (verified.nonce) {
      const consumed = await consumeDownloadNonce(verified.nonce, parseInt(exp, 10));
      if (!consumed) {
        return NextResponse.json({ error: 'Download link has already been used' }, { status: 410 });
      }
    }

    customerId = verified.customerId;
    guildId = verified.guildId;

    // V5 Audit P2-1: Rate-limit downloads per customer to prevent abuse
    const rl = await rateLimits.portalDownload(customerId);
    if (rl.limited) {
      return NextResponse.json(
        { error: 'Too many download requests. Try again later.', retry_after: Math.ceil(rl.retryAfterMs / 1000) },
        { status: 429 },
      );
    }
  } else {
    // Fallback: portal token via header (API clients, not browser navigation)
    const token = req.headers.get('x-portal-token');
    if (!token) {
      return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
    }

    const { data: session, error: sessionError } = await supabase
      .from('portal_sessions')
      .select('customer_id, guild_id')
      .eq('token_hash', hashToken(token))
      .eq('revoked', false)
      .gt('expires_at', new Date().toISOString())
      .maybeSingle();

    // A failed read is not an invalid session. Telling a paying customer their
    // session expired because the database blinked would log them out of the
    // portal; say "try again" instead. (Same distinction as the licence
    // endpoints — see @/lib/api/license-status.)
    if (sessionError) {
      return serviceUnavailable('Downloads portal session lookup', sessionError);
    }

    if (!session) {
      return NextResponse.json({ error: 'Invalid or expired session' }, { status: 401 });
    }
    customerId = session.customer_id;
    guildId = session.guild_id;

    // V5 Audit P2-1: Rate-limit downloads per customer (header auth path)
    const rl = await rateLimits.portalDownload(customerId);
    if (rl.limited) {
      return NextResponse.json(
        { error: 'Too many download requests. Try again later.', retry_after: Math.ceil(rl.retryAfterMs / 1000) },
        { status: 429 },
      );
    }
  }

  // ── Entitlement check: customer must own the product AND access must be
  // live. W2 codex: a `grace_period` row whose deadline lapsed but which
  // reconciliation has not yet expired must NOT serve the file — recompute the
  // grace window here with the same predicate license/validate + heartbeat use,
  // so a signed URL minted while still in grace stops working once the deadline
  // passes rather than trusting the stale status.
  //
  // A customer may hold MORE THAN ONE candidate row for the same product (a
  // re-buy, or overlapping subscription + manual grant). Fetch the whole
  // candidate set — not an arbitrary `.limit(1)` row — and grant access if ANY
  // of them is still live, so one lapsed grace row cannot mask another that is
  // active or in an unexpired grace window. ──
  const { data: entitlements, error: entitlementError } = await supabase
    .from('entitlements')
    .select('id, status, grace_period_ends_at')
    .eq('customer_id', customerId)
    .eq('product_id', productId)
    .eq('guild_id', guildId)
    .in('status', ['active', 'grace_period']);

  // "The query failed" is NOT "you have no entitlement". The old code
  // discarded the error, so a transient database fault told a paying customer
  // they did not own the product they had just bought — a 403 that reads as an
  // accusation. Report the fault as a fault.
  if (entitlementError) {
    return serviceUnavailable('Downloads entitlement lookup', entitlementError);
  }

  if (!entitlements?.some((e) => isEntitlementAccessLive(e))) {
    return NextResponse.json({ error: 'No active entitlement for this product' }, { status: 403 });
  }

  // ── Get the file ──
  const { data: file, error: fileError } = await supabase
    .from('product_files')
    .select('*')
    .eq('id', fileId)
    .eq('product_id', productId)
    .maybeSingle();

  if (fileError) {
    return serviceUnavailable('Downloads file lookup', fileError);
  }

  if (!file) {
    return NextResponse.json({ error: 'File not found' }, { status: 404 });
  }

  // Atomically increment download counter via RPC (avoids race conditions)
  await supabase.rpc('increment_download_count', { p_file_id: fileId }).then(async ({ error }) => {
    if (error) {
      // Fallback: non-atomic increment if RPC doesn't exist
      await supabase
        .from('product_files')
        .update({ download_count: (file.download_count ?? 0) + 1 })
        .eq('id', fileId);
    }
  });

  // If external URL, redirect — V6 Audit §2.4: enforce HTTPS
  if (file.external_url) {
    try {
      const externalUrl = new URL(file.external_url);
      if (externalUrl.protocol !== 'https:') {
        return NextResponse.json(
          { error: 'External download URLs must use HTTPS' },
          { status: 400 },
        );
      }
      return NextResponse.redirect(file.external_url);
    } catch {
      return NextResponse.json({ error: 'Invalid external URL' }, { status: 400 });
    }
  }

  // If Supabase storage path, generate signed URL
  if (file.file_path) {
    const { data: signedUrl } = await supabase.storage
      .from('product_files')
      .createSignedUrl(file.file_path, 3600); // 1 hour

    if (signedUrl?.signedUrl) {
      return NextResponse.redirect(signedUrl.signedUrl);
    }
  }

  return NextResponse.json({ error: 'File not accessible' }, { status: 404 });
}
