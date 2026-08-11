import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  new URL(
    '../../../supabase/migrations/20260810190000_durable_onboarding_fallback_intents.sql',
    import.meta.url,
  ),
  'utf8',
);

describe('durable onboarding fallback rollback compatibility', () => {
  it('keeps the previous release RPC private and callable during application rollback', () => {
    const legacySignature =
      'public.grant_onboarding_fallback_atomic(TEXT, TEXT, INTEGER, TEXT)';

    expect(migration).toMatch(
      new RegExp(
        `REVOKE ALL ON FUNCTION ${legacySignature.replace(/[().]/g, '\\$&')} FROM PUBLIC, anon, authenticated`,
        'i',
      ),
    );
    expect(migration).toMatch(
      new RegExp(
        `GRANT EXECUTE ON FUNCTION ${legacySignature.replace(/[().]/g, '\\$&')} TO service_role`,
        'i',
      ),
    );
    expect(migration).not.toMatch(
      new RegExp(
        `DROP FUNCTION ${legacySignature.replace(/[().]/g, '\\$&')}`,
        'i',
      ),
    );
  });
});
