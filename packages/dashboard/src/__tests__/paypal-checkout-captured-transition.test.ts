import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/supabase/admin', () => ({ createAdminSupabase: vi.fn() }));
vi.mock('@/lib/paypal', () => ({
  getPayPalRuntimeConfig: vi.fn(),
  getPayPalToken: vi.fn(),
  getSubscriptionAmount: vi.fn(),
}));
vi.mock('@/lib/paypal-policy', () => ({
  applyPayPalPolicyEnvironment: (config: Record<string, unknown>) => config,
  loadPayPalPolicy: vi.fn(),
}));

import { markCheckoutIntentCaptured } from '@/app/api/paypal/webhook/handlers';

const CHECKOUT_TOKEN = 'checkout-token-1';
const GUILD_ID = 'guild-1';
const EVENT_ID = 'evt-1';

type TransitionResult = {
  data: Record<string, unknown> | null;
  error: { message: string; code?: string } | null;
};

function incidentRow(input: {
  eventType: 'PAYMENT.CAPTURE.COMPLETED' | 'BILLING.SUBSCRIPTION.ACTIVATED';
  resourceId: string;
  parentId: string | null;
}) {
  return {
    disposition: 'created',
    incident_id: 'incident-1',
    webhook_event_id: EVENT_ID,
    provider_event_type: input.eventType,
    provider_resource_id: input.resourceId,
    provider_parent_id: input.parentId,
    observed_guild_id: GUILD_ID,
    incident_reason: 'checkout_identity_missing_or_mismatched',
    fulfillment_allowed: false,
    routable_guild_id: null,
    alert_id: null,
  };
}

function makeSupabase(transition: TransitionResult) {
  const updateChain = {
    update: vi.fn(() => updateChain),
    eq: vi.fn(() => updateChain),
    in: vi.fn(() => updateChain),
    select: vi.fn(() => updateChain),
    maybeSingle: vi.fn(async () => transition),
  };
  const recoveryInsert = vi.fn(async () => ({ error: null }));
  const rpc = vi.fn(async (_name: string, args: Record<string, unknown>) => ({
    data: incidentRow({
      eventType: args.p_provider_event_type as 'PAYMENT.CAPTURE.COMPLETED' | 'BILLING.SUBSCRIPTION.ACTIVATED',
      resourceId: String(args.p_provider_resource_id),
      parentId: (args.p_provider_parent_id as string | null) ?? null,
    }),
    error: null,
  }));
  return {
    from: vi.fn((table: string) => table === 'commerce_checkout_intents'
      ? updateChain
      : { insert: recoveryInsert }),
    rpc,
    updateChain,
    recoveryInsert,
  } as const;
}

function input(overrides: Partial<Parameters<typeof markCheckoutIntentCaptured>[1]> = {}) {
  return {
    checkoutToken: CHECKOUT_TOKEN,
    providerResourceId: 'capture-1',
    providerParentId: 'order-1',
    guildId: GUILD_ID,
    eventType: 'PAYMENT.CAPTURE.COMPLETED' as const,
    webhookEventId: EVENT_ID,
    ...overrides,
  };
}

describe('markCheckoutIntentCaptured', () => {
  it('requires a durable captured row and accepts the replay state', async () => {
    const supabase = makeSupabase({
      data: { token: CHECKOUT_TOKEN, status: 'captured', provider_id: 'order-1' },
      error: null,
    });

    await expect(markCheckoutIntentCaptured(supabase as never, input())).resolves.toBeUndefined();
    expect(supabase.rpc).not.toHaveBeenCalled();
    expect(supabase.updateChain.in).toHaveBeenCalledWith('status', ['bound', 'captured']);
  });

  it('records an incident and rejects when the update returns zero rows', async () => {
    const supabase = makeSupabase({ data: null, error: null });

    await expect(markCheckoutIntentCaptured(supabase as never, input())).rejects.toThrow(
      'no durable captured row',
    );
    expect(supabase.rpc).toHaveBeenCalledWith(
      'commerce_record_provider_incident',
      expect.objectContaining({
        p_webhook_event_id: EVENT_ID,
        p_incident_reason: 'checkout_identity_missing_or_mismatched',
      }),
    );
    expect(supabase.recoveryInsert).toHaveBeenCalledTimes(1);
  });

  it('records an incident and rejects on a transition error so the webhook can retry', async () => {
    const supabase = makeSupabase({
      data: null,
      error: { message: 'database unavailable' },
    });

    await expect(markCheckoutIntentCaptured(supabase as never, input())).rejects.toThrow(
      'database unavailable',
    );
    expect(supabase.rpc).toHaveBeenCalledTimes(1);
    expect(supabase.recoveryInsert).toHaveBeenCalledTimes(1);
  });

  it('supports the subscription activation identity without a parent order id', async () => {
    const supabase = makeSupabase({
      data: { token: CHECKOUT_TOKEN, status: 'captured', provider_id: 'subscription-1' },
      error: null,
    });

    await expect(markCheckoutIntentCaptured(supabase as never, input({
      providerResourceId: 'subscription-1',
      providerParentId: undefined,
      eventType: 'BILLING.SUBSCRIPTION.ACTIVATED',
    }))).resolves.toBeUndefined();
    expect(supabase.rpc).not.toHaveBeenCalled();
  });
});
