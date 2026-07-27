/**
 * PATCH /api/commerce/requests/[id] — the owner decides one customer request.
 *
 * ── What this does NOT do ─────────────────────────────────────────────────
 * It never mutates payments, orders or entitlements. Marking a refund request
 * 'resolved' does not move money — refunds run through the existing
 * `commerce_admin_refund_operations` state machine, and the response returns a
 * pointer to it. Conflating "I have decided" with "the money moved" is how a
 * buyer ends up told they were refunded when they were not.
 *
 * ── Why transitions are enforced ──────────────────────────────────────────
 * A decision is COMMUNICATED to the buyer. Silently re-deciding a request the
 * customer has already been told about would make the record disagree with what
 * they were sent, so an already-decided request is a 409 rather than an
 * overwrite. For the same reason the recorded admin change offers no undo: a
 * communicated decision cannot be quietly reversed — the owner files a new
 * decision, which the buyer is told about too.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { requireGuildOwner } from '@/lib/api/require-owner';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { checkAdminRateLimit } from '@/lib/api/admin-rate-limit';
import { parseBody } from '@/lib/api/validation';
import { dbError } from '@/lib/api/response';
import { recordAdminChange } from '@/lib/admin-changes';

const idSchema = z.string().uuid();

const patchSchema = z.object({
  status: z.enum(['reviewing', 'resolved', 'rejected']),
  // Shown to the customer with the decision, so a rejection is never a bare
  // "no". Required for a final decision; optional when merely picking it up.
  resolution_note: z.string().trim().max(2000).optional(),
}).refine(
  (d) => d.status === 'reviewing' || (d.resolution_note?.length ?? 0) > 0,
  { message: 'A resolved or rejected request needs a note explaining the decision to the customer' },
);

/** Which statuses may follow which. Decided requests are terminal. */
const ALLOWED_NEXT: Record<string, readonly string[]> = {
  pending: ['reviewing', 'resolved', 'rejected'],
  reviewing: ['resolved', 'rejected'],
  resolved: [],
  rejected: [],
};

export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const limited = await checkAdminRateLimit(request, 'write');
  if (limited) return limited;

  const auth = await requireGuildOwner();
  if (!auth.ok) return auth.response;
  const { guildId, discordId } = auth.ctx;

  const { id: rawId } = await context.params;
  const parsedId = idSchema.safeParse(rawId);
  if (!parsedId.success) {
    return NextResponse.json({ success: false, error: 'Invalid request ID' }, { status: 400 });
  }
  const requestId = parsedId.data;

  const parsed = await parseBody(request, patchSchema);
  if (!parsed.ok) return parsed.response;
  const { status, resolution_note } = parsed.data;

  const admin = createAdminSupabase();

  const { data: existing, error: readError } = await admin
    .from('commerce_portal_requests')
    .select('id, type, status, order_id, customer_id, customer_notified')
    .eq('id', requestId)
    .eq('guild_id', guildId)
    .maybeSingle();

  if (readError) return dbError(readError, 'commerce/requests');
  if (!existing) {
    return NextResponse.json({ success: false, error: 'Request not found' }, { status: 404 });
  }

  const current = String((existing as { status: string }).status);
  if (!ALLOWED_NEXT[current]?.includes(status)) {
    return NextResponse.json(
      {
        success: false,
        error: current === status
          ? `This request is already ${current}.`
          : `A ${current} request cannot become ${status}. `
            + 'A decision the customer has been told about cannot be silently changed — '
            + 'file a new decision instead.',
      },
      { status: 409 },
    );
  }

  const decided = status === 'resolved' || status === 'rejected';

  // Guarded on the CURRENT status so two owners deciding at once cannot both
  // win — the loser's update matches zero rows and is reported as a conflict
  // rather than overwriting the first decision.
  const { data: updated, error } = await admin
    .from('commerce_portal_requests')
    .update({
      status,
      resolution_note: resolution_note ?? null,
      reviewer_id: discordId,
      decided_at: decided ? new Date().toISOString() : null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', requestId)
    .eq('guild_id', guildId)
    .eq('status', current)
    .select('id, status')
    .maybeSingle();

  if (error) return dbError(error, 'commerce/requests');
  if (!updated) {
    return NextResponse.json(
      { success: false, error: 'This request was decided by someone else a moment ago.' },
      { status: 409 },
    );
  }

  const requestType = String((existing as { type: string }).type);

  await recordAdminChange({
    guildId,
    actorId: discordId,
    action: `commerce.portal_request_${status === 'reviewing' ? 'reviewed' : status}`,
    targetType: `${requestType} request`,
    targetId: requestId,
    description: status === 'reviewing'
      ? `Started reviewing a customer ${requestType} request`
      : `Marked a customer ${requestType} request as ${status}`,
    before: { status: current },
    after: { status, resolution_note: resolution_note ?? null },
    blastRadius: decided ? 'medium' : 'low',
    undoReason: 'a decision communicated to the customer cannot be silently reversed',
  }, admin);

  return NextResponse.json({
    success: true,
    data: updated,
    // Deciding a refund request does NOT move money. Point at the tool that
    // does, so the two never get conflated.
    ...(requestType === 'refund' && status === 'resolved'
      ? {
          notice: 'Marked resolved. This did not issue a refund — use the order\'s refund '
            + 'action to actually return the payment.',
          refundOrderId: (existing as { order_id: string | null }).order_id,
        }
      : {}),
  });
}
