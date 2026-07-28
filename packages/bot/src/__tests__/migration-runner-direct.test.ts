import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  readdirSync: vi.fn(),
  readFileSync: vi.fn(),
  unsafe: vi.fn(),
  end: vi.fn(),
  postgres: vi.fn(),
  fetch: vi.fn(),
}));

vi.mock('node:fs', () => ({
  readdirSync: (...args: unknown[]) => mocks.readdirSync(...args),
  readFileSync: (...args: unknown[]) => mocks.readFileSync(...args),
}));

vi.mock('postgres', () => ({
  default: (...args: unknown[]) => mocks.postgres(...args),
}));

vi.mock('@somnibot/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@somnibot/shared')>()),
  createLogger: () => ({
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
  }),
}));

vi.stubGlobal('fetch', mocks.fetch);

import { runMigrations } from '../services/migration-runner.js';

describe('migration runner direct-Postgres batching', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.postgres.mockReturnValue({
      unsafe: mocks.unsafe,
      end: mocks.end,
    });
    mocks.unsafe.mockResolvedValue(undefined);
    mocks.end.mockResolvedValue(undefined);
    mocks.readdirSync.mockReturnValue(['001_concurrent_index.sql']);
    mocks.readFileSync.mockReturnValue(`
      DO $pre$ BEGIN PERFORM 'before;still-before'; END $pre$;
      CREATE INDEX CONCURRENTLY idx_example ON example (id);
      DO $post$ BEGIN PERFORM 'after;still-after'; END $post$;
    `);
    mocks.fetch
      .mockResolvedValueOnce({ ok: true, json: async () => [] })
      .mockResolvedValueOnce({ ok: true });

    process.env.SUPABASE_URL = 'https://runner-proof.invalid';
    process.env.SUPABASE_SECRET_KEY = 'test-key';
    process.env.SUPABASE_DB_URL = 'postgresql://localhost/test';
    process.env.MIGRATIONS_DIR = process.cwd();
    delete process.env.SUPABASE_ACCESS_TOKEN;
    delete process.env.DATABASE_URL;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('executes ordinary/CIC/ordinary batches sequentially on one direct client', async () => {
    const result = await runMigrations();

    expect(result.errors).toEqual([]);
    expect(result.applied).toEqual(['001_concurrent_index.sql']);

    const migrationQueries = mocks.unsafe.mock.calls
      .slice(1)
      .map(([query]) => query as string);
    expect(migrationQueries).toHaveLength(3);
    expect(migrationQueries[0]).toContain('DO $pre$');
    expect(migrationQueries[0]).not.toContain('CREATE INDEX CONCURRENTLY');
    expect(migrationQueries[1].trimStart()).toMatch(/^CREATE INDEX CONCURRENTLY/);
    expect(migrationQueries[2]).toContain('DO $post$');
    expect(mocks.postgres).toHaveBeenCalledTimes(2);
    expect(mocks.postgres).toHaveBeenNthCalledWith(
      2,
      'postgresql://localhost/test',
      { max: 1 },
    );
    expect(mocks.end).toHaveBeenCalledTimes(2);
  });

  it('stops before the postflight and records failure when the CIC batch fails', async () => {
    mocks.unsafe
      .mockResolvedValueOnce(undefined) // tracking bootstrap
      .mockResolvedValueOnce(undefined) // preflight
      .mockRejectedValueOnce(new Error('concurrent build failed'));

    const result = await runMigrations();

    expect(result.applied).toEqual([]);
    expect(result.errors).toEqual([
      expect.stringContaining('concurrent build failed'),
    ]);
    expect(mocks.unsafe).toHaveBeenCalledTimes(3);

    const [, historyRequest] = mocks.fetch.mock.calls[1] as [string, RequestInit];
    expect(JSON.parse(String(historyRequest.body))).toMatchObject({
      filename: '001_concurrent_index.sql',
      success: false,
    });
    expect(mocks.end).toHaveBeenCalledTimes(2);
  });
});
