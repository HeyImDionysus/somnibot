/**
 * GET /api/downloads/[productId]/[fileId] — Protected file downloads.
 *
 * V5 Audit Fix #5 — Now authenticates via HMAC-signed URL parameters
 * instead of raw portal tokens in query strings. Falls back to
 * x-portal-token header for backwards compatibility.
 *
 * Signed URL params: sig, exp, cid (customer ID), gid (guild ID),
 * eid (the exact entitlement whose delivery will be recorded), nonce
 */
import { after, NextRequest, NextResponse } from 'next/server';
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

/**
 * A dispatched nonce write whose result still cannot be confirmed is not a
 * retryable outage: the link may already be consumed. Tell the caller to mint
 * a new link rather than inviting a replay of this one.
 */
function deliveryStatusUncertain(): NextResponse {
  console.error(
    '[Downloads nonce consumption] write outcome remained uncertain after authoritative confirmation',
  );
  return NextResponse.json(
    {
      error: 'Could not confirm this download delivery. Do not reuse this link; request a new one.',
      retryable: false,
    },
    { status: 409 },
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
  let signedEntitlementId: string | null = null;
  let deliveryNonce: { value: string; expiresAtUnix: number } | null = null;

  const sig = req.nextUrl.searchParams.get('sig');
  const exp = req.nextUrl.searchParams.get('exp');
  const cid = req.nextUrl.searchParams.get('cid');
  const gid = req.nextUrl.searchParams.get('gid');
  const eid = req.nextUrl.searchParams.get('eid');

  const nonce = req.nextUrl.searchParams.get('nonce');

  if (sig && exp && cid && gid && eid) {
    // Signed URL authentication (preferred — no raw token in URL)
    const verified = verifySignedDownloadUrl(
      productId,
      fileId,
      sig,
      exp,
      cid,
      gid,
      eid,
      nonce ?? undefined,
    );
    if (!verified) {
      return NextResponse.json({ error: 'Invalid or expired download link' }, { status: 401 });
    }

    if (verified.nonce) {
      deliveryNonce = {
        value: verified.nonce,
        expiresAtUnix: Number.parseInt(exp, 10),
      };
    }

    customerId = verified.customerId;
    guildId = verified.guildId;
    signedEntitlementId = verified.entitlementId;

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
    .select('id, order_id, status, grace_period_ends_at, created_at')
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

  const liveEntitlements = entitlements
    ?.filter((entitlement) => isEntitlementAccessLive(entitlement)) ?? [];
  const liveEntitlement = signedEntitlementId
    ? liveEntitlements.find((entitlement) => entitlement.id === signedEntitlementId)
    : liveEntitlements.sort((left, right) =>
      String(right.created_at ?? '').localeCompare(String(left.created_at ?? '')),
    )[0];
  if (!liveEntitlement) {
    return NextResponse.json({ error: 'No active entitlement for this product' }, { status: 403 });
  }
  const deliveryEntitlement = liveEntitlement;

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

  /**
   * Consume a signed-link nonce only once every dependency check has succeeded
   * and a redirect target is ready. A 429/503, missing file, invalid URL, or
   * storage-signing failure is retryable with the same link; a delivered link
   * is not.
   */
  async function consumeDeliveryNonce(): Promise<NextResponse | null> {
    if (!deliveryNonce) return null;
    const nonceResult = await consumeDownloadNonce(
      deliveryNonce.value,
      deliveryNonce.expiresAtUnix,
    );
    if (nonceResult === 'replay') {
      return NextResponse.json({ error: 'Download link has already been used' }, { status: 410 });
    }
    if (nonceResult === 'unavailable') {
      return serviceUnavailable(
        'Downloads nonce consumption',
        { message: 'Authoritative nonce store is unavailable' },
      );
    }
    if (nonceResult === 'uncertain') {
      return deliveryStatusUncertain();
    }
    return null;
  }

  async function recordDeliveryEvidence(): Promise<'recorded' | 'replay' | 'failed'> {
    try {
      const { error: deliveryError } = await supabase
        .from('commerce_download_deliveries')
        .insert({
          guild_id: guildId,
          customer_id: customerId,
          product_id: productId,
          file_id: fileId,
          file_name_snapshot: file.name,
          entitlement_id: deliveryEntitlement.id,
          order_id: deliveryEntitlement.order_id,
          delivery_nonce_hash: deliveryNonce ? hashToken(deliveryNonce.value) : null,
        });
      if (deliveryError && deliveryError.code === '23505') {
        // The table's only unique index is the partial nonce-hash index, so a
        // conflict on a nonce-bearing insert means this exact link already has
        // a durable delivery row. That happens precisely when the volatile
        // nonce store lost the consumed marker (eviction/restart) and the
        // replay passed consumeDownloadNonce as fresh — the durable ledger is
        // the last line of the single-use guarantee, not benign dedupe.
        if (deliveryNonce) return 'replay';
        return 'recorded';
      }
      if (deliveryError) {
        console.error('[Downloads delivery evidence] insert failed:', deliveryError.message);
        return 'failed';
      }
      return 'recorded';
    } catch (error) {
      console.error(
        '[Downloads delivery evidence] insert failed:',
        error instanceof Error ? error.message : 'unknown error',
      );
      return 'failed';
    }
  }

  /** The download counter is analytics; durable delivery evidence is not. */
  async function incrementDownloadCounter(): Promise<void> {
    try {
      const { error } = await supabase.rpc('increment_download_count', { p_file_id: fileId });
      if (!error) return;

      const { error: fallbackError } = await supabase
        .from('product_files')
        .update({ download_count: (file.download_count ?? 0) + 1 })
        .eq('id', fileId);
      if (fallbackError) {
        console.error('[Downloads counter] fallback update failed:', fallbackError.message);
      }
    } catch (error) {
      console.error(
        '[Downloads counter] update failed:',
        error instanceof Error ? error.message : 'unknown error',
      );
    }
  }

  /**
   * A redirect is successful only after its durable delivery ledger row exists.
   * The analytics counter stays outside the critical path.
   */
  async function deliver(response: NextResponse): Promise<NextResponse> {
    const replay = await consumeDeliveryNonce();
    if (replay) return replay;

    const evidence = await recordDeliveryEvidence();
    if (evidence === 'replay') {
      return NextResponse.json(
        { error: 'Download link has already been used' },
        { status: 410 },
      );
    }
    if (evidence === 'failed') {
      return deliveryNonce
        ? deliveryStatusUncertain()
        : serviceUnavailable('Downloads delivery evidence', {
          message: 'Durable delivery evidence could not be written',
        });
    }

    try {
      after(incrementDownloadCounter);
    } catch (error) {
      console.error(
        '[Downloads counter] scheduling failed:',
        error instanceof Error ? error.message : 'unknown error',
      );
    }
    return response;
  }

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
      return deliver(NextResponse.redirect(externalUrl));
    } catch {
      return NextResponse.json({ error: 'Invalid external URL' }, { status: 400 });
    }
  }

  // If Supabase storage path, generate signed URL
  if (file.file_path) {
    const { data: signedUrl, error: signedUrlError } = await supabase.storage
      .from('product_files')
      .createSignedUrl(file.file_path, 3600); // 1 hour

    if (signedUrlError) {
      return serviceUnavailable('Downloads storage signing', signedUrlError);
    }

    if (signedUrl?.signedUrl) {
      return deliver(NextResponse.redirect(signedUrl.signedUrl));
    }
  }

  return NextResponse.json({ error: 'File not accessible' }, { status: 404 });
}
