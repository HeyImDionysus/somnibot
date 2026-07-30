/**
 * Operator hold for a paid order whose immutable delivery contract is absent.
 *
 * Orders created before delivery_type_snapshot existed cannot safely infer the
 * sold delivery from today's mutable product/config rows. The provider payment
 * remains visible on the order, but automatic fulfillment is withheld until an
 * owner manually fulfils the exact purchase or refunds it.
 */
import type { createAdminSupabase } from '@/lib/supabase/admin';

type AdminSupabase = ReturnType<typeof createAdminSupabase>;

export const UNKNOWN_DELIVERY_CONTRACT_ALERT_TYPE =
  'commerce_unknown_delivery_contract';

export interface UnknownDeliveryOrder {
  id: string;
  order_number: string;
  guild_id: string;
  customer_id: string;
  product_id: string;
}

export async function raiseUnknownDeliveryContractAlert(
  supabase: AdminSupabase,
  order: UnknownDeliveryOrder,
  provider: {
    kind: 'capture' | 'subscription';
    id: string;
    amountCents: number;
    currency: string;
  },
): Promise<void> {
  const message =
    `Order ${order.order_number} reached PayPal without an immutable delivery `
    + `type snapshot. The ${provider.kind} is recorded, but automatic access and `
    + `licence-key delivery were withheld so today's mutable product settings `
    + `cannot rewrite what was sold. Manually fulfil the exact order or refund `
    + `the customer.`;
  const metadata = {
    source: 'paypal_webhook',
    order_id: order.id,
    order_number: order.order_number,
    customer_id: order.customer_id,
    product_id: order.product_id,
    provider_kind: provider.kind,
    provider_id: provider.id,
    amount_cents: provider.amountCents,
    currency: provider.currency,
    required_action: 'manual_fulfillment_or_refund',
  };

  const { data: refreshed, error: updateError } = await supabase
    .from('alerts')
    .update({ message, metadata, updated_at: new Date().toISOString() })
    .eq('guild_id', order.guild_id)
    .eq('alert_type', UNKNOWN_DELIVERY_CONTRACT_ALERT_TYPE)
    .eq('resolved', false)
    .eq('metadata->>order_id', order.id)
    .select('id');

  if (!updateError && refreshed && refreshed.length > 0) {
    return;
  }

  // A failed refresh does not prove the signal is absent, so attempt the
  // idempotent insert. The partial unique index makes 23505 positive proof that
  // an unresolved per-order alert already exists. Any other failure is surfaced
  // so the webhook retries and repairs the required operator signal.
  const { error: insertError } = await supabase.from('alerts').insert({
    guild_id: order.guild_id,
    alert_type: UNKNOWN_DELIVERY_CONTRACT_ALERT_TYPE,
    severity: 'critical',
    title: 'Paid order requires manual delivery review',
    message,
    metadata,
  });
  if (insertError && insertError.code !== '23505') {
    const refreshDetail = updateError ? ` (refresh failed: ${updateError.message})` : '';
    throw new Error(
      `Failed to persist delivery-contract alert: ${insertError.message}${refreshDetail}`,
    );
  }
}
