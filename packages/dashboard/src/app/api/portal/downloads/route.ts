/**
 * GET /api/portal/downloads — Customer's available product downloads.
 * Requires: x-portal-token header.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { createHash } from 'crypto';

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

    const admin = createAdminSupabase();

    // Get active entitlements with product info
    const { data: entitlements } = await admin
      .from('entitlements')
      .select('*, products(id, name, description, type)')
      .eq('customer_id', session.customer_id)
      .eq('status', 'active');

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
          .limit(500)
      : { data: [] };

    // Group files by product_id
    const filesByProduct = new Map<string, Record<string, unknown>[]>();
    for (const f of productFiles || []) {
      const pid = f.product_id as string;
      if (!filesByProduct.has(pid)) filesByProduct.set(pid, []);
      filesByProduct.get(pid)!.push(f as Record<string, unknown>);
    }

    // Build download list from entitled products
    const downloads = (entitlements || []).map((e) => {
      const product = (e as Record<string, unknown>).products as {
        id: string;
        name: string;
        description: string | null;
        type: string;
      } | null;

      return {
        entitlement_id: e.id,
        product_id: product?.id,
        product_name: product?.name || 'Unknown',
        product_type: product?.type,
        description: product?.description,
        files: product?.id ? filesByProduct.get(product.id) ?? [] : [],
        entitled_since: e.created_at,
      };
    });

    return NextResponse.json({ success: true, data: downloads });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Unknown error';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
