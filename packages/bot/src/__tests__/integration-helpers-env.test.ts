import { describe, expect, it } from 'vitest';
import { resolveTestSupabaseKey } from './integration/helpers.js';

describe('integration Supabase environment contract', () => {
  it('uses the canonical launcher secret-key name', () => {
    expect(resolveTestSupabaseKey({ SUPABASE_SECRET_KEY: 'canonical' })).toBe('canonical');
  });

  it('accepts the legacy CI service-role alias', () => {
    expect(resolveTestSupabaseKey({ SUPABASE_SERVICE_ROLE_KEY: 'legacy' })).toBe('legacy');
  });

  it('prefers the canonical key when both names are present', () => {
    expect(
      resolveTestSupabaseKey({
        SUPABASE_SECRET_KEY: 'canonical',
        SUPABASE_SERVICE_ROLE_KEY: 'legacy',
      }),
    ).toBe('canonical');
  });
});
