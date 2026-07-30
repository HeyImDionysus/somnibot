import { describe, expect, it } from 'vitest';
import { deriveFeatureReadiness, featureForPath } from '@/lib/dashboard/feature-status';

describe('feature status', () => {
  it('maps nested pages to their owning runtime', () => {
    expect(featureForPath('/economy/trivia')).toEqual({
      label: 'Economy',
      configKey: 'economy_enabled',
    });
  });

  it('reports disabled before considering a healthy bot', () => {
    expect(deriveFeatureReadiness({
      feature: { label: 'Music', configKey: 'music_enabled' },
      config: { music_enabled: false },
      botOnline: true,
      staleSecs: 10,
    }).state).toBe('disabled');
  });

  it('does not call a feature operational when the bot is offline', () => {
    expect(deriveFeatureReadiness({
      feature: { label: 'Tickets', configKey: null },
      config: {},
      botOnline: false,
      staleSecs: 240,
    })).toMatchObject({ state: 'blocked', heading: 'Tickets: cannot run' });
  });

  it('states the limited evidence when readiness is operational', () => {
    const result = deriveFeatureReadiness({
      feature: { label: 'Store', configKey: 'store_enabled' },
      config: { store_enabled: true },
      botOnline: true,
      staleSecs: 20,
    });
    expect(result.state).toBe('operational');
    expect(result.detail).toContain('does not claim a member action');
  });
});
