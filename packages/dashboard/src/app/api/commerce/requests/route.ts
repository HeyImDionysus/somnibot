/**
 * GET /api/commerce/requests — the owner's queue of customer refund/support
 * requests.
 *
 * `commerce_portal_requests` shipped so buyers could ask for a refund or
 * support without emailing anyone. Customers could file. **Nothing ever read
 * the queue.** Every request has sat at 'pending' since the table landed, with
 * no owner surface and no way to answer. A request queue nobody reads is worse
 * than no queue — it looks like asking works.
 *
 * This is the read side. Decisions are made through `[id]/route.ts`, and a
 * decision NEVER touches payments, orders or entitlements: refunds run through
 * the existing `commerce_admin_refund_operations` state machine. This queue
 * records the human decision and points at the refund tool.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { requireGuildOwner } from '@/lib/api/require-owner';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { dbError } from '@/lib/api/response';

const REQUEST_STATUSES = ['pending', 'reviewing', 'resolved', 'rejected'] as const;

const querySchema = z.object({
  status: z.enum(REQUEST_STATUSES).optional(),
  type: z.enum(['refund', 'service']).optional(),
});

export async function GET(request: NextRequest) {
  const auth = await requireGuildOwner();
  if (!auth.ok) return auth.response;
  const { guildId } = auth.ctx;

  const { searchParams } = new URL(request.url);
  const parsed = querySchema.safeParse({
    status: searchParams.get('status') ?? undefined,
    type: searchParams.get('type') ?? undefined,
  });
  if (!parsed.success) {
    return NextResponse.json({ success: false, error: 'Invalid filter' }, { status: 400 });
  }

  // Clamped for the same reason the incidents list is: an unbounded pageSize
  // lets one request pull the entire history in a single range scan.
  const rawPage = parseInt(searchParams.get('page') ?? '1', 10);
  const rawPageSize = parseInt(searchParams.get('pageSize') ?? '25', 10);
  const page = Number.isFinite(rawPage) ? Math.max(1, rawPage) : 1;
  const pageSize = Number.isFinite(rawPageSize) ? Math.min(100, Math.max(1, rawPageSize)) : 25;

  const admin = createAdminSupabase();

  let query = admin
    .from('commerce_portal_requests')
    .select(
      'id, type, status, reason, created_at, updated_at, decided_at, reviewer_id, '
      + 'resolution_note, customer_notified, order_id, '
      + 'customers(id, discord_id, email), orders(id, order_number, amount_cents, currency)',
      { count: 'exact' },
    )
    .eq('guild_id', guildId)
    // Oldest first: the queue is work to get through, and the buyer who has
    // waited longest should be at the top.
    .order('created_at', { ascending: true })
    .range((page - 1) * pageSize, page * pageSize - 1);

  if (parsed.data.status) query = query.eq('status', parsed.data.status);
  if (parsed.data.type) query = query.eq('type', parsed.data.type);

  const { data, error, count } = await query;
  if (error) return dbError(error, 'commerce/requests');

  // Ages are computed here so the page can flag anything left waiting without
  // every row doing date maths in the browser.
  const now = Date.now();
  // The embedded joins make the generated row type awkward; read through
  // unknown so the age/staleness derivation below stays readable.
  const rows: Array<Record<string, unknown>> = ((data ?? []) as unknown as Array<Record<string, unknown>>).map((r) => {
    const createdAt = typeof r.created_at === 'string' ? Date.parse(r.created_at) : NaN;
    const ageHours = Number.isFinite(createdAt)
      ? Math.floor((now - createdAt) / 3_600_000)
      : null;
    return {
      ...r,
      ageHours,
      // 48h is the threshold the pending-request alert uses, so the page and
      // the alert agree on what "left waiting" means.
      stale: r.status === 'pending' && ageHours !== null && ageHours >= 48,
    };
  });

  const pending = rows.filter((r) => r.status === 'pending').length;

  return NextResponse.json({
    success: true,
    data: rows,
    summary: {
      pending,
      // Decided but never delivered to the buyer — outstanding work that would
      // otherwise be invisible.
      awaitingDelivery: rows.filter((r) => r.decided_at && r.customer_notified === false).length,
      stale: rows.filter((r) => r.stale).length,
    },
    pagination: {
      page,
      pageSize,
      total: count ?? 0,
      totalPages: Math.ceil((count ?? 0) / pageSize),
    },
  });
}
