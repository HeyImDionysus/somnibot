/**
 * Tests for services/migration-runner.ts — runs SQL migrations with tracking.
 * 213 uncovered statements at 4.5% coverage.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@somnibot/shared', () => ({
  createLogger: () => ({
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
  }),
}));

// We test runMigrations which reads env vars and does fetch/fs
import { runMigrations } from '../services/migration-runner.js';

describe('migration-runner', () => {
  const origEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...origEnv };
  });

  it('skips when SUPABASE_URL is not set', async () => {
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SECRET_KEY;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;

    const result = await runMigrations();
    expect(result.ran).toBe(false);
    expect(result.applied).toEqual([]);
    expect(result.skipped).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  it('skips when SUPABASE_SECRET_KEY is not set', async () => {
    process.env.SUPABASE_URL = 'https://test.supabase.co';
    delete process.env.SUPABASE_SECRET_KEY;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;

    const result = await runMigrations();
    expect(result.ran).toBe(false);
  });
});
