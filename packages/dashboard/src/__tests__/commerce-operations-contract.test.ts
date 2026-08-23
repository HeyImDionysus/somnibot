import { describe, expect, it } from 'vitest';
import {
  buildEntitlementGraph,
  evaluateLaunchRun,
  merchantRowsToCsv,
  riskCasePolicy,
  transitionRiskCase,
} from '@/lib/store/commerce-operations';

describe('commerce operation contracts', () => {
  it('keeps a tutorial product inactive until every sandbox and reversal stage has evidence', () => {
    const result = evaluateLaunchRun({
      productActive: false,
      environment: 'sandbox',
      stages: {
        product: 'verified',
        policy: 'verified',
        pricing: 'verified',
        integration: 'verified',
        sandbox_transaction: 'verified',
        webhook: 'verified',
        entitlement: 'verified',
        fulfillment: 'verified',
        reversal: 'verified',
      },
      receiptHash: 'a'.repeat(64),
    });

    expect(result).toEqual({ state: 'ready', missing: [] });
  });

  it('blocks activation when reversal evidence is missing or the product is already live', () => {
    const stages = {
      product: 'verified',
      policy: 'verified',
      pricing: 'verified',
      integration: 'verified',
      sandbox_transaction: 'verified',
      webhook: 'verified',
      entitlement: 'verified',
      fulfillment: 'verified',
      reversal: 'pending',
    } as const;

    expect(evaluateLaunchRun({
      productActive: true,
      environment: 'live',
      stages,
      receiptHash: null,
    })).toEqual({
      state: 'blocked',
      missing: ['product_inactive', 'sandbox_environment', 'reversal', 'launch_receipt'],
    });
  });

  it('builds a current-versus-intended entitlement graph and previews downstream revocation', () => {
    const graph = buildEntitlementGraph({
      order: { id: 'order-1', customerId: 'customer-1', status: 'completed', productId: 'product-1', planId: 'plan-1' },
      payment: { id: 'payment-1', status: 'completed' },
      entitlement: { id: 'entitlement-1', status: 'active' },
      capabilities: [{ key: 'exports', name: 'Exports', granted: true }],
      access: [
        { id: 'role-1', kind: 'discord_role', label: 'Customer', state: 'active' },
        { id: 'download-1', kind: 'download', label: 'Desktop build', state: 'active' },
      ],
      operationHistory: [{ operationId: 'op-1', action: 'fulfillment', state: 'complete' }],
      previewAction: 'refund',
      productRevision: 'product-r3',
      policyRevision: 'policy-r7',
    });

    expect(graph.nodes.map((node) => node.kind)).toEqual([
      'customer', 'order', 'payment', 'product', 'plan', 'entitlement', 'capability', 'discord_role', 'download',
    ]);
    expect(graph.preview).toEqual({
      action: 'refund',
      affectedNodeIds: ['entitlement-1', 'capability:exports', 'role-1', 'download-1'],
      irreversible: ['payment-1'],
    });
    expect(graph.revisions).toEqual({ product: 'product-r3', policy: 'policy-r7' });
  });

  it('exports stable CSV columns and preserves payment and entitlement states separately', () => {
    const csv = merchantRowsToCsv(
      ['order_id', 'payment_state', 'entitlement_state'],
      [
        { order_id: 'b', payment_state: 'refunded', entitlement_state: 'revoked' },
        { order_id: 'a', payment_state: 'completed', entitlement_state: 'active' },
      ],
      'order_id',
    );

    expect(csv).toBe(
      'order_id,payment_state,entitlement_state\r\n'
      + 'a,completed,active\r\n'
      + 'b,refunded,revoked\r\n',
    );
  });

  it('enforces the formal risk workflow without collapsing disputes into refunds', () => {
    expect(transitionRiskCase('suspected_fraud', 'confirm_fraud')).toBe('confirmed_fraud');
    expect(transitionRiskCase('payment_dispute', 'record_chargeback')).toBe('chargeback');
    expect(transitionRiskCase('ordinary_refund', 'record_chargeback')).toBeNull();
    expect(riskCasePolicy('chargeback')).toEqual({ fulfillmentAction: 'revoke', entitlementAction: 'revoke' });
    expect(riskCasePolicy('duplicate_payment')).toEqual({ fulfillmentAction: 'hold', entitlementAction: 'continue' });
  });
});
