/**
 * /api/store/promotions — Promotion/Coupon read + cleanup.
 *
 * GET: List all promotions
 * POST: REFUSED (501) — see PROMOTIONS_DISABLED_MESSAGE
 * PUT: REFUSED (501) — see PROMOTIONS_DISABLED_MESSAGE
 * DELETE: Delete a promotion
 *
 * ── Why writes are refused (Finding 8) ──────────────────────────────────────
 * There is NO redemption path for a promotion anywhere in the codebase.
 * `promotions` is read only by this route and by `api/analytics` (display).
 * Checkout (`packages/bot/src/features/commerce/payment-handler.ts`) prices the
 * PayPal order straight from `product.price_cents`, never consults
 * `promotions`, and never writes `orders.discount_cents`. A coupon code created
 * here would be advertised to customers and then silently ignored — every buyer
 * charged full price.
 *
 * The write path was also dead on arrival and has never created a row: the DB
 * CHECK is `type IN ('percentage','fixed_amount')` while `schemas.promotion.create`
 * is `z.enum(['percent','fixed'])`, so a request that satisfies one violates the
 * other. The dashboard form additionally posted `discount_value`/`starts_at`/
 * `ends_at` against a schema expecting `value`/`start_date`/`end_date`, and
 * ignored the resulting 400 while toasting success.
 *
 * Refusing here — not just hiding the form — is what makes the promise
 * impossible to make: a stale tab, a bookmarked page, or a direct API call
 * cannot create a coupon that will not be honoured. Reads and deletes stay open
 * so existing rows remain visible and removable.
 *
 * Reinstating writes means shipping redemption with it: integer-cents
 * arithmetic only (`promotions.value` is the codebase's one NUMERIC money-ish
 * column and must become integer columns), a unique index on `coupon_code`,
 * validity/expiry/usage enforced server-side under the same lock that freezes
 * the order price, and the discount recorded in `orders.discount_cents`.
 */
import { NextRequest, NextResponse } from 'next/server';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { requireGuildOwner } from '@/lib/api/require-owner';
import { z } from 'zod';
import { checkAdminRateLimit } from '@/lib/api/admin-rate-limit';
import { apiError, dbError } from '@/lib/api/response';
import { readRowBefore, recordCrudChange } from '@/lib/admin-changes';

// NOT exported. A Next.js App Router route module may only export the HTTP
// method handlers and Next's own route config keys (`dynamic`, `revalidate`,
// `runtime`, `maxDuration`, …); any other export fails the route-type check that
// `next build` generates. Nothing outside this file needs it, and `type-check`
// does NOT catch this — only a full build does.
const PROMOTIONS_DISABLED_MESSAGE =
  'Coupons and promotions are disabled: nothing in checkout redeems them, so a '
  + 'discount code created here would never be applied and every customer would '
  + 'still be charged the full price. Existing promotions can be viewed and '
  + 'deleted.';

/** 501 Not Implemented — the feature is absent, not the request malformed. */
function promotionsDisabled() {
  return apiError(PROMOTIONS_DISABLED_MESSAGE, 501);
}

export async function GET() {
  const auth = await requireGuildOwner();
  if (!auth.ok) return auth.response;
  const { guildId } = auth.ctx;

  const supabase = createAdminSupabase();

  const { data, error } = await supabase
    .from('promotions')
    .select('*')
    .eq('guild_id', guildId)
    .order('created_at', { ascending: false })
    .limit(500);

  if (error) {
    return dbError(error, 'store/promotions');
  }

  return NextResponse.json({ success: true, data: data ?? [] });
}

export async function POST(req: NextRequest) {
  const rateLimited = await checkAdminRateLimit(req, 'write');
  if (rateLimited) return rateLimited;

  const auth = await requireGuildOwner();
  if (!auth.ok) return auth.response;

  // Refused before any write: a coupon that checkout will not redeem must not
  // be creatable from a stale tab, a bookmark, or a direct API call.
  return promotionsDisabled();
}

export async function PUT(req: NextRequest) {
  const rateLimited = await checkAdminRateLimit(req, 'write');
  if (rateLimited) return rateLimited;

  const auth = await requireGuildOwner();
  if (!auth.ok) return auth.response;

  return promotionsDisabled();
}

export async function DELETE(req: NextRequest) {
  const rateLimited = await checkAdminRateLimit(req, 'write');
  if (rateLimited) return rateLimited;

  const auth = await requireGuildOwner();
  if (!auth.ok) return auth.response;
  const { guildId } = auth.ctx;

  const supabase = createAdminSupabase();
  const { searchParams } = new URL(req.url);
  const id = searchParams.get('id');

  if (!id) {
    return NextResponse.json({ success: false, error: 'Missing promotion id' }, { status: 400 });
  }

  // V6 Audit §2.3: Validate UUID format before sending to DB
  const uuidCheck = z.string().uuid().safeParse(id);
  if (!uuidCheck.success) {
    return NextResponse.json({ success: false, error: 'Invalid promotion id format' }, { status: 400 });
  }

  const before = await readRowBefore(supabase, 'promotions', { id: id, guild_id: auth.ctx.guildId });

  const { error } = await supabase
    .from('promotions')
    .delete()
    .eq('id', id)
    .eq('guild_id', guildId);

  if (error) {
    return dbError(error, 'store/promotions');
  }

  await recordCrudChange({
    guildId: auth.ctx.guildId,
    actorId: auth.ctx.discordId,
    operation: 'deleted',
    action: 'store.promotion_deleted',
    table: 'promotions',
    targetType: 'promotion',
    targetId: id,
    label: before?.code as string | undefined,

    before,
    blastRadius: 'medium',
  }, supabase);

  return NextResponse.json({ success: true });
}
