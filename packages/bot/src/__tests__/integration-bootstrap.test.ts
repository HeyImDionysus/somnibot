import { createHmac } from 'node:crypto';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assertLoopbackUrl,
  buildSupabaseTestEnvironment,
  buildSupabaseCliInvocation,
  createAuthenticatedJwt,
  parseSupabaseStatusEnv,
} from './integration/supabase-bootstrap.js';

describe('local Supabase integration bootstrap', () => {
  const status = {
    API_URL: 'http://127.0.0.1:54321',
    DB_URL: 'postgresql://postgres:postgres@127.0.0.1:54322/postgres',
    ANON_KEY: 'anon-key',
    SECRET_KEY: 'secret-key',
    SERVICE_ROLE_KEY: 'legacy-service-key',
    JWT_SECRET: 'jwt-secret',
  } as const;

  it('parses quoted status output without exposing values', () => {
    expect(parseSupabaseStatusEnv('API_URL="http://127.0.0.1:54321"\nANON_KEY="abc"\nnoise')).toEqual({
      API_URL: 'http://127.0.0.1:54321',
      ANON_KEY: 'abc',
    });
  });

  it('invokes the repository CLI through Node without a shell shim', () => {
    const invocation = buildSupabaseCliInvocation('C:/repo', 'C:/repo/packages');
    expect(invocation.command).toBe(process.execPath);
    expect(invocation.args).toEqual([
      resolve('C:/repo', 'node_modules', 'supabase', 'dist', 'supabase.js'),
      'status',
      '--workdir',
      'C:/repo/packages',
      '--output',
      'env',
    ]);
  });

  it('rejects remote Supabase URLs', () => {
    expect(() => assertLoopbackUrl('https://example.supabase.co', 'API_URL')).toThrow(/non-loopback/);
  });

  it('creates an authenticated HS256 token that verifies with the current secret', () => {
    const token = createAuthenticatedJwt(status.JWT_SECRET, 1_700_000_000);
    const [header, payload, signature] = token.split('.');
    const expected = createHmac('sha256', status.JWT_SECRET).update(`${header}.${payload}`).digest('base64url');
    expect(signature).toBe(expected);
    expect(JSON.parse(Buffer.from(payload, 'base64url').toString())).toMatchObject({ role: 'authenticated', exp: 1_700_000_300 });
  });

  it('maps CLI credentials to canonical and legacy environment names', () => {
    const env = buildSupabaseTestEnvironment(status, 1_700_000_000);
    expect(env).toMatchObject({
      SUPABASE_URL: status.API_URL,
      SUPABASE_DB_URL: status.DB_URL,
      SUPABASE_ANON_KEY: status.ANON_KEY,
      SUPABASE_SECRET_KEY: status.SECRET_KEY,
      SUPABASE_SERVICE_ROLE_KEY: status.SECRET_KEY,
    });
    expect(env.SUPABASE_AUTHENTICATED_JWT).toBeTruthy();
  });

  it('falls back to the legacy service-role status key when SECRET_KEY is absent', () => {
    const env = buildSupabaseTestEnvironment({ ...status, SECRET_KEY: undefined }, 1_700_000_000);
    expect(env.SUPABASE_SECRET_KEY).toBe(status.SERVICE_ROLE_KEY);
  });
});
