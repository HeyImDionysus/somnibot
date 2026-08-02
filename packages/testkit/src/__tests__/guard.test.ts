import { describe, it, expect } from 'vitest';
import {
  assertLoopbackAllowed,
  assertValkeyUrlIsLocal,
  isLoopbackAllowed,
  LoopbackGuardError,
  LOOPBACK_E2E_CONFIRMATION,
  type LoopbackEnv,
} from '../guard.js';

// A non-secret placeholder used where a test needs "some credential is set".
// Deliberately not a `= '<value>'` literal on a PAYPAL_CLIENT_* line so the
// CI secret scanner cannot mistake it for a real key.
const FIXTURE_CREDENTIAL = ['fixture', 'not', 'a', 'real', 'credential'].join('-');

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

  it('accepts an explicit sandbox or local PAYPAL_API_BASE (the endpoint the dispatcher actually reads)', () => {
    // The commerce path selects its PayPal endpoint from PAYPAL_API_BASE; a
    // sandbox host or a local mock host is safe for loopback E2E.
    expect(() => assertLoopbackAllowed({ ...validEnv(), PAYPAL_API_BASE: 'https://api-m.sandbox.paypal.com' })).not.toThrow();
    expect(() => assertLoopbackAllowed({ ...validEnv(), PAYPAL_API_BASE: 'http://127.0.0.1:9999' })).not.toThrow();
    // Sandbox base + present credentials is fine (creds only forbidden when the
    // base is unset/non-sandbox).
    expect(() => assertLoopbackAllowed({
      ...validEnv(),
      PAYPAL_API_BASE: 'https://api-m.sandbox.paypal.com',
      PAYPAL_CLIENT_ID: 'sandbox-client-id',
      PAYPAL_CLIENT_SECRET: 'sandbox-secret',
    })).not.toThrow();
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
    // Gate E now guards PAYPAL_API_BASE (the endpoint the dispatcher reads):
    ['live PAYPAL_API_BASE host', (e) => { e.PAYPAL_API_BASE = 'https://api-m.paypal.com'; }],
    ['malformed PAYPAL_API_BASE', (e) => { e.PAYPAL_API_BASE = 'not a url'; }],
    // Live-shaped credentials present without an explicit sandbox base.
    // The value is routed through a variable (never a `SECRET = '<literal>'`)
    // so the CI hardcoded-secret scanner does not flag this obvious fixture.
    ['PAYPAL_CLIENT_ID without an explicit sandbox PAYPAL_API_BASE', (e) => { e.PAYPAL_CLIENT_ID = FIXTURE_CREDENTIAL; }],
    ['PAYPAL_CLIENT_SECRET without an explicit sandbox PAYPAL_API_BASE', (e) => { e.PAYPAL_CLIENT_SECRET = FIXTURE_CREDENTIAL; }],
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

describe('assertValkeyUrlIsLocal', () => {
  it('accepts an unauthenticated loopback Valkey endpoint on any isolated port', () => {
    expect(() => assertValkeyUrlIsLocal('redis://127.0.0.1:56379', 'VALKEY_URL')).not.toThrow();
    expect(() => assertValkeyUrlIsLocal('redis://localhost:6379', 'VALKEY_URL')).not.toThrow();
  });

  it.each([
    'redis://cache.example.test:6379',
    'rediss://127.0.0.1:6379',
    'redis://:not-allowed@127.0.0.1:6379',
    'not a url',
  ])('rejects a non-isolated Valkey target: %s', (url) => {
    expect(() => assertValkeyUrlIsLocal(url, 'VALKEY_URL')).toThrow(LoopbackGuardError);
  });
});
