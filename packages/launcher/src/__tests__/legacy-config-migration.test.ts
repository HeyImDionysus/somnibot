import { describe, expect, it } from 'vitest';
import { selectMissingLegacyConfig } from '../main/legacy-config-migration.js';

describe('selectMissingLegacyConfig', () => {
  it('restores missing connection and provider fields without exposing extra keys', () => {
    const patch = selectMissingLegacyConfig(
      {
        supabaseUrl: 'https://current.supabase.co',
        supabaseSecretKey: 'current-secret',
        paypalClientId: '',
        paypalClientSecret: '',
      },
      {
        supabaseUrl: 'https://legacy.supabase.co',
        supabaseSecretKey: 'legacy-secret',
        paypalClientId: 'legacy-client-id',
        paypalClientSecret: 'legacy-client-secret',
        unknownSecret: 'must-not-migrate',
      },
    );

    expect(patch).toEqual({
      paypalClientId: 'legacy-client-id',
      paypalClientSecret: 'legacy-client-secret',
    });
    expect(patch).not.toHaveProperty('unknownSecret');
  });

  it('preserves current values and ignores blank legacy values', () => {
    const patch = selectMissingLegacyConfig(
      { discordToken: 'current-token', supabaseUrl: '' },
      { discordToken: 'legacy-token', supabaseUrl: '  ' },
    );

    expect(patch).toEqual({});
  });

  it('can restore non-string state only when the current store has no value', () => {
    const patch = selectMissingLegacyConfig(
      { firstRunComplete: undefined, windowBounds: undefined },
      { firstRunComplete: true, windowBounds: { width: 800, height: 600 } },
    );

    expect(patch).toEqual({
      firstRunComplete: true,
      windowBounds: { width: 800, height: 600 },
    });
  });

  it('rejects malformed legacy state instead of writing it into the current store', () => {
    const patch = selectMissingLegacyConfig(
      { windowBounds: undefined, lastPids: undefined, paypalSandbox: undefined },
      {
        windowBounds: { width: 'wide', height: 600 },
        lastPids: { bot: -1, dashboard: null, lavalink: null, valkey: null },
        paypalSandbox: 'false',
      },
    );

    expect(patch).toEqual({});
  });
});
