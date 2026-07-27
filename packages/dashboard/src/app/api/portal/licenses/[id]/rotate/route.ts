/**
 * POST /api/portal/licenses/[id]/rotate — a customer replaces their own
 * licence key.
 *
 * A key that has leaked (pasted in a support thread, committed to a repo,
 * shared with someone who shouldn't have it) had no self-service remedy: the
 * `license_rotate_key` RPC existed and worked, but nothing reachable called
 * it. The customer had to contact the seller and wait.
 *
 * ── How the new key reaches the customer ──────────────────────────────────
 * NOT in this response. The plaintext is never returned over HTTP, logged, or
 * stored — only its SHA-256 hash is persisted, exactly as at purchase time.
 *
 * Instead the new key is delivered down the SAME channel the original arrived
 * on: a `deliver_receipt` row on `bot_action_queue`, which the bot DMs to the
 * buyer. That path is already hardened — exponential-backoff retries, terminal
 * vs transient error classification, dead-lettering with an owner alert if it
 * ultimately fails, and payload redaction before anything is written to the
 * audit log. Inventing a second delivery mechanism for the same secret would
 * mean re-earning all of that.
 *
 * ── Ordering ──────────────────────────────────────────────────────────────
 * The RPC rotates first, then delivery is queued. If the queue insert fails,
 * the rotation still stands and the response says so explicitly, because the
 * old key is already dead — claiming success would be a lie, but so would
 * reporting failure and inviting a retry that mints a third key.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { createHash, randomInt } from 'crypto';
import { z } from 'zod';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { rateLimits } from '@/lib/api/rate-limit';
import { dbError } from '@/lib/api/response';

const keyIdSchema = z.string().uuid();

/**
 * Unambiguous alphabet: one character from each pair that is misread when a
 * key is retyped from a DM or read aloud — O/0, I/1, L/1, S/5, Z/2, B/8 — plus
 * U, which is misheard as "you". A key that cannot be transcribed reliably
 * generates exactly the support burden this feature exists to remove.
 */
const KEY_ALPHABET = 'ACDEFGHJKMNPQRTVWXY34679';
const KEY_PREFIX = 'SMNI';

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** `SMNI-XXXX-XXXX-XXXX-XXXX`, matching the format minted at purchase. */
function generateLicenseKey(): { plaintext: string; suffix: string } {
  const group = () =>
    Array.from({ length: 4 }, () => KEY_ALPHABET[randomInt(KEY_ALPHABET.length)]).join('');
  const groups = [group(), group(), group(), group()];
  return {
    plaintext: [KEY_PREFIX, ...groups].join('-'),
    suffix: groups[3]!,
  };
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const token = request.headers.get('x-portal-token');
  if (!token) {
    return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
  }

  const admin = createAdminSupabase();

  const { data: portalSession } = await admin
    .from('portal_sessions')
    .select('customer_id, guild_id')
    .eq('token_hash', hashToken(token))
    .eq('revoked', false)
    .gt('expires_at', new Date().toISOString())
    .single();

  if (!portalSession) {
    return NextResponse.json({ error: 'Invalid or expired session' }, { status: 401 });
  }

  const rl = await rateLimits.portalRotate(portalSession.customer_id);
  if (rl.limited) {
    return NextResponse.json(
      { error: 'You have rotated this licence too many times today. Try again tomorrow.' },
      { status: 429 },
    );
  }

  const { id: rawId } = await context.params;
  const parsed = keyIdSchema.safeParse(rawId);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid licence ID format' }, { status: 400 });
  }
  const licenseKeyId = parsed.data;

  // Ownership: the key must belong to THIS customer in THIS guild. A 404 for
  // anything else, so a customer cannot probe for other customers' key ids.
  const { data: key, error: lookupError } = await admin
    .from('license_keys')
    .select('id, status, bound_discord_id, order_id, orders(order_number), products(name)')
    .eq('id', licenseKeyId)
    .eq('customer_id', portalSession.customer_id)
    .eq('guild_id', portalSession.guild_id)
    .maybeSingle();

  if (lookupError) return dbError(lookupError, 'portal/licenses/rotate');
  if (!key) {
    return NextResponse.json({ error: 'Licence not found' }, { status: 404 });
  }

  // A key already revoked for any reason cannot be rotated — there is nothing
  // live to replace, and minting a key against a dead licence would hand out
  // access that was deliberately withdrawn.
  if (key.status === 'revoked') {
    return NextResponse.json(
      { error: 'This licence has been revoked and cannot be rotated.' },
      { status: 409 },
    );
  }

  const { plaintext, suffix } = generateLicenseKey();

  const { data: result, error: rpcError } = await admin.rpc('license_rotate_key', {
    p_license_key_id: licenseKeyId,
    p_new_key_hash: hashToken(plaintext),
    p_new_key_prefix: KEY_PREFIX,
    p_new_key_suffix: suffix,
    p_actor_discord_id: key.bound_discord_id ?? null,
  });

  if (rpcError) return dbError(rpcError, 'portal/licenses/rotate');

  const status = (result as { status?: string } | null)?.status;

  if (status === 'not_found') {
    return NextResponse.json({ error: 'Licence not found' }, { status: 404 });
  }

  // The RPC is replay-safe: a losing racer or a retried request gets the
  // rotation that already happened rather than a further key. Report that
  // honestly instead of pretending this call minted one.
  if (status === 'already_rotated') {
    return NextResponse.json({
      success: true,
      alreadyRotated: true,
      message: 'This licence was already rotated. Check your DMs for the replacement key.',
    });
  }

  // Deliver down the same audited, retrying path the original key used.
  const orderNumber = (key.orders as { order_number?: string } | null)?.order_number;
  const productName = (key.products as { name?: string } | null)?.name;

  let delivery: 'queued' | 'not_queued' = 'queued';
  if (key.bound_discord_id && orderNumber && productName) {
    const { error: queueError } = await admin.from('bot_action_queue').insert({
      guild_id: portalSession.guild_id,
      action: 'deliver_receipt',
      payload: {
        discord_id: key.bound_discord_id,
        order_number: orderNumber,
        product_name: productName,
        license_key_plaintext: plaintext,
        order_date: new Date().toISOString(),
      } as never,
      status: 'pending',
    });
    if (queueError) delivery = 'not_queued';
  } else {
    delivery = 'not_queued';
  }

  // The old key is dead either way — say precisely what happened rather than
  // reporting a blanket success or inviting a retry that mints a third key.
  return NextResponse.json({
    success: true,
    newKeySuffix: suffix,
    delivery,
    message: delivery === 'queued'
      ? 'Your old key stopped working and a new one is on its way by DM.'
      : 'Your old key stopped working, but the new one could not be sent automatically. '
        + 'Contact the seller — they can re-send it without another rotation.',
  });
}
