import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
  targetProbeWriteFailureAfterCommit?: boolean;
  targetProbeReadFailure?: boolean;
  targetProbeCleanupFailure?: boolean;
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
  let targetProbeReadFailuresRemaining =
    options.targetProbeReadFailure ? 1 : 0;

  mocks.fetch.mockImplementation(async (
    input: string | URL | Request,
    init: RequestInit = {},
  ) => {
    const url = String(input);

    if (url.includes('/rest/v1/schema_migrations')) {
      const parsed = new URL(url);
      const filenameFilter = parsed.searchParams.get('filename');
      const requestedFilename = filenameFilter?.startsWith('eq.')
        ? filenameFilter.slice(3)
        : undefined;
      const isTargetProbeRead = requestedFilename?.startsWith(
        '__somnibot_migration_target_probe_v1__:',
      ) ?? false;
      if (isTargetProbeRead && targetProbeReadFailuresRemaining > 0) {
        targetProbeReadFailuresRemaining -= 1;
        throw new Error('target probe REST response lost');
      }
      if (options.historyFailure && !isTargetProbeRead) {
        return failure(503, 'history unavailable');
      }
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
    const targetProbeFilename = query.match(
      /__somnibot_migration_target_probe_v1__:[0-9a-f-]{36}/i,
    )?.[0];
    const targetProbeChecksum = query.match(
      /target-binding-probe:v1:[0-9a-f-]{36}/i,
    )?.[0];
    const filenameEquals = quotedValues(
      query,
      /filename\s*=\s*'((?:''|[^'])*)'/gi,
    );
    const checksumEquals = quotedValues(
      query,
      /checksum\s*=\s*'((?:''|[^'])*)'/gi,
    );

    if (
      query.includes('$migration_runner_target_probe_write$')
      && targetProbeFilename
      && targetProbeChecksum
    ) {
      for (let index = state.length - 1; index >= 0; index -= 1) {
        const row = state[index];
        if (
          row.filename.startsWith('__somnibot_migration_target_probe_v1__:')
          && row.checksum.startsWith('target-binding-probe:v1:')
          && !row.success
          && Date.parse(row.applied_at) < dbNowMs - 10 * 60 * 1000
        ) {
          state.splice(index, 1);
        }
      }
      if (!state.some((row) => row.filename === targetProbeFilename)) {
        state.push({
          filename: targetProbeFilename,
          checksum: targetProbeChecksum,
          success: false,
          applied_at: dbNow(),
          duration_ms: 0,
        });
      }
      return options.targetProbeWriteFailureAfterCommit
        ? failure(504, 'target probe response lost after commit')
        : okJson({});
    }

    if (
      query.includes('$migration_runner_target_probe_cleanup$')
      && targetProbeFilename
      && targetProbeChecksum
    ) {
      if (options.targetProbeCleanupFailure) {
        return failure(500, 'target probe cleanup rejected');
      }
      const index = state.findIndex((row) => (
        row.filename === targetProbeFilename
        && row.checksum === targetProbeChecksum
        && !row.success
      ));
      if (index >= 0) state.splice(index, 1);
      return okJson({});
    }

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

  beforeEach(() => {
    vi.resetAllMocks();
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

  it('refuses pending source execution when only the Management API is configured', async () => {
    const simulator = createManagementSimulator([]);

    const result = await runMigrations();

    expect(result.applied).toEqual([]);
    expect(result.errors[0]).toMatch(/direct database connection.*required/i);
    expect(simulator.sourceQueries()).toHaveLength(0);
    expect(simulator.queries.filter((query) => query.includes('claim:v1:')))
      .toHaveLength(0);
  });

  it('proves a matching Management-only SQL and REST target before an up-to-date result', async () => {
    const source = 'CREATE TABLE runner_probe (id bigint);';
    const simulator = createManagementSimulator([{
      filename: '001_init.sql',
      checksum: canonical(source),
      success: true,
      applied_at: '2026-07-28T11:00:00.000Z',
      duration_ms: 1,
    }]);

    const result = await runMigrations();

    expect(result.errors).toEqual([]);
    expect(result.applied).toEqual([]);
    expect(result.skipped).toEqual(['001_init.sql']);
    expect(simulator.sourceQueries()).toHaveLength(0);
    expect(simulator.queries.some((query) => (
      query.includes('$migration_runner_target_probe_write$')
    ))).toBe(true);
    expect(simulator.queries.some((query) => (
      query.includes('$migration_runner_target_probe_cleanup$')
    ))).toBe(true);
    expect(simulator.rows.some((row) => (
      row.filename.startsWith('__somnibot_migration_target_probe_v1__:')
    ))).toBe(false);
  });

  it('accepts an ambiguous target-probe write only after exact REST proof', async () => {
    const source = 'CREATE TABLE runner_probe (id bigint);';
    const simulator = createManagementSimulator([{
      filename: '001_init.sql',
      checksum: canonical(source),
      success: true,
      applied_at: '2026-07-28T11:00:00.000Z',
      duration_ms: 1,
    }], {
      targetProbeWriteFailureAfterCommit: true,
    });

    const result = await runMigrations();

    expect(result.errors).toEqual([]);
    expect(result.skipped).toEqual(['001_init.sql']);
    expect(simulator.sourceQueries()).toHaveLength(0);
    expect(simulator.rows.some((row) => (
      row.filename.startsWith('__somnibot_migration_target_probe_v1__:')
    ))).toBe(false);
  });

  it('fails closed after an ambiguous target-probe REST read even when cleanup succeeds', async () => {
    const simulator = createManagementSimulator([], {
      targetProbeReadFailure: true,
    });

    const result = await runMigrations();

    expect(result.ran).toBe(false);
    expect(result.errors[0]).toMatch(/target binding could not be read/i);
    expect(simulator.sourceQueries()).toHaveLength(0);
    expect(simulator.rows).toEqual([]);
  });

  it('fails closed while a target-probe cleanup remains visible', async () => {
    const simulator = createManagementSimulator([], {
      targetProbeCleanupFailure: true,
    });

    const result = await runMigrations();

    expect(result.ran).toBe(false);
    expect(result.errors[0]).toMatch(/cleanup was not verified/i);
    expect(simulator.sourceQueries()).toHaveLength(0);
    expect(simulator.rows).toHaveLength(1);
    expect(simulator.rows[0]?.filename).toMatch(
      /^__somnibot_migration_target_probe_v1__:/,
    );
    expect(simulator.rows[0]?.success).toBe(false);
  });

  it('reaps only stale rows in the reserved target-probe namespace', async () => {
    const source = 'CREATE TABLE runner_probe (id bigint);';
    const staleProbeId = '00000000-0000-4000-8000-000000000001';
    const unrelatedClaim =
      `claim:v1:${canonical(source)}:00000000-0000-4000-8000-000000000002`;
    const simulator = createManagementSimulator([
      {
        filename: `__somnibot_migration_target_probe_v1__:${staleProbeId}`,
        checksum: `target-binding-probe:v1:${staleProbeId}`,
        success: false,
        applied_at: '2026-07-28T11:00:00.000Z',
        duration_ms: 0,
      },
      {
        filename: 'unrelated_claim.sql',
        checksum: unrelatedClaim,
        success: false,
        applied_at: '2026-07-28T11:00:00.000Z',
        duration_ms: 0,
      },
      {
        filename: '001_init.sql',
        checksum: canonical(source),
        success: true,
        applied_at: '2026-07-28T11:00:00.000Z',
        duration_ms: 1,
      },
    ]);

    const result = await runMigrations();

    expect(result.errors).toEqual([]);
    expect(result.skipped).toEqual(['001_init.sql']);
    expect(simulator.rows.some((row) => (
      row.filename === `__somnibot_migration_target_probe_v1__:${staleProbeId}`
    ))).toBe(false);
    expect(simulator.rows).toContainEqual(expect.objectContaining({
      filename: 'unrelated_claim.sql',
      checksum: unrelatedClaim,
      success: false,
    }));
    expect(simulator.queries.some((query) => (
      query.includes("applied_at < now() - interval '10 minutes'")
    ))).toBe(true);
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

  // Claimed source, concurrency, takeover, and ambiguous direct-commit behavior
  // are covered by migration-runner-direct.test.ts and the real-Postgres suite.
});
