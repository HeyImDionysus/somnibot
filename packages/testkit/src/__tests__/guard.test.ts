import { describe, it, expect } from 'vitest';
import {
  assertLoopbackAllowed,
  isLoopbackAllowed,
  LoopbackGuardError,
  LOOPBACK_E2E_CONFIRMATION,
  type LoopbackEnv,
} from '../guard.js';

// A fully-valid disposable-rig environment. Each test perturbs ONE field to
// prove that field is load-bearing.
function validEnv(): LoopbackEnv {
  return {
    NODE_ENV: 'test',
    SUPABASE_URL: 'http://127.0.0.1:54321',
    DISCORD_GUILD_ID: '111111111111111111',
    SOMNIBOT_E2E_DISPOSABLE_GUILD_ID: '111111111111111111',
    SOMNIBOT_LOOPBACK_E2E_CONFIRMATION: LOOPBACK_E2E_CONFIRMATION,
    PAYPAL_ENV: 'sandbox',
  };
}

describe('assertLoopbackAllowed', () => {
  it('accepts a fully-valid disposable-rig environment', () => {
    expect(() => assertLoopbackAllowed(validEnv())).not.toThrow();
    expect(isLoopbackAllowed(validEnv())).toBe(true);
  });

  it('accepts localhost, ::1, and a valid sandbox with PAYPAL_ENV absent', () => {
    expect(() => assertLoopbackAllowed({ ...validEnv(), SUPABASE_URL: 'http://localhost:54321' })).not.toThrow();
    expect(() => assertLoopbackAllowed({ ...validEnv(), SUPABASE_URL: 'http://[::1]:54321' })).not.toThrow();
    const noPaypal = validEnv();
    delete noPaypal.PAYPAL_ENV;
    expect(() => assertLoopbackAllowed(noPaypal)).not.toThrow();
  });

  const rejections: Array<[string, (e: LoopbackEnv) => void]> = [
    ['NODE_ENV=production', (e) => { e.NODE_ENV = 'production'; }],
    ['missing confirmation', (e) => { delete e.SOMNIBOT_LOOPBACK_E2E_CONFIRMATION; }],
    ['wrong confirmation', (e) => { e.SOMNIBOT_LOOPBACK_E2E_CONFIRMATION = 'nope'; }],
    ['missing SUPABASE_URL', (e) => { delete e.SUPABASE_URL; }],
    ['malformed SUPABASE_URL', (e) => { e.SUPABASE_URL = 'not a url'; }],
    ['remote Supabase host', (e) => { e.SUPABASE_URL = 'https://abcd.supabase.co'; }],
    ['missing DISCORD_GUILD_ID', (e) => { delete e.DISCORD_GUILD_ID; }],
    ['missing disposable guild id', (e) => { delete e.SOMNIBOT_E2E_DISPOSABLE_GUILD_ID; }],
    ['guild id != disposable guild id', (e) => { e.DISCORD_GUILD_ID = '999999999999999999'; }],
    ['PAYPAL_ENV=live', (e) => { e.PAYPAL_ENV = 'live'; }],
  ];

  for (const [label, mutate] of rejections) {
    it(`throws on: ${label}`, () => {
      const env = validEnv();
      mutate(env);
      expect(() => assertLoopbackAllowed(env)).toThrow(LoopbackGuardError);
      expect(isLoopbackAllowed(env)).toBe(false);
    });
  }

  it('defaults to process.env when no env is passed (smoke — should reject in a non-rig test env)', () => {
    // The unit-test process is not a configured loopback rig, so the default
    // path must fail closed rather than accidentally allow.
    expect(isLoopbackAllowed()).toBe(false);
  });
});
