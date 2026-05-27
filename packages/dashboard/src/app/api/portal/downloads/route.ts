/**
 * GET /api/portal/downloads — Customer's available product downloads.
 * Requires: x-portal-token header.
 *
 * V5 Audit Fix #5 — Download URLs now use HMAC-signed links instead of
 * raw portal tokens in query parameters. Each link expires in 5 minutes.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { createHash } from 'crypto';
import { generateSignedDownloadUrl } from '@/lib/api/signed-url';
import { rateLimits } from '@/lib/api/rate-limit';

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

async function getPortalCustomer(request: NextRequest) {
  const token = request.headers.get('x-portal-token');
  if (!token) return null;

  const admin = createAdminSupabase();
  const { data: session } = await admin
    .from('portal_sessions')
    .select('customer_id, guild_id')
    .eq('token_hash', hashToken(token))
    .eq('revoked', false)
    .gt('expires_at', new Date().toISOString())
    .single();

  return session;
}

export async function GET(request: NextRequest) {
  try {
    const session = await getPortalCustomer(request);
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    // V6 Audit §7.1: Rate-limit portal data reads per token
    const token = request.headers.get('x-portal-token')!;
    const rl = await rateLimits.portalData(hashToken(token));
    if (rl.limited) {
      return NextResponse.json({ error: 'Too many requests' }, { status: 429 });
    }

    const admin = createAdminSupabase();

    // Get active entitlements with product info
    const { data: entitlements } = await admin
      .from('entitlements')
      .select('*, products(id, name, description, type)')
      .eq('customer_id', session.customer_id)
      .eq('status', 'active')
      .limit(1000);

    // Collect product IDs to fetch their files
    const productIds = (entitlements || [])
      .map((e) => ((e as Record<string, unknown>).products as { id: string } | null)?.id)
      .filter(Boolean) as string[];

    // Fetch product files for all entitled products
    const { data: productFiles } = productIds.length > 0
      ? await admin
          .from('product_files')
          .select('*')
          .in('product_id', productIds)
          .order('sort_order', { ascending: true })
          .limit(1000)
      : { data: [] };

    // Group files by product_id
    const filesByProduct = new Map<string, Record<string, unknown>[]>();
    for (const f of productFiles || []) {
      const pid = f.product_id as string;
      if (!filesByProduct.has(pid)) filesByProduct.set(pid, []);
      filesByProduct.get(pid)!.push(f as Record<string, unknown>);
    }

    // V5 Fix #5: Build download list with HMAC-signed URLs.
    // The portal token never appears in a URL — signed links expire in 5 min.
    const downloads = (entitlements || []).map((e) => {
      const product = (e as Record<string, unknown>).products as {
        id: string;
        name: string;
        description: string | null;
        type: string;
      } | null;

      const rawFiles = product?.id ? filesByProduct.get(product.id) ?? [] : [];
      const files = rawFiles.map((f) => ({
        name: (f.file_name as string) || (f.name as string) || 'Download',
        url: generateSignedDownloadUrl({
          productId: product!.id,
          fileId: f.id as string,
          customerId: session.customer_id,
          guildId: session.guild_id,
        }),
        size: f.file_size as number | undefined,
      }));

      return {
        entitlement_id: e.id,
        product_id: product?.id,
        product_name: product?.name || 'Unknown',
        product_type: product?.type,
        description: product?.description,
        files,
        entitled_since: e.created_at,
      };
    });

    return NextResponse.json({ success: true, data: downloads });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Unknown error';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
