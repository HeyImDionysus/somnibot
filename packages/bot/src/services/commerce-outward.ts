import type { SupabaseClient } from '@supabase/supabase-js';
import type { PreparedEventDispatch } from './event-bus.js';

export type CommerceOutwardIntentKind =
  | 'purchase_completed_event'
  | 'subscription_activated_event'
  | 'subscription_renewed_event'
  | 'subscription_cancelled_event'
  | 'subscription_cancelled_dm'
  | 'subscription_payment_failed_lapsed_event'
  | 'subscription_payment_failed_event'
  | 'subscription_payment_failed_dm'
  | 'subscription_suspended_event'
  | 'subscription_suspended_dm'
  | 'receipt_dm';

export interface CommerceOutwardResult {
  state: 'absent' | 'sent' | 'uncertain' | 'superseded';
  externalError?: unknown;
}

export interface CommerceOutwardIdentity {
  orderId: string;
  guildId: string;
  intentKind: CommerceOutwardIntentKind;
  outwardGenerationId: string | null;
  actionId: string;
  claimToken: string;
  legacyPredecessorKind?:
    | 'purchase_completed_event'
    | 'subscription_activated_event';
}

export interface PreparedOutwardEffect extends PreparedEventDispatch {}

export type CommerceOutwardBeginMode =
  | 'generated'
  | 'legacy-resume'
  | 'legacy-receipt-continuation';

const SUPERSEDABLE_LIFECYCLE_KINDS = new Set<CommerceOutwardIntentKind>([
  'subscription_renewed_event',
  'subscription_payment_failed_lapsed_event',
  'subscription_payment_failed_event',
  'subscription_payment_failed_dm',
  'subscription_suspended_event',
  'subscription_suspended_dm',
]);

export function preparedOutwardEffect(
  dispatch: () => unknown | Promise<unknown>,
): PreparedOutwardEffect {
  let state: 'prepared' | 'dispatched' | 'cancelled' = 'prepared';
  return {
    dispatch: async () => {
      if (state === 'cancelled') throw new Error('Prepared outward effect was cancelled');
      if (state !== 'prepared') throw new Error('Prepared outward effect was already consumed');
      state = 'dispatched';
      await dispatch();
    },
    cancel: () => {
      if (state === 'prepared') state = 'cancelled';
    },
  };
}

function matchesGeneration(value: unknown, expected: string | null): boolean {
  return value === expected;
}

/**
 * Execute one externally visible commerce effect under its durable SQL fence.
 *
 * Callers prepare any fallible pre-send work and EventBus capacity before
 * invoking this helper. The helper is consequently allowed to create a
 * `sending` row only when dispatch can begin immediately.
 */
export async function runCommerceOutwardIntent(
  supabase: SupabaseClient,
  identity: CommerceOutwardIdentity,
  prepared: PreparedOutwardEffect | null,
  mode: CommerceOutwardBeginMode,
): Promise<CommerceOutwardResult> {
  const {
    orderId,
    guildId,
    intentKind,
    outwardGenerationId,
    actionId,
    claimToken,
    legacyPredecessorKind,
  } = identity;
  const resumeExistingOnly = mode === 'legacy-resume';
  if (mode === 'generated' && outwardGenerationId === null) {
    prepared?.cancel();
    throw new Error('Generated outward intent requires a durable generation');
  }
  if (mode !== 'generated' && outwardGenerationId !== null) {
    prepared?.cancel();
    throw new Error('Legacy outward intent mode requires a null generation');
  }
  if (
    mode === 'legacy-receipt-continuation'
    && (
      intentKind !== 'receipt_dm'
      || ![
        'purchase_completed_event',
        'subscription_activated_event',
      ].includes(String(legacyPredecessorKind))
    )
  ) {
    prepared?.cancel();
    throw new Error('Legacy outward creation is allowed only for receipt continuation');
  }
  if (mode === 'legacy-resume' && prepared !== null) {
    prepared.cancel();
    throw new Error('Legacy outward resume cannot carry a new dispatch');
  }
  if (mode !== 'legacy-resume' && prepared === null) {
    throw new Error('Outward creation requires a prepared dispatch');
  }
  if (mode !== 'legacy-receipt-continuation' && legacyPredecessorKind !== undefined) {
    prepared?.cancel();
    throw new Error('Legacy predecessor identity is valid only for receipt continuation');
  }

  let beginData: unknown;
  let beginError: { message: string } | null;
  try {
    const response = mode === 'legacy-resume'
      ? await supabase.rpc('commerce_resume_fulfillment_outward_intent', {
        p_order_id: orderId,
        p_guild_id: guildId,
        p_intent_kind: intentKind,
      })
      : mode === 'legacy-receipt-continuation'
        ? await supabase.rpc('commerce_continue_legacy_receipt_outward_intent', {
          p_order_id: orderId,
          p_guild_id: guildId,
          p_predecessor_kind: legacyPredecessorKind,
          p_action_id: actionId,
          p_claim_token: claimToken,
        })
        : await supabase.rpc('commerce_begin_fulfillment_outward_intent', {
          p_order_id: orderId,
          p_guild_id: guildId,
          p_intent_kind: intentKind,
          p_outward_generation_id: outwardGenerationId,
          p_action_id: actionId,
          p_claim_token: claimToken,
        });
    beginData = response.data;
    beginError = response.error;
  } catch (error) {
    prepared?.cancel();
    throw error;
  }
  if (beginError) {
    prepared?.cancel();
    throw new Error(`Failed to begin fulfillment outward intent: ${beginError.message}`);
  }
  if (!beginData || typeof beginData !== 'object' || Array.isArray(beginData)) {
    prepared?.cancel();
    throw new Error('Fulfillment outward intent begin returned malformed data');
  }

  const begin = beginData as Record<string, unknown>;
  if (
    resumeExistingOnly
    && begin.order_id === orderId
    && begin.guild_id === guildId
    && begin.intent_kind === intentKind
    && matchesGeneration(begin.outward_generation_id, outwardGenerationId)
    && begin.disposition === 'absent'
    && begin.state === null
    && begin.attempt_token === null
    && begin.alert_id === null
  ) {
    prepared?.cancel();
    return { state: 'absent' };
  }
  if (
    begin.order_id !== orderId
    || begin.guild_id !== guildId
    || begin.intent_kind !== intentKind
    || !matchesGeneration(begin.outward_generation_id, outwardGenerationId)
    || !['send', 'sent', 'uncertain', 'superseded'].includes(String(begin.disposition))
    || !['sending', 'sent', 'uncertain', 'superseded'].includes(String(begin.state))
  ) {
    prepared?.cancel();
    throw new Error('Fulfillment outward intent begin returned malformed identity');
  }
  if (
    begin.disposition === 'sent'
    && begin.state === 'sent'
    && begin.attempt_token === null
    && begin.alert_id === null
  ) {
    prepared?.cancel();
    return { state: 'sent' };
  }
  if (
    begin.disposition === 'uncertain'
    && begin.state === 'uncertain'
    && begin.attempt_token === null
    && typeof begin.alert_id === 'string'
    && begin.alert_id.length > 0
  ) {
    prepared?.cancel();
    return { state: 'uncertain' };
  }
  if (
    begin.disposition === 'superseded'
    && begin.state === 'superseded'
    && SUPERSEDABLE_LIFECYCLE_KINDS.has(intentKind)
    && begin.attempt_token === null
    && begin.alert_id === null
  ) {
    prepared?.cancel();
    return { state: 'superseded' };
  }
  if (
    begin.disposition !== 'send'
    || begin.state !== 'sending'
    || typeof begin.attempt_token !== 'string'
    || begin.attempt_token.length === 0
    || begin.alert_id !== null
    || prepared === null
  ) {
    prepared?.cancel();
    throw new Error('Fulfillment outward intent begin returned inconsistent state');
  }

  let outcome: 'sent' | 'uncertain' = 'sent';
  let externalError: unknown;
  try {
    await prepared.dispatch();
  } catch (error) {
    outcome = 'uncertain';
    externalError = error;
  }

  const errorDetail = externalError instanceof Error
    ? externalError.message
    : externalError === undefined
      ? null
      : String(externalError);
  const { data: finishData, error: finishError } = await supabase.rpc(
    'commerce_finish_fulfillment_outward_intent',
    {
      p_order_id: orderId,
      p_guild_id: guildId,
      p_intent_kind: intentKind,
      p_outward_generation_id: outwardGenerationId,
      p_attempt_token: begin.attempt_token,
      p_outcome: outcome,
      p_error: outcome === 'uncertain'
        ? `external effect did not return acceptance: ${errorDetail ?? 'unknown error'}`
        : null,
    },
  );
  if (finishError) {
    // Dispatch already began. Leaving `sending` is deliberate: the next
    // recovery converts it to operator-held `uncertain` and never resends.
    throw new Error(`Failed to finish fulfillment outward intent: ${finishError.message}`);
  }
  if (!finishData || typeof finishData !== 'object' || Array.isArray(finishData)) {
    throw new Error('Fulfillment outward intent finish returned malformed data');
  }
  const finish = finishData as Record<string, unknown>;
  if (
    finish.order_id !== orderId
    || finish.guild_id !== guildId
    || finish.intent_kind !== intentKind
    || !matchesGeneration(finish.outward_generation_id, outwardGenerationId)
    || !['sent', 'uncertain'].includes(String(finish.state))
    || (outcome === 'sent' && finish.state !== 'sent')
    || (outcome === 'uncertain' && finish.state !== 'uncertain')
    || (finish.state === 'sent' && finish.alert_id !== null)
    || (
      finish.state === 'uncertain'
      && (
        typeof finish.alert_id !== 'string'
        || finish.alert_id.length === 0
      )
    )
  ) {
    throw new Error('Fulfillment outward intent finish returned malformed identity');
  }
  return {
    state: finish.state as 'sent' | 'uncertain',
    ...(externalError === undefined ? {} : { externalError }),
  };
}
