import { describe, expect, it } from 'vitest';
import { evaluateDashboardHealthPayload } from '../main/setup-automation-health';

describe('setup automation dashboard health evaluation', () => {
  it('accepts only healthy dashboard health payloads', () => {
    expect(evaluateDashboardHealthPayload({ status: 'healthy' })).toEqual({ ok: true });
  });

  it('rejects degraded health payloads with service details', () => {
    const result = evaluateDashboardHealthPayload({
      status: 'degraded',
      services: {
        bot: 'offline',
        valkey: 'fallback',
      },
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain('Dashboard health is degraded');
    expect(result.error).toContain('bot=offline');
    expect(result.error).toContain('valkey=fallback');
  });

  it('rejects missing JSON health payloads', () => {
    const result = evaluateDashboardHealthPayload(null);

    expect(result.ok).toBe(false);
    expect(result.error).toContain('without a healthy JSON payload');
  });
});
