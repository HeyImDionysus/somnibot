import { describe, expect, it } from 'vitest';
import { fraudRuleConfigError } from '@/lib/fraud-rule-config';

describe('fraud rule configuration', () => {
  it.each([
    ['device_limit', { threshold: 3 }],
    ['failed_payment', { threshold: 4 }],
    ['ip_mismatch', { threshold: 6 }],
    ['critical_incident', { threshold: 2 }],
    ['velocity_limit', { threshold: 5, window_minutes: 60 }],
  ])('accepts the live %s detector shape', (type, config) => {
    expect(fraudRuleConfigError(type, config)).toBeNull();
  });

  it('rejects a device threshold that would disable useful detection', () => {
    expect(fraudRuleConfigError('device_limit', { threshold: 1 })).toContain('between');
  });

  it('rejects a velocity rule with ambiguous windows', () => {
    expect(fraudRuleConfigError('velocity_limit', {
      threshold: 5,
      window_minutes: 60,
      window_ms: 3_600_000,
    })).toContain('exactly one');
  });
});
