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
  reserve: ReturnType<typeof vi.fn>;
  reserved: {
    queries: string[];
    unsafe: ReturnType<typeof vi.fn>;
    release: ReturnType<typeof vi.fn>;
  };
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
    failOuterSource?: boolean;
    failHeartbeatWrite?: boolean;
    loseClaimAfterPreflight?: boolean;
    claimFailureAfterCommit?: boolean;
    commitFailureAfterCommit?: boolean;
    heartbeatWritten?: () => void;
    sourceGate?: {
      started: () => void;
      wait: Promise<void>;
    };
    postflightGate?: {
      started: () => void;
      wait: Promise<void>;
    };
  } = {},
): DirectClient[] {
  const clients: DirectClient[] = [];
  const mirrorControlToRest = options.mirrorControlToRest ?? true;

  const execute = async (query: string): Promise<void> => {
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
      options.sourceGate
      && query.includes('CREATE TABLE heartbeat_probe')
    ) {
      options.sourceGate.started();
      await options.sourceGate.wait;
    }

    if (
      options.postflightGate
      && query.includes('DO $fraud_index_postflight$')
    ) {
      options.postflightGate.started();
      await options.postflightGate.wait;
    }

    if (options.failOuterSource && query.includes('CREATE TABLE outer_rollback_probe')) {
      throw new Error('outer source failed');
    }

    if (options.commitFailureAfterCommit && query.trim() === 'COMMIT;') {
      throw new Error('commit response lost after commit');
    }

    if (query.includes('CREATE TABLE IF NOT EXISTS public.schema_migrations')) {
      return;
    }

    if (
      query.includes('$migration_runner_target_probe_write$')
      && targetProbeFilename
      && targetProbeChecksum
    ) {
      if (mirrorControlToRest) {
        const existing = state.find((row) => row.filename === targetProbeFilename);
        if (!existing) {
          state.push({
            filename: targetProbeFilename,
            checksum: targetProbeChecksum,
            success: false,
            applied_at: '2026-07-28T12:00:00.000Z',
            duration_ms: 0,
          });
        }
      }
      if (options.claimFailureAfterCommit) {
        throw new Error('claim response lost after commit');
      }
      return;
    }

    if (
      query.includes('$migration_runner_target_probe_cleanup$')
      && targetProbeFilename
      && targetProbeChecksum
    ) {
      if (mirrorControlToRest) {
        const index = state.findIndex((row) => (
          row.filename === targetProbeFilename
          && row.checksum === targetProbeChecksum
          && !row.success
        ));
        if (index >= 0) state.splice(index, 1);
      }
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
      if (options.claimFailureAfterCommit) {
        throw new Error('claim response lost after commit');
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
      query.includes('UPDATE public.schema_migrations')
      && query.includes('SET applied_at')
      && !query.includes('SET checksum =')
      && !query.includes('$migration_runner_history$')
    ) {
      if (options.failHeartbeatWrite) {
        throw new Error('heartbeat write failed before commit');
      }
      const row = state.find((item) => (
        item.filename === filenameEquals[0]
        && item.checksum === checksumEquals[0]
        && !item.success
      ));
      if (row) {
        row.applied_at = '2026-07-28T12:01:00.000Z';
        options.heartbeatWritten?.();
      }
      return;
    }

    if (
      query.includes('DO $fraud_index_recovery$')
      && options.loseClaimAfterPreflight
    ) {
      const row = state.find((item) => (
        item.filename === MIGRATION
        && item.checksum.startsWith('claim:v1:')
        && !item.success
      ));
      if (row) {
        const claimedChecksum = row.checksum.split(':')[2] ?? '';
        row.checksum =
          `claim:v1:${claimedChecksum}:00000000-0000-4000-8000-000000000099`;
        row.applied_at = '2026-07-28T12:01:00.000Z';
      }
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
    const reserved = {
      queries: [] as string[],
      unsafe: vi.fn(async (query: string) => {
        reserved.queries.push(query);
        await execute(query);
      }),
      release: vi.fn(),
    };
    const client: DirectClient = {
      queries: [],
      unsafe: vi.fn(async (query: string) => {
        client.queries.push(query);
        await execute(query);
      }),
      reserve: vi.fn(async () => reserved),
      reserved,
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
    vi.resetAllMocks();
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
    vi.useRealTimers();
    process.env = { ...originalEnv };
  });

  it('rejects a Supabase transaction-pooler URL before any claim or source SQL', async () => {
    process.env.SUPABASE_DB_URL =
      'postgresql://postgres.runner-proof:secret@aws-0-us-east-1.pooler.supabase.com:6543/postgres';
    const state: HistoryRow[] = [{
      filename: MIGRATION,
      checksum: canonical(source),
      success: false,
      applied_at: '2026-07-28T11:00:00.000Z',
      duration_ms: 1,
    }];
    const clients = installDirectSimulator(state);

    const result = await runMigrations();

    expect(result.ran).toBe(false);
    expect(result.applied).toEqual([]);
    expect(result.errors[0]).toMatch(/transaction pool|session|direct/i);
    expect(clients).toEqual([]);
    expect(mocks.fetch).not.toHaveBeenCalled();

    process.env.SUPABASE_DB_URL =
      'postgresql://postgres.runner-proof:secret@aws-0-us-east-1.pooler.supabase.com:5432/postgres?PgBouncer=true';
    const markedResult = await runMigrations();
    expect(markedResult.ran).toBe(false);
    expect(markedResult.errors[0]).toMatch(/transaction pool|session|direct/i);
    expect(clients).toEqual([]);
    expect(mocks.fetch).not.toHaveBeenCalled();

    process.env.SUPABASE_DB_URL =
      'postgresql://postgres:secret@db.runnerproof.supabase.co.:6543/postgres';
    const dedicatedResult = await runMigrations();
    expect(dedicatedResult.ran).toBe(false);
    expect(dedicatedResult.errors[0]).toMatch(/transaction pool|session|direct/i);
    expect(clients).toEqual([]);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('holds one reserved session advisory lock and reproves ownership before every DO/CIC/DO batch', async () => {
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
    expect(clients).toHaveLength(5); // bootstrap, binding write/cleanup, claim CAS, execution
    const execution = clients[4];
    expect(execution.queries).toEqual([]);
    expect(execution.reserve).toHaveBeenCalledOnce();
    expect(execution.reserved.queries).toHaveLength(12);
    expect(execution.reserved.queries[0]).toContain('pg_advisory_lock');
    expect(execution.reserved.queries[1]).toContain('$migration_runner_claim_proof$');
    expect(execution.reserved.queries[2]).toContain('DO $fraud_index_recovery$');
    expect(execution.reserved.queries[3]).toContain('$migration_runner_claim_proof$');
    expect(execution.reserved.queries[4].trimStart()).toMatch(/^CREATE INDEX CONCURRENTLY/);
    expect(execution.reserved.queries[5]).toContain('$migration_runner_claim_proof$');
    expect(execution.reserved.queries[6].trim()).toBe('BEGIN;');
    expect(execution.reserved.queries[7]).toContain('DO $fraud_index_postflight$');
    expect(execution.reserved.queries[7]).not.toContain('$migration_runner_history$');
    expect(execution.reserved.queries[8]).toContain('$migration_runner_claim_proof$');
    expect(execution.reserved.queries[9]).toContain('$migration_runner_history$');
    expect(execution.reserved.queries[10].trim()).toBe('COMMIT;');
    expect(execution.reserved.queries[11]).toContain('pg_advisory_unlock');
    expect(execution.reserved.release).toHaveBeenCalledOnce();
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
    expect(clients[4].reserved.queries.some((query) => (
      query.includes('DO $fraud_index_postflight$')
    ))).toBe(false);
    expect(clients[4].reserved.queries.at(-1)).toContain('pg_advisory_unlock');
    expect(clients[4].reserved.release).toHaveBeenCalledOnce();
    expect(clients[5].queries[0]).toContain('success = false');
    expect(state[0]).toMatchObject({
      checksum: canonical(source),
      success: false,
    });
  });

  it('wraps ordinary source and completion CAS in an explicit transaction on the locked session', async () => {
    const ordinarySource = 'CREATE TABLE ordinary_probe (id bigint);';
    mocks.readdirSync.mockReturnValue(['001_ordinary.sql']);
    mocks.readFileSync.mockReturnValue(ordinarySource);
    const state: HistoryRow[] = [{
      filename: '001_ordinary.sql',
      checksum: canonical(ordinarySource),
      success: false,
      applied_at: '2026-07-28T11:00:00.000Z',
      duration_ms: 1,
    }];
    const clients = installDirectSimulator(state);

    const result = await runMigrations();

    expect(result.errors).toEqual([]);
    expect(result.applied).toEqual(['001_ordinary.sql']);
    const queries = clients[4].reserved.queries;
    const lock = queries.findIndex((query) => query.includes('pg_advisory_lock'));
    const proof = queries.findIndex((query) => query.includes('$migration_runner_claim_proof$'));
    const begin = queries.findIndex((query) => query.trim() === 'BEGIN;');
    const sourceQuery = queries.findIndex((query) => query.includes('CREATE TABLE ordinary_probe'));
    const completion = queries.findIndex((query) => query.includes('$migration_runner_history$'));
    const commit = queries.findIndex((query) => query.trim() === 'COMMIT;');
    const unlock = queries.findIndex((query) => query.includes('pg_advisory_unlock'));
    expect(lock).toBeLessThan(proof);
    expect(proof).toBeLessThan(begin);
    expect(begin).toBeLessThan(sourceQuery);
    expect(sourceQuery).toBeLessThan(completion);
    expect(completion).toBeLessThan(commit);
    expect(commit).toBeLessThan(unlock);
    expect(clients[4].reserved.release).toHaveBeenCalledOnce();
    expect(clients[3].queries[0]).toContain('SET checksum =');
    expect(clients[3].queries[0]).toContain(canonical(ordinarySource));
  });

  it('keeps a source-provided outer BEGIN open until the separate completion CAS commits', async () => {
    const outerSource = 'BEGIN;\nCREATE TABLE outer_probe (id bigint);\nCOMMIT;';
    mocks.readdirSync.mockReturnValue(['001_outer.sql']);
    mocks.readFileSync.mockReturnValue(outerSource);
    const state: HistoryRow[] = [{
      filename: '001_outer.sql',
      checksum: canonical(outerSource),
      success: false,
      applied_at: '2026-07-28T11:00:00.000Z',
      duration_ms: 1,
    }];
    const clients = installDirectSimulator(state);

    const result = await runMigrations();

    expect(result.errors).toEqual([]);
    expect(result.applied).toEqual(['001_outer.sql']);
    const queries = clients[4].reserved.queries;
    const sourceQuery = queries.findIndex((query) => query.includes('CREATE TABLE outer_probe'));
    const completion = queries.findIndex((query) => query.includes('$migration_runner_history$'));
    const commit = queries.findIndex((query) => query.trim() === 'COMMIT;');
    expect(queries[sourceQuery].trimStart()).toMatch(/^BEGIN;/);
    expect(queries[sourceQuery]).not.toMatch(/COMMIT;/);
    expect(sourceQuery).toBeLessThan(completion);
    expect(completion).toBeLessThan(commit);
  });

  it('rolls back a failed outer-BEGIN source on the same reserved session before unlock', async () => {
    const outerSource =
      'BEGIN;\nCREATE TABLE outer_rollback_probe (id bigint);\nCOMMIT;';
    mocks.readdirSync.mockReturnValue(['001_outer_rollback.sql']);
    mocks.readFileSync.mockReturnValue(outerSource);
    const state: HistoryRow[] = [{
      filename: '001_outer_rollback.sql',
      checksum: canonical(outerSource),
      success: false,
      applied_at: '2026-07-28T11:00:00.000Z',
      duration_ms: 1,
    }];
    const clients = installDirectSimulator(state, { failOuterSource: true });

    const result = await runMigrations();

    expect(result.applied).toEqual([]);
    expect(result.errors[0]).toMatch(/outer source failed/i);
    const execution = clients[4];
    expect(execution.reserve).toHaveBeenCalledOnce();
    expect(execution.queries).toEqual([]);
    const sourceQuery = execution.reserved.queries.findIndex((query) => (
      query.includes('CREATE TABLE outer_rollback_probe')
    ));
    const rollback = execution.reserved.queries.findIndex((query) => (
      query.trim() === 'ROLLBACK;'
    ));
    const unlock = execution.reserved.queries.findIndex((query) => (
      query.includes('pg_advisory_unlock')
    ));
    expect(sourceQuery).toBeLessThan(rollback);
    expect(rollback).toBeLessThan(unlock);
    expect(execution.reserved.queries.some((query) => (
      query.includes('$migration_runner_history$')
    ))).toBe(false);
    expect(execution.reserved.release).toHaveBeenCalledOnce();
    expect(state[0]).toMatchObject({
      checksum: canonical(outerSource),
      success: false,
    });
  });

  it('continues after an ambiguous claim response only when REST proves the exact owner token', async () => {
    const ordinarySource = 'CREATE TABLE ambiguous_claim_probe (id bigint);';
    mocks.readdirSync.mockReturnValue(['001_ambiguous_claim.sql']);
    mocks.readFileSync.mockReturnValue(ordinarySource);
    const state: HistoryRow[] = [];
    installDirectSimulator(state, { claimFailureAfterCommit: true });

    const result = await runMigrations();

    expect(result.errors).toEqual([]);
    expect(result.applied).toEqual(['001_ambiguous_claim.sql']);
    expect(state[0]).toMatchObject({
      filename: '001_ambiguous_claim.sql',
      checksum: canonical(ordinarySource),
      success: true,
    });
  });

  it('confirms durable success after the direct COMMIT response is lost', async () => {
    const ordinarySource = 'CREATE TABLE ambiguous_commit_probe (id bigint);';
    mocks.readdirSync.mockReturnValue(['001_ambiguous_commit.sql']);
    mocks.readFileSync.mockReturnValue(ordinarySource);
    const state: HistoryRow[] = [{
      filename: '001_ambiguous_commit.sql',
      checksum: canonical(ordinarySource),
      success: false,
      applied_at: '2026-07-28T11:00:00.000Z',
      duration_ms: 1,
    }];
    installDirectSimulator(state, { commitFailureAfterCommit: true });

    const result = await runMigrations();

    expect(result.errors).toEqual([]);
    expect(result.applied).toEqual(['001_ambiguous_commit.sql']);
    expect(state[0]).toMatchObject({
      checksum: canonical(ordinarySource),
      success: true,
    });
  });

  it('stops before CIC when ownership is lost after the approved preflight batch', async () => {
    const state: HistoryRow[] = [{
      filename: MIGRATION,
      checksum: canonical(source),
      success: false,
      applied_at: '2026-07-28T11:00:00.000Z',
      duration_ms: 1,
    }];
    const clients = installDirectSimulator(state, { loseClaimAfterPreflight: true });

    const result = await runMigrations();

    expect(result.applied).toEqual([]);
    expect(result.errors[0]).toMatch(/claim proof failed/i);
    expect(clients[4].reserved.queries.some((query) => (
      query.trimStart().startsWith('CREATE INDEX CONCURRENTLY')
    ))).toBe(false);
    expect(clients[4].reserved.queries.at(-1)).toContain('pg_advisory_unlock');
    expect(state[0].checksum).toContain('00000000-0000-4000-8000-000000000099');
  });

  it('fails closed when a heartbeat write fails and the live lease timestamp does not advance', async () => {
    vi.useFakeTimers();
    const ordinarySource = 'CREATE TABLE heartbeat_probe (id bigint);';
    mocks.readdirSync.mockReturnValue(['001_heartbeat.sql']);
    mocks.readFileSync.mockReturnValue(ordinarySource);
    const state: HistoryRow[] = [{
      filename: '001_heartbeat.sql',
      checksum: canonical(ordinarySource),
      success: false,
      applied_at: '2026-07-28T11:00:00.000Z',
      duration_ms: 1,
    }];
    let sourceStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      sourceStarted = resolve;
    });
    let releaseSource!: () => void;
    const sourceWait = new Promise<void>((resolve) => {
      releaseSource = resolve;
    });
    const clients = installDirectSimulator(state, {
      failHeartbeatWrite: true,
      sourceGate: {
        started: sourceStarted,
        wait: sourceWait,
      },
    });

    const pending = runMigrations();
    await started;
    await vi.advanceTimersByTimeAsync(60_000);
    releaseSource();
    const result = await pending;

    expect(result.applied).toEqual([]);
    expect(result.errors[0]).toMatch(/heartbeat.*lease timestamp.*advance/i);
    expect(state[0]).toMatchObject({
      checksum: canonical(ordinarySource),
      success: false,
    });
    expect(clients[4].reserved.queries.some((query) => (
      query.includes('$migration_runner_history$')
    ))).toBe(false);
  });

  it('rolls back without success when heartbeat fails during final postflight', async () => {
    vi.useFakeTimers();
    const state: HistoryRow[] = [{
      filename: MIGRATION,
      checksum: canonical(source),
      success: false,
      applied_at: '2026-07-28T11:00:00.000Z',
      duration_ms: 1,
    }];
    let postflightStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      postflightStarted = resolve;
    });
    let releasePostflight!: () => void;
    const postflightWait = new Promise<void>((resolve) => {
      releasePostflight = resolve;
    });
    const clients = installDirectSimulator(state, {
      failHeartbeatWrite: true,
      postflightGate: {
        started: postflightStarted,
        wait: postflightWait,
      },
    });

    const pending = runMigrations();
    await started;
    await vi.advanceTimersByTimeAsync(60_000);
    releasePostflight();
    const result = await pending;

    expect(result.applied).toEqual([]);
    expect(result.errors[0]).toMatch(/heartbeat.*lease timestamp.*advance/i);
    expect(state[0]).toMatchObject({
      checksum: canonical(source),
      success: false,
    });
    expect(clients[4].reserved.queries.some((query) => (
      query.includes('$migration_runner_history$')
    ))).toBe(false);
    expect(clients[4].reserved.queries.some((query) => (
      query.trim() === 'ROLLBACK;'
    ))).toBe(true);
  });

  it('renews a long-running claim on schedule only after the live lease timestamp advances', async () => {
    vi.useFakeTimers();
    const ordinarySource = 'CREATE TABLE heartbeat_probe (id bigint);';
    mocks.readdirSync.mockReturnValue(['001_heartbeat.sql']);
    mocks.readFileSync.mockReturnValue(ordinarySource);
    const state: HistoryRow[] = [{
      filename: '001_heartbeat.sql',
      checksum: canonical(ordinarySource),
      success: false,
      applied_at: '2026-07-28T11:00:00.000Z',
      duration_ms: 1,
    }];
    let sourceStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      sourceStarted = resolve;
    });
    let releaseSource!: () => void;
    const sourceWait = new Promise<void>((resolve) => {
      releaseSource = resolve;
    });
    let heartbeatWritten!: () => void;
    const heartbeatAdvanced = new Promise<void>((resolve) => {
      heartbeatWritten = resolve;
    });
    installDirectSimulator(state, {
      heartbeatWritten,
      sourceGate: {
        started: sourceStarted,
        wait: sourceWait,
      },
    });

    const pending = runMigrations();
    await started;
    await vi.advanceTimersByTimeAsync(60_000);
    await heartbeatAdvanced;
    expect(state[0].applied_at).toBe('2026-07-28T12:01:00.000Z');
    releaseSource();
    const result = await pending;

    expect(result.errors).toEqual([]);
    expect(result.applied).toEqual(['001_heartbeat.sql']);
  });

  it('executes zero source SQL when the direct target does not mirror REST history', async () => {
    const ordinarySource = 'CREATE TABLE wrong_target_probe (id bigint);';
    mocks.readdirSync.mockReturnValue(['001_wrong_target.sql']);
    mocks.readFileSync.mockReturnValue(ordinarySource);
    const state: HistoryRow[] = [];
    const clients = installDirectSimulator(state, { mirrorControlToRest: false });

    const result = await runMigrations();

    expect(result.applied).toEqual([]);
    expect(result.errors[0]).toMatch(/SQL.*REST.*target binding/i);
    expect(clients.every((client) => client.reserve.mock.calls.length === 0))
      .toBe(true);
    expect(clients.flatMap((client) => client.queries).some((query) => (
      query.includes('CREATE TABLE wrong_target_probe')
    ))).toBe(false);
  });

  it('fails closed before trusting all-success REST history from a different target', async () => {
    const ordinarySource = 'CREATE TABLE wrong_target_success_probe (id bigint);';
    mocks.readdirSync.mockReturnValue(['001_wrong_target_success.sql']);
    mocks.readFileSync.mockReturnValue(ordinarySource);
    const state: HistoryRow[] = [{
      filename: '001_wrong_target_success.sql',
      checksum: canonical(ordinarySource),
      success: true,
      applied_at: '2026-07-28T12:00:00.000Z',
      duration_ms: 5,
    }];
    const clients = installDirectSimulator(state, { mirrorControlToRest: false });

    const result = await runMigrations();

    expect(result.ran).toBe(false);
    expect(result.applied).toEqual([]);
    expect(result.skipped).toEqual([]);
    expect(result.errors[0]).toMatch(/SQL.*REST.*target binding/i);
    expect(clients.flatMap((client) => client.queries).some((query) => (
      query.includes('CREATE TABLE wrong_target_success_probe')
    ))).toBe(false);
  });
});
