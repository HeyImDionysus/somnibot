import { createHash } from 'node:crypto';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  readdirSync: vi.fn(),
  readFileSync: vi.fn(),
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

const MIGRATION = '20260727034400_fraud_signal_observation_index.sql';

interface HistoryRow {
  filename: string;
  checksum: string;
  success: boolean;
  applied_at: string;
  duration_ms: number;
}

interface DirectClient {
  queries: string[];
  unsafe: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
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

function unquote(value: string): string {
  return value.replace(/''/g, "'");
}

function quotedValues(sql: string, expression: RegExp): string[] {
  return [...sql.matchAll(expression)].map((match) => unquote(match[1]));
}

function installDirectSimulator(
  state: HistoryRow[],
  options: {
    mirrorControlToRest?: boolean;
    failConcurrentIndex?: boolean;
  } = {},
): DirectClient[] {
  const clients: DirectClient[] = [];
  const mirrorControlToRest = options.mirrorControlToRest ?? true;

  const execute = async (query: string): Promise<void> => {
    const claimToken = query.match(/claim:v1:[a-f0-9]{64}:[0-9a-f-]{36}/i)?.[0];
    const filenameEquals = quotedValues(
      query,
      /filename\s*=\s*'((?:''|[^'])*)'/gi,
    );
    const checksumEquals = quotedValues(
      query,
      /checksum\s*=\s*'((?:''|[^'])*)'/gi,
    );

    if (query.includes('CREATE TABLE IF NOT EXISTS public.schema_migrations')) {
      return;
    }

    if (query.includes('INSERT INTO public.schema_migrations') && claimToken) {
      if (mirrorControlToRest) {
        const values = quotedValues(query, /'((?:''|[^'])*)'/g);
        const filename = values[0];
        if (filename && !state.some((row) => row.filename === filename)) {
          state.push({
            filename,
            checksum: claimToken,
            success: false,
            applied_at: '2026-07-28T12:00:00.000Z',
            duration_ms: 0,
          });
        }
      }
      return;
    }

    if (
      query.includes('UPDATE public.schema_migrations')
      && query.includes('SET checksum =')
      && claimToken
      && !query.includes('$migration_runner_history$')
    ) {
      if (mirrorControlToRest) {
        const [next, expected] = checksumEquals;
        const row = state.find((item) => (
          item.filename === filenameEquals[0]
          && item.checksum === expected
          && !item.success
        ));
        if (row) {
          row.checksum = next;
          row.applied_at = '2026-07-28T12:00:00.000Z';
        }
      }
      return;
    }

    if (query.includes('$migration_runner_claim_proof$')) {
      const owned = state.some((row) => (
        row.filename === filenameEquals[0]
        && row.checksum === checksumEquals[0]
        && !row.success
      ));
      if (!owned) throw new Error('claim proof failed');
      return;
    }

    if (
      options.failConcurrentIndex
      && query.trimStart().startsWith('CREATE INDEX CONCURRENTLY')
    ) {
      throw new Error('concurrent build failed');
    }

    if (query.includes('$migration_runner_history$')) {
      const [next, expected] = checksumEquals.slice(-2);
      const row = state.find((item) => (
        item.filename === filenameEquals.at(-1)
        && item.checksum === expected
        && !item.success
      ));
      if (!row) throw new Error('completion claim lost');
      row.checksum = next;
      row.success = true;
      return;
    }

    if (
      query.includes('UPDATE public.schema_migrations')
      && query.includes('success = false')
      && query.includes('duration_ms =')
      && mirrorControlToRest
    ) {
      const [next, expected] = checksumEquals;
      const row = state.find((item) => (
        item.filename === filenameEquals[0]
        && item.checksum === expected
        && !item.success
      ));
      if (row) row.checksum = next;
    }
  };

  mocks.postgres.mockImplementation(() => {
    const client: DirectClient = {
      queries: [],
      unsafe: vi.fn(async (query: string) => {
        client.queries.push(query);
        await execute(query);
      }),
      end: vi.fn(async () => undefined),
    };
    clients.push(client);
    return client;
  });

  mocks.fetch.mockImplementation(async (
    input: string | URL | Request,
  ) => {
    const url = String(input);
    if (!url.includes('/rest/v1/schema_migrations')) {
      throw new Error(`Direct SQL should not use Management API: ${url}`);
    }
    const parsed = new URL(url);
    const filenameFilter = parsed.searchParams.get('filename');
    const selected = filenameFilter?.startsWith('eq.')
      ? state.filter((row) => row.filename === filenameFilter.slice(3))
      : state;
    return okJson(selected.map((row) => ({ ...row })));
  });

  return clients;
}

describe('migration runner direct-Postgres execution', () => {
  const originalEnv = { ...process.env };
  let source = '';

  beforeAll(async () => {
    const actualFs = await vi.importActual<typeof import('node:fs')>('node:fs');
    const actualPath = await vi.importActual<typeof import('node:path')>('node:path');
    source = actualFs.readFileSync(
      actualPath.resolve(
        process.cwd(),
        '../supabase/migrations',
        MIGRATION,
      ),
      'utf8',
    );
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.readdirSync.mockReturnValue([MIGRATION]);
    mocks.readFileSync.mockReturnValue(source);

    process.env.SUPABASE_URL = 'https://runner-proof.supabase.co';
    process.env.SUPABASE_SECRET_KEY = 'test-key';
    process.env.SUPABASE_DB_URL = 'postgresql://localhost/test';
    process.env.SUPABASE_ACCESS_TOKEN = 'management-token-must-not-be-used';
    process.env.MIGRATIONS_DIR = process.cwd();
    delete process.env.DATABASE_URL;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('uses one direct client for claim proof and the exact DO/CIC/DO sequence', async () => {
    const state: HistoryRow[] = [{
      filename: MIGRATION,
      checksum: canonical(source),
      success: false,
      applied_at: '2026-07-28T11:00:00.000Z',
      duration_ms: 1,
    }];
    const clients = installDirectSimulator(state);

    const result = await runMigrations();

    expect(result.errors).toEqual([]);
    expect(result.applied).toEqual([MIGRATION]);
    expect(clients).toHaveLength(3); // bootstrap, claim CAS, execution
    expect(clients[2].queries).toHaveLength(4);
    expect(clients[2].queries[0]).toContain('$migration_runner_claim_proof$');
    expect(clients[2].queries[1]).toContain('DO $fraud_index_recovery$');
    expect(clients[2].queries[2].trimStart()).toMatch(/^CREATE INDEX CONCURRENTLY/);
    expect(clients[2].queries[3]).toContain('DO $fraud_index_postflight$');
    expect(clients[2].queries[3]).toContain('$migration_runner_history$');
    expect(state[0]).toMatchObject({
      checksum: canonical(source),
      success: true,
    });
    expect(mocks.fetch.mock.calls.every(([url]) => (
      String(url).includes('/rest/v1/schema_migrations')
    ))).toBe(true);
  });

  it('stops before postflight and releases only its exact claim on CIC failure', async () => {
    const state: HistoryRow[] = [{
      filename: MIGRATION,
      checksum: canonical(source),
      success: false,
      applied_at: '2026-07-28T11:00:00.000Z',
      duration_ms: 1,
    }];
    const clients = installDirectSimulator(state, { failConcurrentIndex: true });

    const result = await runMigrations();

    expect(result.applied).toEqual([]);
    expect(result.errors[0]).toMatch(/concurrent build failed/i);
    expect(clients[2].queries).toHaveLength(3);
    expect(clients[2].queries.some((query) => (
      query.includes('DO $fraud_index_postflight$')
    ))).toBe(false);
    expect(clients[3].queries[0]).toContain('success = false');
    expect(state[0]).toMatchObject({
      checksum: canonical(source),
      success: false,
    });
  });

  it('executes zero source SQL when the direct target does not mirror REST history', async () => {
    const ordinarySource = 'CREATE TABLE wrong_target_probe (id bigint);';
    mocks.readdirSync.mockReturnValue(['001_wrong_target.sql']);
    mocks.readFileSync.mockReturnValue(ordinarySource);
    const state: HistoryRow[] = [];
    const clients = installDirectSimulator(state, { mirrorControlToRest: false });

    const result = await runMigrations();

    expect(result.applied).toEqual([]);
    expect(result.errors[0]).toMatch(/claim was not persisted/i);
    expect(clients).toHaveLength(2); // bootstrap and ambiguous claim insert only
    expect(clients.flatMap((client) => client.queries).some((query) => (
      query.includes('CREATE TABLE wrong_target_probe')
    ))).toBe(false);
  });
});
