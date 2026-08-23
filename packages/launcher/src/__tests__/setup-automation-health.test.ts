import { describe, expect, it } from 'vitest';
import { evaluateDashboardHealthPayload } from '../main/setup-automation-health';

describe('setup automation dashboard health evaluation', () => {
  it('accepts only healthy dashboard health payloads', () => {
    expect(evaluateDashboardHealthPayload({
      status: 'healthy',
      services: { bot: 'online', valkey: 'connected' },
    })).toEqual({
      ok: true,
      status: 'healthy',
      services: { bot: 'online', valkey: 'connected' },
    });
  });

  it('consumes the shared runtime identity published by dashboard health', () => {
    const runtimeIdentity = {
      lifecycle: 'ready',
      version: '1.2.3',
      exactSha: 'a'.repeat(40),
      bootId: '11111111-1111-4111-8111-111111111111',
      migrationHead: '20260823173000_experience_runtime_controls.sql',
      configurationGeneration: 20260823173000,
      deploymentProfile: 'higher-load-vps',
    };

    expect(evaluateDashboardHealthPayload({
      status: 'healthy',
      services: { bot: 'online' },
      runtimeIdentity,
    })).toEqual({
      ok: true,
      status: 'healthy',
      services: { bot: 'online' },
      runtimeIdentity,
    });
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
