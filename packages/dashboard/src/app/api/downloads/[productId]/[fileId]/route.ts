/**
 * GET /api/downloads/[productId]/[fileId] — Protected file downloads.
 *
 * Authenticates via portal token (x-portal-token header) and validates
 * that the customer has an active entitlement for the product before
 * serving the file. Increments download counter on success.
 */
import { NextRequest, NextResponse } from 'next/server';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { createHash } from 'crypto';

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ productId: string; fileId: string }> },
) {
  const { productId, fileId } = await params;
  const supabase = createAdminSupabase();

  // ── Auth: require a valid portal token ──
  // FIX #1: Accept token via query param as fallback for <a href> downloads
  // (browser navigation can't send custom headers on anchor clicks)
  const token = req.headers.get('x-portal-token') || req.nextUrl.searchParams.get('token');
  if (!token) {
    return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
  }

  const { data: session } = await supabase
    .from('portal_sessions')
    .select('customer_id, guild_id')
    .eq('token_hash', hashToken(token))
    .eq('revoked', false)
    .gt('expires_at', new Date().toISOString())
    .single();

  if (!session) {
    return NextResponse.json({ error: 'Invalid or expired session' }, { status: 401 });
  }

  // ── Entitlement check: customer must own the product ──
  // V52-L1: add guild_id scope from portal session for defense-in-depth
  const { data: entitlement } = await supabase
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

  // ── Get the file ──
  const { data: file } = await supabase
    .from('product_files')
    .select('*')
    .eq('id', fileId)
    .eq('product_id', productId)
    .single();

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

  // If external URL, redirect
  if (file.external_url) {
    return NextResponse.redirect(file.external_url);
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
