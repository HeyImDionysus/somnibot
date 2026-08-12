import { describe, expect, it } from 'vitest';
import { applyPayPalPolicyEnvironment } from '@/lib/paypal-policy';

describe('applyPayPalPolicyEnvironment', () => {
  const config = {
    apiBase: 'https://override.invalid',
    sandbox: true,
    clientId: 'id',
    clientSecret: 'secret',
  };

  it('uses the sandbox host for the default policy', () => {
    expect(applyPayPalPolicyEnvironment(config, undefined)).toMatchObject({
      apiBase: 'https://api-m.sandbox.paypal.com',
      sandbox: true,
    });
  });

  it('uses live only when the guild policy explicitly selects live', () => {
    expect(applyPayPalPolicyEnvironment({ ...config, sandbox: false }, 'live')).toMatchObject({
      apiBase: 'https://api-m.paypal.com',
      sandbox: false,
    });
  });

  it('never sends sandbox-marked credentials to the live host', () => {
    expect(applyPayPalPolicyEnvironment(config, 'live')).toMatchObject({
      apiBase: 'https://api-m.sandbox.paypal.com',
      sandbox: true,
    });
  });

  it('treats invalid policy values as sandbox', () => {
    expect(applyPayPalPolicyEnvironment(config, 'production')).toMatchObject({
      apiBase: 'https://api-m.sandbox.paypal.com',
      sandbox: true,
    });
  });
});
