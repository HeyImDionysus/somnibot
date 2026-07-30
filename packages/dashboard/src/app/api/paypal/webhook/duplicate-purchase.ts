/**
 * Atomic paid-fulfillment arbitration.
 *
 * Checkout-time uniqueness prevents new duplicate approval links, but an older
 * one-time order or subscription can still become payable after another link
 * wins. A JavaScript entitlement precheck cannot serialize two webhooks: both
 * requests can read "none" before either queues access.
 *
 * `commerce_claim_paid_fulfillment` is the database boundary. It chooses one
 * durable winner per guild/customer/product, preserves same-order replay, and
 * atomically persists both a permanent loser hold and its critical operator
 * alert. No fulfillment payload or licence key may be staged before it wins.
 */
import type { createAdminSupabase } from '@/lib/supabase/admin';

type AdminSupabase = ReturnType<typeof createAdminSupabase>;

export interface PaidFulfillmentOrder {
  id: string;
  order_number: string;
  guild_id: string;
  customer_id: string;
  product_id: string;
}

export interface PaidFulfillmentClaim {
  order_id: string;
  disposition: 'winner' | 'held';
  winning_order_id: string | null;
  conflicting_entitlement_id: string | null;
  alert_id: string | null;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function nullableNonEmptyString(value: unknown): value is string | null {
  return value === null || nonEmptyString(value);
}

function parsePaidFulfillmentClaim(
  data: unknown,
  expectedOrderId: string,
): PaidFulfillmentClaim {
  if (!data || typeof data !== 'object') {
    throw new Error('Paid fulfillment claim RPC returned malformed data');
  }
  const candidate = data as Record<string, unknown>;
  if (
    candidate.order_id !== expectedOrderId
    || !['winner', 'held'].includes(String(candidate.disposition))
    || !nullableNonEmptyString(candidate.winning_order_id)
    || !nullableNonEmptyString(candidate.conflicting_entitlement_id)
    || !nullableNonEmptyString(candidate.alert_id)
  ) {
    throw new Error('Paid fulfillment claim RPC returned malformed identity');
  }
  if (
    candidate.disposition === 'winner'
    && (
      candidate.winning_order_id !== expectedOrderId
      || candidate.conflicting_entitlement_id !== null
      || candidate.alert_id !== null
    )
  ) {
    throw new Error('Paid fulfillment winner RPC returned an inconsistent result');
  }
  if (candidate.disposition === 'held' && !nonEmptyString(candidate.alert_id)) {
    throw new Error('Paid fulfillment hold has no durable critical alert');
  }
  return candidate as unknown as PaidFulfillmentClaim;
}

export async function claimPaidFulfillment(
  supabase: AdminSupabase,
  order: PaidFulfillmentOrder,
  provider: {
    kind: 'capture' | 'subscription';
    id: string;
    amountCents: number;
    currency: string;
  },
): Promise<PaidFulfillmentClaim> {
  const { data, error } = await supabase.rpc('commerce_claim_paid_fulfillment', {
    p_order_id: order.id,
    p_guild_id: order.guild_id,
    p_customer_id: order.customer_id,
    p_product_id: order.product_id,
    p_provider_kind: provider.kind,
    p_provider_id: provider.id,
    p_amount_cents: provider.amountCents,
    p_currency: provider.currency,
  });
  if (error) {
    throw new Error(`Failed to claim paid fulfillment: ${error.message}`);
  }
  return parsePaidFulfillmentClaim(data, order.id);
}

/**
 * Reserve the paid winner while permanently withholding automatic delivery
 * because its immutable sold-delivery contract is absent. The claim, hold, and
 * critical operator alert are one database transaction.
 */
export async function holdUnknownDeliveryContract(
  supabase: AdminSupabase,
  order: PaidFulfillmentOrder,
  provider: {
    kind: 'capture' | 'subscription';
    id: string;
    amountCents: number;
    currency: string;
  },
): Promise<PaidFulfillmentClaim> {
  const { data, error } = await supabase.rpc('commerce_hold_unknown_delivery_contract', {
    p_order_id: order.id,
    p_guild_id: order.guild_id,
    p_customer_id: order.customer_id,
    p_product_id: order.product_id,
    p_provider_kind: provider.kind,
    p_provider_id: provider.id,
    p_amount_cents: provider.amountCents,
    p_currency: provider.currency,
  });
  if (error) {
    throw new Error(`Failed to hold unknown delivery contract: ${error.message}`);
  }
  const claim = parsePaidFulfillmentClaim(data, order.id);
  if (claim.disposition !== 'held') {
    throw new Error('Unknown delivery contract RPC did not persist a durable hold');
  }
  return claim;
}
