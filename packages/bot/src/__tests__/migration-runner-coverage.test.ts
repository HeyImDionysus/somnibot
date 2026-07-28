import { createHash } from 'node:crypto';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  readdirSync: vi.fn(),
  readFileSync: vi.fn(),
  fetch: vi.fn(),
}));

vi.mock('node:fs', () => ({
  readdirSync: (...args: unknown[]) => mocks.readdirSync(...args),
  readFileSync: (...args: unknown[]) => mocks.readFileSync(...args),
}));

vi.mock('node:path', async () => {
  const actual = await vi.importActual<typeof import('node:path')>('node:path');
  return {
    ...actual,
    join: (...args: string[]) => args.join('/'),
    resolve: (...args: string[]) => args.join('/'),
  };
});

vi.mock('@somnibot/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@somnibot/shared')>()),
  createLogger: () => ({
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
  }),
}));

vi.stubGlobal('fetch', mocks.fetch);

import { runMigrations } from '../services/migration-runner.js';

const APPROVED_MIGRATION =
  '20260727034400_fraud_signal_observation_index.sql';

interface HistoryRow {
  filename: string;
  checksum: string;
  success: boolean;
  applied_at: string;
  duration_ms: number;
}

interface SimulatorOptions {
  bootstrapFailure?: boolean;
  historyFailure?: boolean;
  claimFailureAfterCommit?: boolean;
  sourceFailure?: 'before-commit' | 'after-commit';
}

function canonical(sql: string): string {
  return createHash('sha256')
    .update(sql.replace(/\r\n/g, '\n'), 'utf8')
    .digest('hex');
}

function okJson(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response;
}

function failure(status: number, message: string): Response {
  return {
    ok: false,
    status,
    json: async () => ({}),
    text: async () => message,
  } as Response;
}

function unquote(value: string): string {
  return value.replace(/''/g, "'");
}

function quotedValues(sql: string, expression: RegExp): string[] {
  return [...sql.matchAll(expression)].map((match) => unquote(match[1]));
}

function createManagementSimulator(
  rows: HistoryRow[],
  options: SimulatorOptions = {},
): {
  queries: string[];
  rows: HistoryRow[];
  sourceQueries: () => string[];
} {
  const state = rows;
  const queries: string[] = [];
  const dbNowMs = Date.parse('2026-07-28T12:00:00.000Z');
  const dbNow = () => new Date(dbNowMs).toISOString();

  mocks.fetch.mockImplementation(async (
    input: string | URL | Request,
    init: RequestInit = {},
  ) => {
    const url = String(input);

    if (url.includes('/rest/v1/schema_migrations')) {
      if (options.historyFailure) return failure(503, 'history unavailable');

      const parsed = new URL(url);
      const filenameFilter = parsed.searchParams.get('filename');
      const selected = filenameFilter?.startsWith('eq.')
        ? state.filter((row) => row.filename === filenameFilter.slice(3))
        : [...state].sort((a, b) => a.filename.localeCompare(b.filename));

      if ((init.method ?? 'GET') === 'PATCH') {
        const checksumFilter = parsed.searchParams.get('checksum');
        const successFilter = parsed.searchParams.get('success');
        const body = JSON.parse(String(init.body)) as Partial<HistoryRow>;
        const checksum = checksumFilter?.startsWith('eq.')
          ? checksumFilter.slice(3)
          : undefined;
        const success = successFilter === 'eq.true'
          ? true
          : successFilter === 'eq.false'
            ? false
            : undefined;
        const row = state.find((item) => (
          item.filename === filenameFilter?.slice(3)
          && (checksum === undefined || item.checksum === checksum)
          && (success === undefined || item.success === success)
        ));
        if (row && body.duration_ms !== undefined) {
          row.duration_ms = body.duration_ms;
        }
        if (row && body.checksum !== undefined) {
          row.checksum = body.checksum;
        }
        return okJson(row ? [{ ...row }] : []);
      }
      return okJson(selected.map((row) => ({ ...row })));
    }

    if (!url.includes('/database/query')) {
      throw new Error(`Unexpected fetch: ${url}`);
    }

    const query = JSON.parse(String(init.body)).query as string;
    queries.push(query);

    if (query.includes('CREATE TABLE IF NOT EXISTS public.schema_migrations')) {
      return options.bootstrapFailure
        ? failure(500, 'bootstrap rejected')
        : okJson({});
    }

    const claimToken = query.match(/claim:v1:[a-f0-9]{64}:[0-9a-f-]{36}/i)?.[0];
    const filenameEquals = quotedValues(
      query,
      /filename\s*=\s*'((?:''|[^'])*)'/gi,
    );
    const checksumEquals = quotedValues(
      query,
      /checksum\s*=\s*'((?:''|[^'])*)'/gi,
    );

    if (
      query.includes('INSERT INTO public.schema_migrations')
      && claimToken
    ) {
      const values = quotedValues(query, /'((?:''|[^'])*)'/g);
      const filename = values[0];
      if (filename && !state.some((row) => row.filename === filename)) {
        state.push({
          filename,
          checksum: claimToken,
          success: false,
          applied_at: dbNow(),
          duration_ms: 0,
        });
      }
      return options.claimFailureAfterCommit
        ? failure(504, 'claim response lost after commit')
        : okJson({});
    }

    if (
      query.includes('UPDATE public.schema_migrations')
      && query.includes('SET checksum =')
      && claimToken
      && !query.includes('$migration_runner_history$')
    ) {
      const [newChecksum, expectedChecksum] = checksumEquals;
      const filename = filenameEquals[0];
      const row = state.find((item) => item.filename === filename);
      const staleEnough = !query.includes('applied_at < now()')
        || (
          row?.applied_at
          && dbNowMs - Date.parse(row.applied_at) > 5 * 60 * 1000
        );
      if (
        row
        && !row.success
        && row.checksum === expectedChecksum
        && staleEnough
      ) {
        row.checksum = newChecksum;
        row.applied_at = dbNow();
        row.duration_ms = 0;
      }
      return options.claimFailureAfterCommit
        ? failure(504, 'claim response lost after commit')
        : okJson({});
    }

    if (query.includes('$migration_runner_claim_proof$')) {
      const filename = filenameEquals[0];
      const expectedChecksum = checksumEquals[0];
      const owned = state.some((row) => (
        row.filename === filename
        && row.checksum === expectedChecksum
        && !row.success
      ));
      return owned ? okJson({}) : failure(400, 'claim proof failed');
    }

    if (
      query.includes('UPDATE public.schema_migrations')
      && query.includes('SET applied_at = now()')
      && !query.includes('SET checksum =')
    ) {
      const filename = filenameEquals[0];
      const expectedChecksum = checksumEquals[0];
      const row = state.find((item) => (
        item.filename === filename
        && item.checksum === expectedChecksum
        && !item.success
      ));
      if (row) row.applied_at = dbNow();
      return okJson({});
    }

    const isSource = (
      query.includes('$migration_runner_history$')
      && !query.trimStart().startsWith('DO $migration_runner_claim_proof$')
    );
    if (isSource) {
      if (options.sourceFailure === 'before-commit') {
        return failure(400, 'source failed');
      }

      const filename = filenameEquals.at(-1);
      const [newChecksum, expectedChecksum] = checksumEquals.slice(-2);
      const row = state.find((item) => (
        item.filename === filename
        && item.checksum === expectedChecksum
        && !item.success
      ));
      if (row) {
        row.checksum = newChecksum;
        row.success = true;
        row.applied_at = dbNow();
      }

      return options.sourceFailure === 'after-commit'
        ? failure(502, 'response lost after commit')
        : okJson({});
    }

    if (
      query.includes('UPDATE public.schema_migrations')
      && query.includes('success = false')
      && query.includes('duration_ms =')
    ) {
      const [newChecksum, expectedChecksum] = checksumEquals;
      const filename = filenameEquals[0];
      const row = state.find((item) => (
        item.filename === filename
        && item.checksum === expectedChecksum
        && !item.success
      ));
      if (row) {
        row.checksum = newChecksum;
        row.applied_at = dbNow();
      }
      return okJson({});
    }

    return okJson({});
  });

  return {
    queries,
    rows: state,
    sourceQueries: () => queries.filter((query) => (
      query.includes('$migration_runner_history$')
      && !query.includes('$migration_runner_claim_proof$')
    )),
  };
}

describe('runMigrations claim and execution safety', () => {
  const originalEnv = { ...process.env };
  let approvedSource = '';

  beforeAll(async () => {
    const actualFs = await vi.importActual<typeof import('node:fs')>('node:fs');
    const actualPath = await vi.importActual<typeof import('node:path')>('node:path');
    approvedSource = actualFs.readFileSync(
      actualPath.resolve(
        process.cwd(),
        '../supabase/migrations',
        APPROVED_MIGRATION,
      ),
      'utf8',
    );
  });

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.SUPABASE_URL = 'https://test.supabase.co';
    process.env.SUPABASE_SECRET_KEY = 'secret-key';
    process.env.SUPABASE_ACCESS_TOKEN = 'access-token';
    process.env.MIGRATIONS_DIR = '/migrations';
    delete process.env.SUPABASE_DB_URL;
    delete process.env.DATABASE_URL;
    mocks.readdirSync.mockReturnValue(['001_init.sql']);
    mocks.readFileSync.mockReturnValue('CREATE TABLE runner_probe (id bigint);');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.env = { ...originalEnv };
  });

  it('skips when required Supabase configuration is absent', async () => {
    delete process.env.SUPABASE_URL;
    const result = await runMigrations();
    expect(result.ran).toBe(false);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('claims and completes an ordinary migration in one source query', async () => {
    const simulator = createManagementSimulator([]);

    const result = await runMigrations();

    expect(result.errors).toEqual([]);
    expect(result.applied).toEqual(['001_init.sql']);
    expect(simulator.sourceQueries()).toHaveLength(1);
    expect(simulator.sourceQueries()[0]).toContain('CREATE TABLE runner_probe');
    expect(simulator.sourceQueries()[0]).toContain('UPDATE public.schema_migrations');
    expect(simulator.rows[0]).toMatchObject({
      filename: '001_init.sql',
      checksum: canonical('CREATE TABLE runner_probe (id bigint);'),
      success: true,
    });
    const durationCall = mocks.fetch.mock.calls.find(([input, init]) => (
      String(input).includes('success=eq.true')
      && (init as RequestInit | undefined)?.method === 'PATCH'
    ));
    expect(durationCall).toBeDefined();
    expect(String(durationCall?.[0])).toContain(
      `checksum=eq.${canonical('CREATE TABLE runner_probe (id bigint);')}`,
    );
    expect(JSON.parse(String((durationCall?.[1] as RequestInit).body)))
      .toEqual({ duration_ms: expect.any(Number) });
  });

  it('places the success CAS before the sole outer COMMIT', async () => {
    const source = 'BEGIN;\nCREATE TABLE runner_probe (id bigint);\nCOMMIT;';
    mocks.readFileSync.mockReturnValue(source);
    const simulator = createManagementSimulator([]);

    const result = await runMigrations();

    expect(result.errors).toEqual([]);
    const sourceQuery = simulator.sourceQueries()[0];
    expect(sourceQuery.indexOf('UPDATE public.schema_migrations'))
      .toBeLessThan(sourceQuery.lastIndexOf('COMMIT;'));
  });

  it('requires checksum equality before retrying a failed row', async () => {
    const simulator = createManagementSimulator([{
      filename: '001_init.sql',
      checksum: 'mismatched-failed-checksum',
      success: false,
      applied_at: '2026-07-28T11:00:00.000Z',
      duration_ms: 1,
    }]);

    const result = await runMigrations();

    expect(result.checksumDrift).toEqual(['001_init.sql']);
    expect(result.errors[0]).toMatch(/failed migration history checksum/i);
    expect(simulator.sourceQueries()).toHaveLength(0);
    expect(simulator.queries.filter((query) => query.includes('claim:v1:')))
      .toHaveLength(0);
  });

  it('retries a compatible failed row through an exact claim CAS', async () => {
    const source = 'CREATE TABLE runner_probe (id bigint);';
    const simulator = createManagementSimulator([{
      filename: '001_init.sql',
      checksum: canonical(source),
      success: false,
      applied_at: '2026-07-28T11:00:00.000Z',
      duration_ms: 1,
    }]);

    const result = await runMigrations();

    expect(result.errors).toEqual([]);
    expect(result.applied).toEqual(['001_init.sql']);
    expect(simulator.queries.some((query) => (
      query.includes('UPDATE public.schema_migrations')
      && query.includes(`checksum = '${canonical(source)}'`)
      && query.includes('claim:v1:')
    ))).toBe(true);
  });

  it('rejects unapproved CIC before acquiring a claim or executing source', async () => {
    mocks.readFileSync.mockReturnValue(`
      ALTER DATABASE app SET TABLESPACE fastspace;
      CREATE INDEX CONCURRENTLY idx_probe ON runner_probe (id);
    `);
    const simulator = createManagementSimulator([]);

    const result = await runMigrations();

    expect(result.errors[0]).toMatch(/approved nontransactional migration profile/i);
    expect(simulator.sourceQueries()).toHaveLength(0);
    expect(simulator.queries.filter((query) => query.includes('claim:v1:')))
      .toHaveLength(0);
  });

  it('fails closed when bootstrap is unavailable', async () => {
    const simulator = createManagementSimulator([], { bootstrapFailure: true });

    const result = await runMigrations();

    expect(result.errors[0]).toMatch(/refusing to execute untracked SQL/i);
    expect(simulator.sourceQueries()).toHaveLength(0);
  });

  it('fails closed when history cannot be read', async () => {
    const simulator = createManagementSimulator([], { historyFailure: true });

    const result = await runMigrations();

    expect(result.errors[0]).toMatch(/refusing to execute SQL without durable history/i);
    expect(simulator.sourceQueries()).toHaveLength(0);
  });

  it('lets only one of two concurrent runners execute the migration', async () => {
    const simulator = createManagementSimulator([]);

    const [first, second] = await Promise.all([
      runMigrations(),
      runMigrations(),
    ]);

    expect(simulator.sourceQueries()).toHaveLength(1);
    expect([...first.applied, ...second.applied]).toEqual(['001_init.sql']);
    expect(
      first.errors.some((error) => /claimed by another runner/i.test(error))
      || second.errors.some((error) => /claimed by another runner/i.test(error)),
    ).toBe(true);
  });

  it('executes after an ambiguous claim response only when reread proves ownership', async () => {
    const simulator = createManagementSimulator([], {
      claimFailureAfterCommit: true,
    });

    const result = await runMigrations();

    expect(result.errors).toEqual([]);
    expect(result.applied).toEqual(['001_init.sql']);
    expect(simulator.sourceQueries()).toHaveLength(1);
  });

  it('never downgrades success after an ambiguous source response', async () => {
    const simulator = createManagementSimulator([], {
      sourceFailure: 'after-commit',
    });

    const result = await runMigrations();

    expect(result.errors).toEqual([]);
    expect(result.applied).toEqual(['001_init.sql']);
    expect(simulator.rows[0]).toMatchObject({
      checksum: canonical('CREATE TABLE runner_probe (id bigint);'),
      success: true,
    });
  });

  it('uses database time, not a skewed client clock, for stale takeover', async () => {
    const source = 'CREATE TABLE runner_probe (id bigint);';
    const checksum = canonical(source);
    const otherClaim =
      `claim:v1:${checksum}:00000000-0000-4000-8000-000000000001`;
    const simulator = createManagementSimulator([{
      filename: '001_init.sql',
      checksum: otherClaim,
      success: false,
      applied_at: '2026-07-28T11:59:00.000Z',
      duration_ms: 0,
    }]);
    vi.spyOn(Date, 'now').mockReturnValue(
      Date.parse('2099-01-01T00:00:00.000Z'),
    );

    const result = await runMigrations();

    expect(result.errors[0]).toMatch(/claimed by another runner/i);
    expect(simulator.sourceQueries()).toHaveLength(0);
    expect(simulator.rows[0].checksum).toBe(otherClaim);
    expect(simulator.queries.some((query) => (
      query.includes("applied_at < now() - interval '5 minutes'")
    ))).toBe(true);
  });

  it('executes only the approved DO/CIC/DO profile and finalizes in postflight', async () => {
    mocks.readdirSync.mockReturnValue([APPROVED_MIGRATION]);
    mocks.readFileSync.mockReturnValue(approvedSource);
    const simulator = createManagementSimulator([{
      filename: APPROVED_MIGRATION,
      checksum: canonical(approvedSource),
      success: false,
      applied_at: '2026-07-28T11:00:00.000Z',
      duration_ms: 1,
    }]);

    const result = await runMigrations();

    expect(result.errors).toEqual([]);
    const sourceQueries = simulator.queries.filter((query) => (
      query.includes('DO $fraud_index_recovery$')
      || query.trimStart().startsWith('CREATE INDEX CONCURRENTLY')
      || query.includes('DO $fraud_index_postflight$')
    ));
    expect(sourceQueries).toHaveLength(3);
    expect(sourceQueries[0]).toContain('DO $fraud_index_recovery$');
    expect(sourceQueries[1].trimStart()).toMatch(/^CREATE INDEX CONCURRENTLY/);
    expect(sourceQueries[2]).toContain('DO $fraud_index_postflight$');
    expect(sourceQueries[2]).toContain('$migration_runner_history$');
  });
});
