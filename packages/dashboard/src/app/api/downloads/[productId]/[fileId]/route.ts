/**
 * GET /api/downloads/[productId]/[fileId] — Protected file downloads.
 *
 * SECURITY (Phase A):
 * - Requires EITHER a valid auth session (dashboard owner) OR a valid license key
 *   passed via `?key=` query parameter.
 * - For session-based access: verifies the user is the guild owner.
 * - For key-based access: verifies the license key is active and has an active
 *   entitlement for this specific product.
 * - Generates short-lived signed URLs (5 minutes, not 1 hour).
 * - Logs all download attempts (success + denied).
 * - Increments download counter only on success.
 */
import { NextRequest, NextResponse } from 'next/server';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { createServerSupabase } from '@/lib/supabase/server';
import { createHash } from 'crypto';

const SIGNED_URL_TTL = 300; // 5 minutes

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ productId: string; fileId: string }> },
) {
  const { productId, fileId } = await params;
  const supabase = createAdminSupabase();

  // ── Validate IDs are UUIDs ──
  const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuidRe.test(productId) || !uuidRe.test(fileId)) {
    return NextResponse.json({ error: 'Invalid product or file ID' }, { status: 400 });
  }

  // ── Authorization: try session first, then license key ──
  let authorized = false;
  let actorId: string | null = null;
  let actorType: 'owner' | 'license' = 'owner';

  // Method 1: Auth session (guild owner)
  try {
    const serverSupa = await createServerSupabase();
    const { data: { user } } = await serverSupa.auth.getUser();
    if (user) {
      const meta = user.user_metadata;
      const discordId = (meta?.provider_id as string) || (meta?.sub as string) || null;
      if (discordId) {
        const { data: guild } = await supabase
          .from('guild')
          .select('id')
          .eq('owner_discord_id', discordId)
          .single();
        if (guild) {
          authorized = true;
          actorId = discordId;
          actorType = 'owner';
        }
      }
    }
  } catch {
    // Session check failed — try license key
  }

  // Method 2: License key via query parameter
  if (!authorized) {
    const licenseKey = req.nextUrl.searchParams.get('key');
    if (licenseKey) {
      // Rate-limit: only check keys that match the expected format
      if (/^SMNI-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(licenseKey)) {
        const keyHash = createHash('sha256').update(licenseKey).digest('hex');

        // Verify key is active and bound to this product
        const { data: key } = await supabase
          .from('license_keys')
          .select('id, customer_id, product_id, status')
          .eq('key_hash', keyHash)
          .eq('product_id', productId)
          .in('status', ['active', 'pending_activation'])
          .maybeSingle();

        if (key) {
          // Verify there's an active entitlement for this product+customer
          const { data: entitlement } = await supabase
            .from('entitlements')
            .select('id')
            .eq('customer_id', key.customer_id)
            .eq('product_id', productId)
            .in('status', ['active', 'pending'])
            .limit(1)
            .maybeSingle();

          if (entitlement) {
            authorized = true;
            actorId = key.customer_id;
            actorType = 'license';
          }
        }
      }
    }
  }

  // ── Deny if not authorized ──
  if (!authorized) {
    // Log denied attempt
    await supabase.from('audit_logs').insert({
      guild_id: process.env.DISCORD_GUILD_ID || 'unknown',
      action: 'download.denied',
      actor_id: 'anonymous',
      actor_type: 'system',
      category: 'commerce',
      details: {
        product_id: productId,
        file_id: fileId,
        reason: 'No valid session or license key',
        ip: req.headers.get('x-forwarded-for') || req.headers.get('x-real-ip') || 'unknown',
      },
    }).then(() => {}, () => {});

    return NextResponse.json(
      { error: 'Unauthorized — valid session or license key required' },
      { status: 401 },
    );
  }

  // ── Fetch the file ──
  const { data: file } = await supabase
    .from('product_files')
    .select('*')
    .eq('id', fileId)
    .eq('product_id', productId)
    .single();

  if (!file) {
    return NextResponse.json({ error: 'File not found' }, { status: 404 });
  }

  // ── Increment download counter ──
  await supabase
    .from('product_files')
    .update({ download_count: (file.download_count ?? 0) + 1 })
    .eq('id', fileId);

  // ── Log successful download ──
  await supabase.from('audit_logs').insert({
    guild_id: process.env.DISCORD_GUILD_ID || 'unknown',
    action: 'download.success',
    actor_id: actorId || 'unknown',
    actor_type: 'user',
    category: 'commerce',
    details: {
      product_id: productId,
      file_id: fileId,
      file_name: file.name || file.file_path,
      access_method: actorType,
    },
  }).then(() => {}, () => {});

  // ── Serve the file ──
  if (file.external_url) {
    return NextResponse.redirect(file.external_url);
  }

  if (file.file_path) {
    const { data: signedUrl } = await supabase.storage
      .from('product-files')
      .createSignedUrl(file.file_path, SIGNED_URL_TTL);

    if (signedUrl?.signedUrl) {
      return NextResponse.redirect(signedUrl.signedUrl);
    }
  }

  return NextResponse.json({ error: 'File not accessible' }, { status: 404 });
}
