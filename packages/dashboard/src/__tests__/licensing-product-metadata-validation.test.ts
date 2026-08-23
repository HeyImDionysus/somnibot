import { describe, expect, it } from 'vitest';
import { schemas } from '@/lib/api/validation';

const baseProduct = {
  name: 'Licensed project',
  description: 'Customer-facing description.',
  type: 'subscription' as const,
  delivery_type: 'license_key' as const,
  price_cents: 1000,
  currency: 'USD',
  granted_role_ids: [],
  granted_channel_ids: [],
  active: false,
};

describe('completed-project licensing product metadata', () => {
  it('accepts private context and structured capability grants separately from public copy', () => {
    const parsed = schemas.product.create.parse({
      ...baseProduct,
      metadata: {
        completed_project_licensing: {
          privateIntegrationContext: 'Private architecture notes.',
          capabilities: [{
            key: 'exports',
            name: 'Data exports',
            behavioralMeaning: 'Allows customer-owned data exports.',
            controlledFunctionality: 'CSV and JSON export actions.',
            grantingPlans: [{ key: 'pro', name: 'Pro' }],
            unavailableBehavior: 'Existing data remains readable; new exports are refused.',
            dependencyKeys: [],
          }],
        },
      },
    });

    expect(parsed.description).toBe('Customer-facing description.');
    expect(parsed.metadata?.completed_project_licensing).toMatchObject({
      privateIntegrationContext: 'Private architecture notes.',
      capabilities: [{ key: 'exports', grantingPlans: [{ key: 'pro', name: 'Pro' }] }],
    });
  });

  it('accepts a client-generated stable subscription plan id', () => {
    const planId = '00000000-0000-4000-8000-000000000434';
    const parsed = schemas.product.create.parse({
      ...baseProduct,
      plans: [{ id: planId, name: 'Pro' }],
    });
    expect(parsed.plans?.[0]?.id).toBe(planId);
  });

  it('rejects malformed or duplicate stable capability keys', () => {
    const capability = {
      key: 'not a stable key',
      name: 'Exports',
      behavioralMeaning: 'Meaning',
      controlledFunctionality: 'Functionality',
      grantingPlans: [],
      unavailableBehavior: 'Unavailable behavior',
      dependencyKeys: [],
    };
    expect(schemas.product.create.safeParse({
      ...baseProduct,
      metadata: { completed_project_licensing: { capabilities: [capability] } },
    }).success).toBe(false);

    expect(schemas.product.create.safeParse({
      ...baseProduct,
      metadata: {
        completed_project_licensing: {
          capabilities: [
            { ...capability, key: 'exports' },
            { ...capability, key: 'exports' },
          ],
        },
      },
    }).success).toBe(false);
  });
});
