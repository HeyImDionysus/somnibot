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
 * NOT in this response. The plaintext is never returned over HTTP or written
 * to logs/audit records. Its hash is persisted on the licence row, while the
 * plaintext exists only in the protected receipt carrier until DM delivery.
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
 * One database transaction rotates the key and stages its exact receipt
 * carrier. The successor hash can therefore never commit without the only
 * recoverable copy of its plaintext already being in the delivery queue.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { createHash, randomInt } from 'crypto';
import { z } from 'zod';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { rateLimits } from '@/lib/api/rate-limit';
import { dbError } from '@/lib/api/response';

const keyIdSchema = z.string().uuid();
const stagedRotationResultSchema = z.object({
  status: z.enum(['rotated', 'already_rotated']),
  old_key_id: keyIdSchema,
  new_key_id: keyIdSchema,
  action_id: keyIdSchema,
  action_status: z.enum(['pending', 'processing', 'completed', 'failed']),
  guild_id: z.string().min(1),
  customer_id: keyIdSchema,
  product_id: keyIdSchema,
  order_id: keyIdSchema,
  discord_id: z.string().min(1),
  new_key_suffix: z.string().regex(/^[ACDEFGHJKMNPQRTVWXY34679]{4}$/),
  license_key_id: keyIdSchema,
  order_number: z.string().min(1),
  product_name: z.string().min(1),
  amount_cents: z.number().int().nonnegative(),
  currency: z.string().regex(/^[A-Za-z]{3}$/),
  delivery: z.literal('queued'),
}).strict();

/**
 * Unambiguous alphabet: one character from each pair that is misread when a
 * key is retyped from a DM or read aloud — O/0, I/1, L/1, S/5, Z/2, B/8 — plus
 * U, which is misheard as "you". A key that cannot be transcribed reliably
 * generates exactly the support burden this feature exists to remove.
 */
const KEY_ALPHABET = 'ACDEFGHJKMNPQRTVWXY34679';
const DEFAULT_KEY_PREFIX = 'SMNI';

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** `PREFIX-XXXX-XXXX-XXXX-XXXX`, matching the product's purchase format. */
function generateLicenseKey(prefix: string): { plaintext: string; suffix: string } {
  if (!/^[A-Z]{2,8}$/.test(prefix)) throw new Error('Invalid license key prefix');
  const group = () =>
    Array.from({ length: 4 }, () => KEY_ALPHABET[randomInt(KEY_ALPHABET.length)]).join('');
  const groups = [group(), group(), group(), group()];
  return {
    plaintext: [prefix, ...groups].join('-'),
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
    .select('id, status, revocation_reason, rotated_to_key_id, customer_id, guild_id, product_id, bound_discord_id, order_id, orders(order_number, amount_cents, currency, entitlements(id, status, type, expires_at, grace_period_ends_at, license_key_id, order_id, customer_id, guild_id, product_id)), products(name, product_license_config(rotation_policy, key_prefix))')
    .eq('id', licenseKeyId)
    .eq('customer_id', portalSession.customer_id)
    .eq('guild_id', portalSession.guild_id)
    .maybeSingle();

  if (lookupError) return dbError(lookupError, 'portal/licenses/rotate');
  if (!key) {
    return NextResponse.json({ error: 'Licence not found' }, { status: 404 });
  }

  const embeddedConfig = (key.products as {
    product_license_config?:
      | { rotation_policy?: string; key_prefix?: string }
      | Array<{ rotation_policy?: string; key_prefix?: string }>;
  } | null)?.product_license_config;
  const productConfig = Array.isArray(embeddedConfig) ? embeddedConfig[0] : embeddedConfig;
  if (productConfig?.rotation_policy === 'disabled') {
    return NextResponse.json({ error: 'Key rotation is disabled for this product.' }, { status: 403 });
  }

  type EmbeddedEntitlement = {
    status?: unknown;
    type?: unknown;
    expires_at?: unknown;
    grace_period_ends_at?: unknown;
    license_key_id?: unknown;
    order_id?: unknown;
    customer_id?: unknown;
    guild_id?: unknown;
    product_id?: unknown;
  };
  const order = key.orders as {
    order_number?: unknown;
    amount_cents?: unknown;
    currency?: unknown;
    entitlements?: EmbeddedEntitlement | EmbeddedEntitlement[];
  } | null;
  const embeddedEntitlements = order?.entitlements;
  const entitlements = Array.isArray(embeddedEntitlements)
    ? embeddedEntitlements
    : embeddedEntitlements
      ? [embeddedEntitlements]
      : [];
  const hasUsableEntitlement = entitlements.some((entitlement) =>
    (
      (
        entitlement.status === 'active'
        && (
          entitlement.expires_at === null
          || (
            typeof entitlement.expires_at === 'string'
            && Date.parse(entitlement.expires_at) > Date.now()
          )
        )
      )
      || (
        entitlement.status === 'grace_period'
        && typeof entitlement.grace_period_ends_at === 'string'
        && Date.parse(entitlement.grace_period_ends_at) > Date.now()
      )
    )
    && (
      entitlement.license_key_id === key.id
      || (
        key.status === 'revoked'
        && key.revocation_reason === 'rotated'
        && entitlement.license_key_id === key.rotated_to_key_id
      )
    )
    && entitlement.order_id === key.order_id
    && entitlement.customer_id === key.customer_id
    && entitlement.guild_id === key.guild_id
    && entitlement.product_id === key.product_id);
  if (!hasUsableEntitlement) {
    return NextResponse.json(
      { error: 'This licence no longer has active access and cannot be rotated.' },
      { status: 409 },
    );
  }

  // Do not short-circuit revoked rows here. A committed rotation revokes its
  // predecessor, and a response-loss retry must reach the locked RPC so it can
  // distinguish exact `already_rotated` carrier evidence from an unrelated
  // revocation (`not_rotatable`).
  if (
    key.id !== licenseKeyId
    || key.customer_id !== portalSession.customer_id
    || key.guild_id !== portalSession.guild_id
    || !keyIdSchema.safeParse(key.customer_id).success
    || !keyIdSchema.safeParse(key.product_id).success
    || !keyIdSchema.safeParse(key.order_id).success
    || typeof key.bound_discord_id !== 'string'
    || key.bound_discord_id.length === 0
    || key.bound_discord_id.trim() !== key.bound_discord_id
  ) {
    return NextResponse.json(
      { error: 'This licence has no complete delivery identity and cannot be rotated.' },
      { status: 409 },
    );
  }

  const configuredPrefix = productConfig?.key_prefix ?? DEFAULT_KEY_PREFIX;
  const { plaintext, suffix } = generateLicenseKey(configuredPrefix);

  const rotationArgs = {
    p_license_key_id: licenseKeyId,
    p_guild_id: key.guild_id,
    p_customer_id: key.customer_id,
    p_product_id: key.product_id,
    p_order_id: key.order_id,
    p_discord_id: key.bound_discord_id,
    p_new_key_plaintext: plaintext,
    p_new_key_prefix: configuredPrefix,
    p_new_key_suffix: suffix,
    p_actor_discord_id: key.bound_discord_id,
  };
  let result: unknown = null;
  let rpcError: { message: string } | null = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await admin.rpc(
      'commerce_rotate_license_and_stage_receipt',
      rotationArgs,
    );
    result = response.data;
    rpcError = response.error;
    if (
      !rpcError
      || rpcError.message === 'license_rotate_key_without_receipt_stage: entitlement is not usable'
    ) break;
  }

  if (rpcError?.message === 'license_rotate_key_without_receipt_stage: entitlement is not usable') {
    return NextResponse.json(
      { error: 'This licence no longer has active access and cannot be rotated.' },
      { status: 409 },
    );
  }
  if (rpcError) return dbError(rpcError, 'portal/licenses/rotate');

  const status = (result as { status?: string } | null)?.status;

  if (status === 'not_found') {
    return NextResponse.json({ error: 'Licence not found' }, { status: 404 });
  }
  if (status === 'not_rotatable') {
    return NextResponse.json(
      { error: 'This licence is not in a state that can be rotated.' },
      { status: 409 },
    );
  }
  if (status === 'held') {
    return NextResponse.json(
      {
        error: 'The prior rotation cannot be safely matched to a delivery. Contact the seller.',
        delivery: 'held',
      },
      { status: 409 },
    );
  }

  const orderNumber = order?.order_number;
  const amountCents = order?.amount_cents;
  const currency = order?.currency;
  if (
    typeof orderNumber !== 'string'
    || orderNumber.length === 0
    || orderNumber.trim() !== orderNumber
    || !Number.isSafeInteger(amountCents)
    || (amountCents as number) < 0
    || typeof currency !== 'string'
    || !/^[A-Za-z]{3}$/.test(currency)
  ) {
    return NextResponse.json(
      { error: 'This licence has no complete financial identity and cannot be rotated.' },
      { status: 409 },
    );
  }
  const canonicalCurrency = currency.toUpperCase();

  const rotated = stagedRotationResultSchema.safeParse(result);
  if (
    !rotated.success
    || rotated.data.old_key_id !== licenseKeyId
    || rotated.data.new_key_id === licenseKeyId
    || rotated.data.guild_id !== key.guild_id
    || rotated.data.customer_id !== key.customer_id
    || rotated.data.product_id !== key.product_id
    || rotated.data.order_id !== key.order_id
    || rotated.data.discord_id !== key.bound_discord_id
    || rotated.data.license_key_id !== rotated.data.new_key_id
    || rotated.data.order_number !== orderNumber
    || rotated.data.amount_cents !== amountCents
    || rotated.data.currency !== canonicalCurrency
    || (rotated.data.status === 'rotated' && rotated.data.action_status !== 'pending')
    || (rotated.data.status === 'rotated' && rotated.data.new_key_suffix !== suffix)
  ) {
    return NextResponse.json(
      { error: 'Licence rotation returned inconsistent staged delivery evidence.' },
      { status: 500 },
    );
  }

  // A replay is safe only because the original atomic transaction returned
  // the exact durable carrier. The retry's freshly generated plaintext was
  // never stored and the authoritative successor suffix comes from SQL.
  if (rotated.data.status === 'already_rotated') {
    if (rotated.data.action_status === 'failed') {
      return NextResponse.json(
        {
          error: 'The replacement key delivery needs seller attention.',
          alreadyRotated: true,
          newKeySuffix: rotated.data.new_key_suffix,
          delivery: 'held',
        },
        { status: 409 },
      );
    }
    return NextResponse.json({
      success: true,
      alreadyRotated: true,
      newKeySuffix: rotated.data.new_key_suffix,
      delivery: rotated.data.delivery,
      message: rotated.data.action_status === 'completed'
        ? 'This licence was already rotated and its replacement delivery completed.'
        : 'This licence was already rotated. Check your DMs for the replacement key.',
    });
  }

  return NextResponse.json({
    success: true,
    newKeySuffix: rotated.data.new_key_suffix,
    delivery: rotated.data.delivery,
    message: 'Your old key stopped working and a new one is on its way by DM.',
  });
}
