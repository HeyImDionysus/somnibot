import { describe, expect, it } from 'vitest';
import { deriveFeatureReadiness, featureForPath } from '@/lib/dashboard/feature-status';

describe('feature status', () => {
  it('maps nested pages to their owning runtime', () => {
    expect(featureForPath('/economy/trivia')).toEqual({
      label: 'Trivia',
      configKey: 'economy_trivia_enabled',
      requiredConfigKeys: ['economy_enabled'],
    });
  });

  it('does not claim a child feature can run while the economy is disabled', () => {
    expect(deriveFeatureReadiness({
      feature: featureForPath('/economy/trivia')!,
      config: { economy_enabled: false, economy_trivia_enabled: true },
      botOnline: true,
      staleSecs: 10,
    })).toMatchObject({
      state: 'disabled',
      detail: 'Its parent system is disabled, so this feature cannot run even though its own settings are saved.',
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
