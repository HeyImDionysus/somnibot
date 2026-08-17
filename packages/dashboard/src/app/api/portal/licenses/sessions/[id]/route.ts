/**
 * DELETE /api/portal/licenses/sessions/[id] — a customer signs one of their own
 * devices out.
 *
 * The portal already LISTS the devices a licence is activated on
 * (`/api/portal/licenses` returns `license_sessions`), but offered no way to
 * remove one. A customer who lost a laptop, or hit their activation limit on a
 * machine they no longer own, had to contact the seller and wait — for an
 * action that is entirely theirs to take.
 *
 * ── Ownership ─────────────────────────────────────────────────────────────
 * `license_sessions` has NO guild_id and no customer_id of its own; it hangs
 * off `license_keys`. So ownership is verified through the parent row
 * (customer AND guild must both match the portal session), exactly as the
 * owner-facing route at api/license/sessions/[id] does. Without that join, any
 * customer could deactivate any other customer's device by guessing a UUID.
 *
 * Deactivation is a soft `active = false`, matching every other session
 * teardown here — the row is evidence of where a licence has been used and is
 * not destroyed by a sign-out.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { createHash } from 'crypto';
import { z } from 'zod';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { rateLimits } from '@/lib/api/rate-limit';
import { dbError } from '@/lib/api/response';

const sessionIdSchema = z.string().uuid();

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export async function DELETE(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const token = request.headers.get('x-portal-token');
  if (!token) {
    return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
  }

  const admin = createAdminSupabase();
  const tokenHash = hashToken(token);

  const { data: portalSession } = await admin
    .from('portal_sessions')
    .select('customer_id, guild_id')
    .eq('token_hash', tokenHash)
    .eq('revoked', false)
    .gt('expires_at', new Date().toISOString())
    .single();

  if (!portalSession) {
    return NextResponse.json({ error: 'Invalid or expired session' }, { status: 401 });
  }

  const rl = await rateLimits.portalData(tokenHash);
  if (rl.limited) {
    return NextResponse.json({ error: 'Too many requests' }, { status: 429 });
  }

  const { id: rawId } = await context.params;
  const parsed = sessionIdSchema.safeParse(rawId);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid session ID format' }, { status: 400 });
  }
  const sessionId = parsed.data;

  // Ownership through the parent licence: BOTH the customer and the guild must
  // match this portal session. `!inner` makes the join a filter rather than an
  // optional embed, so a non-matching parent yields no row at all.
  const { data: session, error: lookupError } = await admin
    .from('license_sessions')
    .select('id, active, license_keys!inner(customer_id, guild_id, product_id, products!inner(product_license_config(self_service_device_removal)))')
    .eq('id', sessionId)
    .eq('license_keys.customer_id', portalSession.customer_id)
    .eq('license_keys.guild_id', portalSession.guild_id)
    .maybeSingle();

  if (lookupError) return dbError(lookupError, 'portal/licenses/sessions');

  if (!session) {
    // Deliberately indistinguishable from "does not exist": a customer must not
    // be able to probe for other customers' session ids.
    return NextResponse.json({ error: 'Session not found' }, { status: 404 });
  }

  const license = session.license_keys as {
    products?: {
      product_license_config?:
        | { self_service_device_removal?: boolean }
        | Array<{ self_service_device_removal?: boolean }>;
    };
  } | null;
  const embeddedConfig = license?.products?.product_license_config;
  const productConfig = Array.isArray(embeddedConfig) ? embeddedConfig[0] : embeddedConfig;
  const removalAllowed = productConfig?.self_service_device_removal ?? true;
  if (!removalAllowed) {
    return NextResponse.json({ error: 'Self-service device removal is disabled for this product.' }, { status: 403 });
  }

  // Idempotent: signing out an already-inactive device is a success, not an
  // error. A double-click, or a retry after a dropped response, must not read
  // as a failure for something that is already true.
  if (session.active === false) {
    return NextResponse.json({ success: true, deduped: true });
  }

  const { error } = await admin
    .from('license_sessions')
    .update({ active: false })
    .eq('id', sessionId);

  if (error) return dbError(error, 'portal/licenses/sessions');

  return NextResponse.json({ success: true, deduped: false });
}
