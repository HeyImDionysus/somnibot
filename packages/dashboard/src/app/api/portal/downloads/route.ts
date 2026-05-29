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
import { z } from 'zod';

/**
 * Zod schemas for Supabase join results.
 * Replaces cascading `as Record` type assertions with runtime validation
 * so schema drift is caught at the route layer instead of silently serving
 * malformed responses.
 */
const productSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  type: z.string(),
}).nullable();

const entitlementSchema = z.object({
  id: z.string(),
  customer_id: z.string(),
  status: z.string(),
  created_at: z.string(),
  products: productSchema,
}).passthrough();

const productFileSchema = z.object({
  id: z.string(),
  product_id: z.string(),
  file_name: z.string().nullable().optional(),
  name: z.string().nullable().optional(),
  file_size: z.number().nullable().optional(),
}).passthrough();

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

    // Parse entitlements through Zod instead of cascading `as Record` casts.
    // Schema drift is caught here.
    const parsedEntitlements = (entitlements || [])
      .map((e) => entitlementSchema.safeParse(e))
      .filter((r) => r.success)
      .map((r) => r.data!);

    // Collect product IDs to fetch their files
    const productIds = parsedEntitlements
      .map((e) => e.products?.id)
      .filter((id): id is string => !!id);

    // Fetch product files for all entitled products
    const { data: rawFiles } = productIds.length > 0
      ? await admin
          .from('product_files')
          .select('*')
          .in('product_id', productIds)
          .order('sort_order', { ascending: true })
          .limit(1000)
      : { data: [] };

    // Parse product files through Zod
    const parsedFiles = (rawFiles || [])
      .map((f) => productFileSchema.safeParse(f))
      .filter((r) => r.success)
      .map((r) => r.data!);

    // Group files by product_id
    const filesByProduct = new Map<string, z.infer<typeof productFileSchema>[]>();
    for (const f of parsedFiles) {
      if (!filesByProduct.has(f.product_id)) filesByProduct.set(f.product_id, []);
      filesByProduct.get(f.product_id)!.push(f);
    }

    // V5 Fix #5: Build download list with HMAC-signed URLs.
    // The portal token never appears in a URL — signed links expire in 5 min.
    const downloads = parsedEntitlements.map((e) => {
      const product = e.products;
      const files = product?.id ? (filesByProduct.get(product.id) ?? []) : [];

      return {
        entitlement_id: e.id,
        product_id: product?.id,
        product_name: product?.name || 'Unknown',
        product_type: product?.type,
        description: product?.description,
        files: files.map((f) => ({
          name: f.file_name || f.name || 'Download',
          url: generateSignedDownloadUrl({
            productId: product!.id,
            fileId: f.id,
            customerId: session.customer_id,
            guildId: session.guild_id,
          }),
          size: f.file_size ?? undefined,
        })),
        entitled_since: e.created_at,
      };
    });

    return NextResponse.json({ success: true, data: downloads });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Unknown error';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
