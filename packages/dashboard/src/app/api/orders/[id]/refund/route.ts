/**
 * POST /api/orders/[id]/refund — drive one durable, attempt-keyed owner
 * refund without guessing whether PayPal accepted an ambiguous request.
 */
import { NextRequest, NextResponse } from 'next/server';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { requireGuildOwner } from '@/lib/api/require-owner';
import { parseBody, schemas } from '@/lib/api/validation';
import { getPayPalRuntimeConfig, getPayPalToken } from '@/lib/paypal';
import { checkAdminRateLimit } from '@/lib/api/admin-rate-limit';
import { isCanonicalPayPalResourceId } from '@/lib/paypal-resource-id';

type AttemptStatus =
  | 'prepared'
  | 'pending'
  | 'provider_completed'
  | 'failed'
  | 'cancelled'
  | 'completed';
type ProviderAction = 'create' | 'poll' | 'finalize' | 'none';
type ProviderStatus = 'PENDING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';

interface RefundAttempt {
  orderId: string;
  attemptId: string;
  requestId: string;
  status: AttemptStatus;
  providerAction: ProviderAction;
  resourceType: 'capture' | null;
  paypalPaymentId: string | null;
  paypalRefundId: string | null;
  refundAmountCents: number;
  currency: string;
  reason: string;
  actorId: string;
}

interface ProviderOutcome {
  status: ProviderStatus;
  id: string | null;
  amountCents: number | null;
  currency: string | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function isPaidAttempt(attempt: {
  resourceType: unknown;
  paypalPaymentId: unknown;
  refundAmountCents: unknown;
}): boolean {
  return attempt.resourceType === 'capture'
    && isCanonicalPayPalResourceId(attempt.paypalPaymentId)
    && Number.isSafeInteger(attempt.refundAmountCents)
    && (attempt.refundAmountCents as number) > 0;
}

function isLocalAttempt(attempt: {
  resourceType: unknown;
  paypalPaymentId: unknown;
  paypalRefundId: unknown;
  refundAmountCents: unknown;
}): boolean {
  return attempt.resourceType === null
    && attempt.paypalPaymentId === null
    && attempt.paypalRefundId === null
    && attempt.refundAmountCents === 0;
}

function parseAttempt(
  value: unknown,
  expectedOrderId: string,
): RefundAttempt | null {
  const row = asRecord(value);
  if (!row) return null;

  const attemptId = row.attempt_id;
  const requestId = row.request_id;
  const status = row.status;
  const providerAction = row.provider_action;
  const resourceType = row.resource_type;
  const paypalPaymentId = row.paypal_payment_id;
  const paypalRefundId = row.paypal_refund_id;
  const refundAmountCents = row.refund_amount_cents;
  const currency = row.currency;
  const reason = row.reason;
  const actorId = row.actor_id;

  if (
    row.order_id !== expectedOrderId
    || !isUuid(attemptId)
    || requestId !== attemptId
    || !['prepared', 'pending', 'provider_completed', 'failed', 'cancelled', 'completed'].includes(status as string)
    || !['create', 'poll', 'finalize', 'none'].includes(providerAction as string)
    || (resourceType !== null && resourceType !== 'capture')
    || (paypalPaymentId !== null && !isCanonicalPayPalResourceId(paypalPaymentId))
    || (paypalRefundId !== null && !isCanonicalPayPalResourceId(paypalRefundId))
    || !Number.isSafeInteger(refundAmountCents)
    || (refundAmountCents as number) < 0
    || typeof currency !== 'string'
    || !/^[A-Z]{3}$/.test(currency)
    || typeof reason !== 'string'
    || reason !== reason.trim()
    || reason.length < 1
    || reason.length > 255
    || typeof actorId !== 'string'
    || actorId !== actorId.trim()
    || actorId.length < 1
    || actorId.length > 255
  ) return null;

  const candidate = {
    resourceType,
    paypalPaymentId,
    paypalRefundId,
    refundAmountCents,
  };
  const paid = isPaidAttempt(candidate);
  const local = isLocalAttempt(candidate);
  const hasRefundId = isCanonicalPayPalResourceId(paypalRefundId);
  const exactState =
    (status === 'prepared' && providerAction === 'create' && paid && paypalRefundId === null)
    || (status === 'prepared' && providerAction === 'finalize' && local)
    || (status === 'pending' && providerAction === 'poll' && paid && hasRefundId)
    || (status === 'provider_completed' && providerAction === 'finalize' && paid && hasRefundId)
    || ((status === 'failed' || status === 'cancelled')
      && providerAction === 'none' && paid && (paypalRefundId === null || hasRefundId))
    || (status === 'completed' && providerAction === 'none'
      && (local || (paid && hasRefundId)));
  if (!exactState) return null;

  return {
    orderId: expectedOrderId,
    attemptId,
    requestId,
    status: status as AttemptStatus,
    providerAction: providerAction as ProviderAction,
    resourceType: resourceType as 'capture' | null,
    paypalPaymentId: paypalPaymentId as string | null,
    paypalRefundId: paypalRefundId as string | null,
    refundAmountCents: refundAmountCents as number,
    currency,
    reason,
    actorId,
  };
}

function sameFrozenContract(before: RefundAttempt, after: RefundAttempt): boolean {
  return before.orderId === after.orderId
    && before.attemptId === after.attemptId
    && before.requestId === after.requestId
    && before.resourceType === after.resourceType
    && before.paypalPaymentId === after.paypalPaymentId
    && before.refundAmountCents === after.refundAmountCents
    && before.currency === after.currency
    && before.reason === after.reason
    && before.actorId === after.actorId;
}

function isAllowedRecordedState(outcome: ProviderStatus, status: AttemptStatus): boolean {
  switch (outcome) {
    case 'PENDING':
      return ['pending', 'provider_completed', 'failed', 'cancelled', 'completed'].includes(status);
    case 'COMPLETED':
      return status === 'provider_completed' || status === 'completed';
    case 'FAILED':
      return status === 'failed';
    case 'CANCELLED':
      return status === 'cancelled';
  }
}

function hasCompatibleRecordedProviderId(
  outcome: ProviderOutcome,
  recorded: RefundAttempt,
): boolean {
  if (recorded.paypalRefundId === outcome.id) return true;
  return outcome.status === 'PENDING'
    && outcome.id !== null
    && (recorded.status === 'failed' || recorded.status === 'cancelled')
    && recorded.paypalRefundId === null;
}

function formatCents(cents: number): string {
  const value = BigInt(cents);
  const oneHundred = BigInt(100);
  return `${value / oneHundred}.${(value % oneHundred).toString().padStart(2, '0')}`;
}

function parseAmountCents(value: unknown): number | null {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/.test(value)) {
    return null;
  }
  const [whole, fractional = ''] = value.split('.');
  const cents = (BigInt(whole) * BigInt(100)) + BigInt(fractional.padEnd(2, '0'));
  return cents <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(cents) : null;
}

function parseProviderOutcome(value: unknown, attempt: RefundAttempt): ProviderOutcome | null {
  const row = asRecord(value);
  if (!row || !['PENDING', 'COMPLETED', 'FAILED', 'CANCELLED'].includes(row.status as string)) {
    return null;
  }
  const status = row.status as ProviderStatus;
  const amount = asRecord(row.amount);
  const amountCents = parseAmountCents(amount?.value);
  const currency = amount?.currency_code;
  const hasFullResult = isCanonicalPayPalResourceId(row.id)
    && amountCents === attempt.refundAmountCents
    && currency === attempt.currency;
  const hasNullResult = row.id == null && row.amount == null;

  if (status === 'PENDING' || status === 'COMPLETED') {
    if (!hasFullResult) return null;
  } else if (attempt.providerAction === 'poll') {
    if (!hasFullResult || row.id !== attempt.paypalRefundId) return null;
  } else if (!hasFullResult && !hasNullResult) {
    return null;
  }
  if (attempt.providerAction === 'poll' && hasFullResult && row.id !== attempt.paypalRefundId) {
    return null;
  }

  return hasFullResult
    ? { status, id: row.id as string, amountCents, currency: currency as string }
    : { status, id: null, amountCents: null, currency: null };
}

function parseFinalizationResult(value: unknown, attempt: RefundAttempt): boolean {
  const row = asRecord(value);
  if (!row) return false;
  const alreadyRefunded = row.already_refunded;
  const counters = ['entitlements_changed', 'licenses_changed', 'sessions_changed']
    .map((key) => row[key]);
  return row.order_id === attempt.orderId
    && row.attempt_id === attempt.attemptId
    && row.status === 'completed'
    && row.order_status === 'refunded'
    && typeof alreadyRefunded === 'boolean'
    && counters.every((counter) => Number.isSafeInteger(counter) && (counter as number) >= 0)
    && (alreadyRefunded !== true || counters.every((counter) => counter === 0))
    && row.paypal_refund_id === attempt.paypalRefundId;
}

function providerUnconfirmedResponse() {
  return NextResponse.json(
    {
      success: false,
      status: 'unconfirmed',
      code: 'PROVIDER_REQUEST_UNCONFIRMED',
      error: 'PayPal refund status could not be confirmed. Retry this attempt safely.',
    },
    { status: 502 },
  );
}

function persistenceFailureResponse(status: AttemptStatus) {
  const providerCompleted = status === 'provider_completed';
  return NextResponse.json(
    {
      success: false,
      status: providerCompleted ? 'provider_completed' : 'unconfirmed',
      code: providerCompleted ? 'LOCAL_FINALIZATION_PENDING' : 'REFUND_STATE_SAVE_FAILED',
      error: providerCompleted
        ? 'PayPal completed the refund, but access cleanup is still pending. Retry to finish safely.'
        : 'Refund state could not be saved. Retry this attempt safely.',
    },
    { status: 500 },
  );
}

function pendingResponse() {
  return NextResponse.json(
    {
      success: true,
      status: 'pending',
      code: 'REFUND_PENDING',
      message: 'PayPal is still processing this refund. Access has not been changed yet.',
    },
    { status: 202 },
  );
}

function terminalProviderResponse(status: 'failed' | 'cancelled') {
  const cancelled = status === 'cancelled';
  return NextResponse.json(
    {
      success: false,
      status,
      code: cancelled ? 'PROVIDER_CANCELLED' : 'PROVIDER_FAILED',
      error: cancelled
        ? 'PayPal cancelled the refund. Customer access remains active.'
        : 'PayPal reported that the refund failed. Customer access remains active.',
    },
    { status: 422 },
  );
}

function completedResponse() {
  return NextResponse.json({ success: true, status: 'completed' });
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const rateLimited = await checkAdminRateLimit(req, 'write');
  if (rateLimited) return rateLimited;

  const auth = await requireGuildOwner();
  if (!auth.ok) return auth.response;
  const { guildId, discordId } = auth.ctx;
  const { id: orderId } = await params;

  if (!isUuid(orderId)) {
    return NextResponse.json(
      {
        success: false,
        status: 'invalid_request',
        code: 'INVALID_ORDER_ID',
        error: 'Invalid order id format.',
      },
      { status: 400 },
    );
  }

  const parsed = await parseBody(req, schemas.order.refund);
  if (!parsed.ok) return parsed.response;
  const supabase = createAdminSupabase();

  const { data: preparationData, error: preparationError } = await supabase.rpc(
    'commerce_prepare_admin_refund',
    {
      p_order_id: orderId,
      p_guild_id: guildId,
      p_actor_id: discordId,
      p_reason: parsed.data.reason ?? 'Admin refund',
    },
  );
  if (preparationError) {
    console.error('[Commerce] Admin refund preparation rejected:', {
      orderId,
      guildId,
      code: preparationError.code,
    });
    if (preparationError.code === '23514') {
      return NextResponse.json(
        {
          success: false,
          status: 'not_refundable',
          code: 'ORDER_NOT_REFUNDABLE',
          error: 'This order cannot be refunded from the owner order list.',
        },
        { status: 409 },
      );
    }
    return NextResponse.json(
      {
        success: false,
        status: 'preparation_failed',
        code: 'REFUND_PREPARATION_FAILED',
        error: 'Refund preparation failed unexpectedly. Please retry.',
      },
      { status: 500 },
    );
  }

  let attempt = parseAttempt(preparationData, orderId);
  if (!attempt) {
    console.error('[Commerce] Refund preparation returned malformed data:', { orderId, guildId });
    return persistenceFailureResponse('prepared');
  }

  if (attempt.status === 'completed') return completedResponse();
  if (attempt.status === 'failed' || attempt.status === 'cancelled') {
    return terminalProviderResponse(attempt.status);
  }

  if (attempt.providerAction === 'create' || attempt.providerAction === 'poll') {
    let outcome: ProviderOutcome;
    try {
      const paypalConfig = await getPayPalRuntimeConfig();
      const rawToken = await getPayPalToken(paypalConfig);
      const token = typeof rawToken === 'string' ? rawToken.trim() : '';
      if (!token) return providerUnconfirmedResponse();

      const creating = attempt.providerAction === 'create';
      const providerResponse = await fetch(
        creating
          ? `${paypalConfig.apiBase}/v2/payments/captures/${encodeURIComponent(attempt.paypalPaymentId!)}/refund`
          : `${paypalConfig.apiBase}/v2/payments/refunds/${encodeURIComponent(attempt.paypalRefundId!)}`,
        creating
          ? {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${token}`,
                'PayPal-Request-Id': attempt.requestId,
                Prefer: 'return=representation',
              },
              body: JSON.stringify({
                amount: {
                  value: formatCents(attempt.refundAmountCents),
                  currency_code: attempt.currency,
                },
                note_to_payer: attempt.reason,
              }),
              signal: AbortSignal.timeout(15_000),
            }
          : {
              method: 'GET',
              headers: {
                Accept: 'application/json',
                Authorization: `Bearer ${token}`,
              },
              signal: AbortSignal.timeout(15_000),
            },
      );
      if (!providerResponse.ok) return providerUnconfirmedResponse();
      const parsedOutcome = parseProviderOutcome(await providerResponse.json(), attempt);
      if (!parsedOutcome) return providerUnconfirmedResponse();
      outcome = parsedOutcome;
    } catch {
      return providerUnconfirmedResponse();
    }

    const { data: recordedData, error: recordedError } = await supabase.rpc(
      'commerce_record_admin_refund_outcome',
      {
        p_attempt_id: attempt.attemptId,
        p_guild_id: guildId,
        p_provider_status: outcome.status,
        p_paypal_refund_id: outcome.id,
        p_refund_amount_cents: outcome.amountCents,
        p_currency: outcome.currency,
      },
    );
    const recorded = recordedError
      ? null
      : parseAttempt(recordedData, orderId);
    if (
      !recorded
      || !sameFrozenContract(attempt, recorded)
      || !hasCompatibleRecordedProviderId(outcome, recorded)
      || !isAllowedRecordedState(outcome.status, recorded.status)
    ) {
      console.error('[Commerce] Refund provider outcome could not be persisted:', {
        orderId,
        guildId,
        attemptId: attempt.attemptId,
        code: recordedError?.code,
      });
      return persistenceFailureResponse(
        outcome.status === 'COMPLETED' ? 'provider_completed' : attempt.status,
      );
    }
    attempt = recorded;
  }

  if (attempt.status === 'pending') return pendingResponse();
  if (attempt.status === 'failed' || attempt.status === 'cancelled') {
    return terminalProviderResponse(attempt.status);
  }
  if (attempt.status === 'completed') return completedResponse();

  if (attempt.providerAction !== 'finalize') {
    console.error('[Commerce] Refund attempt reached an invalid local transition:', {
      orderId,
      guildId,
      attemptId: attempt.attemptId,
      status: attempt.status,
      providerAction: attempt.providerAction,
    });
    return persistenceFailureResponse(attempt.status);
  }

  const { data: finalizationData, error: finalizationError } = await supabase.rpc(
    'commerce_finalize_admin_refund',
    {
      p_attempt_id: attempt.attemptId,
      p_guild_id: guildId,
    },
  );
  if (finalizationError || !parseFinalizationResult(finalizationData, attempt)) {
    console.error('[Commerce] Refund local finalization is pending:', {
      orderId,
      guildId,
      attemptId: attempt.attemptId,
      code: finalizationError?.code,
    });
    return persistenceFailureResponse(attempt.status);
  }

  return completedResponse();
}
