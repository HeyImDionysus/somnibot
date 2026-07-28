/**
 * Executable proof for the real license-heartbeat decision migration.
 *
 * The fixture rewrites only the migration's explicit schema and clock call,
 * then executes the shipped SQL against real Postgres. A controllable database
 * clock makes the equality boundary exact; the production source contract test
 * separately pins that the shipped function calls pg_catalog.clock_timestamp().
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getTestDbUrl } from './helpers.js';

const FIXTURE_SCHEMA = 'license_heartbeat_decision_fixture';
const MIGRATION = '20260727034500_license_heartbeat_decision.sql';
const DECISION_AT = '2026-07-27T12:00:00.000Z';
const NEWER_DECISION_AT = '2026-07-27T12:00:01.000Z';
const OLD_LAST_SEEN = '2020-01-01T00:00:00.000Z';
const CLOCK_PAUSE_LOCK = 40_234_500;

const KEY_A = '10000000-0000-4000-8000-000000000001';
const KEY_B = '10000000-0000-4000-8000-000000000002';
const KEY_C = '10000000-0000-4000-8000-000000000003';
const KEY_D = '10000000-0000-4000-8000-000000000004';
const SESSION_A = '20000000-0000-4000-8000-000000000001';
const SESSION_B = '20000000-0000-4000-8000-000000000002';
const SESSION_C = '20000000-0000-4000-8000-000000000003';
const SESSION_D = '20000000-0000-4000-8000-000000000004';

type HeartbeatDecision = {
  entitlement_id: string | null;
  status: string;
  grace_period_ends_at: string | null;
  decided_at: string;
  candidate_count: number;
  session_touched: boolean;
  next_heartbeat_seconds: number;
};

let sql: Sql;

function migrationSource(): string {
  const testDir = dirname(fileURLToPath(import.meta.url));
  return readFileSync(
    resolve(testDir, '../../../../supabase/migrations', MIGRATION),
    'utf8',
  );
}

function isolatedMigration(): string {
  return migrationSource()
    .replaceAll('public.', `${FIXTURE_SCHEMA}.`)
    .replaceAll(
      'pg_catalog.clock_timestamp()',
      `${FIXTURE_SCHEMA}.fixture_clock()`,
    );
}

const FIXTURE_SCHEMA_SQL = `
  CREATE SCHEMA ${FIXTURE_SCHEMA};

  CREATE TABLE ${FIXTURE_SCHEMA}.clock_control (
    decision_at TIMESTAMPTZ NOT NULL,
    pause_backend_pid INTEGER,
    pause_lock_key BIGINT
  );
  INSERT INTO ${FIXTURE_SCHEMA}.clock_control (decision_at)
  VALUES ('${DECISION_AT}');

  CREATE FUNCTION ${FIXTURE_SCHEMA}.fixture_clock()
  RETURNS TIMESTAMPTZ
  LANGUAGE plpgsql
  VOLATILE
  SET search_path = ''
  AS $$
  DECLARE
    captured_at TIMESTAMPTZ;
    backend_pause_lock BIGINT;
  BEGIN
    SELECT
      control.decision_at,
      CASE
        WHEN control.pause_backend_pid = pg_catalog.pg_backend_pid()
          THEN control.pause_lock_key
      END
      INTO captured_at, backend_pause_lock
      FROM ${FIXTURE_SCHEMA}.clock_control AS control
      LIMIT 1;

    IF backend_pause_lock IS NOT NULL THEN
      -- The shipped function keeps its 500ms lock timeout. Only the test clock's
      -- explicit barrier gets a wider ceiling so slow CI cannot make this
      -- deterministic interleaving flaky; restore the production value before
      -- the heartbeat reaches any production row lock.
      PERFORM pg_catalog.set_config('lock_timeout', '5s', true);
      PERFORM pg_catalog.pg_advisory_xact_lock(backend_pause_lock);
      PERFORM pg_catalog.set_config('lock_timeout', '500ms', true);
    END IF;

    RETURN captured_at;
  END
  $$;

  CREATE TABLE ${FIXTURE_SCHEMA}.license_keys (
    id UUID PRIMARY KEY,
    key_hash TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL,
    product_id UUID NOT NULL
  );

  CREATE TABLE ${FIXTURE_SCHEMA}.product_license_config (
    product_id UUID PRIMARY KEY,
    heartbeat_interval_seconds INTEGER NOT NULL
  );

  CREATE TABLE ${FIXTURE_SCHEMA}.entitlements (
    id UUID PRIMARY KEY,
    license_key_id UUID NOT NULL,
    status TEXT NOT NULL,
    grace_period_ends_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL
  );

  CREATE TABLE ${FIXTURE_SCHEMA}.license_sessions (
    id UUID PRIMARY KEY,
    license_key_id UUID NOT NULL,
    active BOOLEAN NOT NULL,
    last_seen_at TIMESTAMPTZ
  );
`;

async function setDecisionClock(value: string) {
  await sql.unsafe(`
    UPDATE ${FIXTURE_SCHEMA}.clock_control
       SET decision_at = '${value}'
  `);
}

async function setClockPause(
  backendPid: number | null,
  lockKey: number | null,
): Promise<void> {
  await sql.unsafe(`
    UPDATE ${FIXTURE_SCHEMA}.clock_control
       SET pause_backend_pid = ${backendPid ?? 'NULL'},
           pause_lock_key = ${lockKey ?? 'NULL'}
  `);
}

async function seedKeyAndSession(keyId: string, sessionId: string, status = 'active') {
  await sql.unsafe(`
    INSERT INTO ${FIXTURE_SCHEMA}.license_keys (
      id,
      key_hash,
      status,
      product_id
    ) VALUES (
      '${keyId}',
      '${keyHashFor(keyId)}',
      '${status}',
      '${keyId}'
    );

    INSERT INTO ${FIXTURE_SCHEMA}.product_license_config (
      product_id,
      heartbeat_interval_seconds
    ) VALUES (
      '${keyId}',
      300
    );

    INSERT INTO ${FIXTURE_SCHEMA}.license_sessions (
      id,
      license_key_id,
      active,
      last_seen_at
    ) VALUES (
      '${sessionId}',
      '${keyId}',
      true,
      '${OLD_LAST_SEEN}'
    );
  `);
}

function keyHashFor(keyId: string): string {
  return `hash-${keyId}`;
}

async function heartbeatDecisionForHash(
  keyHash: string,
  sessionId: string,
): Promise<HeartbeatDecision> {
  const [row] = await sql.unsafe<Array<{ decision: HeartbeatDecision }>>(`
    SELECT ${FIXTURE_SCHEMA}.license_heartbeat_decision(
      '${keyHash}'::TEXT,
      '${sessionId}'::UUID
    ) AS decision
  `);
  if (!row) throw new Error('Heartbeat decision returned no row');
  return row.decision;
}

async function heartbeatDecision(
  keyId: string,
  sessionId: string,
): Promise<HeartbeatDecision> {
  return heartbeatDecisionForHash(keyHashFor(keyId), sessionId);
}

async function sessionState(sessionId: string) {
  const [row] = await sql.unsafe<Array<{
    active: boolean;
    last_seen_at: Date;
  }>>(`
    SELECT active, last_seen_at
      FROM ${FIXTURE_SCHEMA}.license_sessions
     WHERE id = '${sessionId}'::UUID
  `);
  return row;
}

async function waitForBackendLock(backendPid: number): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const [activity] = await sql.unsafe<Array<{
      wait_event_type: string | null;
    }>>(`
      SELECT wait_event_type
        FROM pg_catalog.pg_stat_activity
       WHERE pid = ${backendPid}
    `);
    if (activity?.wait_event_type === 'Lock') return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Backend ${backendPid} did not enter a lock wait`);
}

describe('license_heartbeat_decision real-Postgres fixture', () => {
  beforeAll(async () => {
    sql = postgres(getTestDbUrl(), { max: 3 });
    await sql`SELECT 1`;

    await sql.unsafe(`DROP SCHEMA IF EXISTS ${FIXTURE_SCHEMA} CASCADE`);
    await sql.unsafe(FIXTURE_SCHEMA_SQL);
    await sql.unsafe(isolatedMigration());
  }, 60_000);

  beforeEach(async () => {
    await sql.unsafe(`
      TRUNCATE
        ${FIXTURE_SCHEMA}.license_sessions,
        ${FIXTURE_SCHEMA}.entitlements,
        ${FIXTURE_SCHEMA}.product_license_config,
        ${FIXTURE_SCHEMA}.license_keys
    `);
    await setDecisionClock(DECISION_AT);
    await setClockPause(null, null);
  });

  afterAll(async () => {
    if (sql) {
      await sql.unsafe(`DROP SCHEMA IF EXISTS ${FIXTURE_SCHEMA} CASCADE`);
      await sql.end({ timeout: 5 });
    }
  });

  it('keeps equality live and expires only a strictly earlier grace deadline', async () => {
    await seedKeyAndSession(KEY_A, SESSION_A);
    await sql.unsafe(`
      INSERT INTO ${FIXTURE_SCHEMA}.entitlements (
        id,
        license_key_id,
        status,
        grace_period_ends_at,
        updated_at
      ) VALUES (
        '30000000-0000-4000-8000-000000000001',
        '${KEY_A}',
        'grace_period',
        '${DECISION_AT}',
        '${DECISION_AT}'
      )
    `);

    const equal = await heartbeatDecision(KEY_A, SESSION_A);
    expect(equal).toMatchObject({
      status: 'grace_period',
      candidate_count: 1,
      session_touched: true,
      next_heartbeat_seconds: 300,
    });
    expect(new Date(equal.decided_at).toISOString()).toBe(DECISION_AT);
    expect(new Date(equal.grace_period_ends_at!).toISOString()).toBe(DECISION_AT);
    expect((await sessionState(SESSION_A))!.last_seen_at.toISOString()).toBe(DECISION_AT);

    await sql.unsafe(`
      UPDATE ${FIXTURE_SCHEMA}.entitlements
         SET grace_period_ends_at = '${DECISION_AT}'::TIMESTAMPTZ - INTERVAL '1 microsecond'
       WHERE license_key_id = '${KEY_A}'::UUID;
      UPDATE ${FIXTURE_SCHEMA}.license_sessions
         SET last_seen_at = '${OLD_LAST_SEEN}'
       WHERE id = '${SESSION_A}'::UUID
    `);

    const lapsed = await heartbeatDecision(KEY_A, SESSION_A);
    expect(lapsed).toMatchObject({
      status: 'expired',
      session_touched: false,
    });
    expect((await sessionState(SESSION_A))!.last_seen_at.toISOString()).toBe(OLD_LAST_SEEN);
  });

  it('deterministically prefers active, then latest live grace, then latest recorded status', async () => {
    await seedKeyAndSession(KEY_A, SESSION_A);
    await seedKeyAndSession(KEY_B, SESSION_B);
    await seedKeyAndSession(KEY_C, SESSION_C);
    await seedKeyAndSession(KEY_D, SESSION_D);
    await sql.unsafe(`
      INSERT INTO ${FIXTURE_SCHEMA}.entitlements (
        id,
        license_key_id,
        status,
        grace_period_ends_at,
        updated_at
      ) VALUES
        (
          '30000000-0000-4000-8000-000000000002',
          '${KEY_A}',
          'active',
          NULL,
          '2026-01-01T00:00:00Z'
        ),
        (
          '30000000-0000-4000-8000-000000000001',
          '${KEY_A}',
          'active',
          NULL,
          '2025-01-01T00:00:00Z'
        ),
        (
          '30000000-0000-4000-8000-000000000003',
          '${KEY_A}',
          'grace_period',
          '${DECISION_AT}'::TIMESTAMPTZ + INTERVAL '10 days',
          '${DECISION_AT}'
        ),
        (
          '30000000-0000-4000-8000-000000000011',
          '${KEY_B}',
          'grace_period',
          '${DECISION_AT}'::TIMESTAMPTZ + INTERVAL '1 day',
          '${DECISION_AT}'
        ),
        (
          '30000000-0000-4000-8000-000000000012',
          '${KEY_B}',
          'grace_period',
          '${DECISION_AT}'::TIMESTAMPTZ + INTERVAL '2 days',
          '${DECISION_AT}'
        ),
        (
          '30000000-0000-4000-8000-000000000021',
          '${KEY_C}',
          'cancelled',
          NULL,
          '2026-07-20T00:00:00Z'
        ),
        (
          '30000000-0000-4000-8000-000000000022',
          '${KEY_C}',
          'suspended',
          NULL,
          '2026-07-26T00:00:00Z'
        )
    `);

    const active = await heartbeatDecision(KEY_A, SESSION_A);
    expect(active).toMatchObject({
      entitlement_id: '30000000-0000-4000-8000-000000000001',
      status: 'active',
      candidate_count: 3,
      session_touched: true,
    });

    const grace = await heartbeatDecision(KEY_B, SESSION_B);
    expect(grace).toMatchObject({
      entitlement_id: '30000000-0000-4000-8000-000000000012',
      status: 'grace_period',
      candidate_count: 2,
      session_touched: true,
    });

    const recorded = await heartbeatDecision(KEY_C, SESSION_C);
    expect(recorded).toMatchObject({
      entitlement_id: '30000000-0000-4000-8000-000000000022',
      status: 'suspended',
      candidate_count: 2,
      session_touched: false,
    });

    const missing = await heartbeatDecision(KEY_D, SESSION_D);
    expect(missing).toMatchObject({
      entitlement_id: null,
      status: 'revoked',
      candidate_count: 0,
      session_touched: false,
    });
  });

  it('uses a fresh database decision clock on every call', async () => {
    const deadline = '2026-07-27T12:01:00.000Z';
    await seedKeyAndSession(KEY_A, SESSION_A);
    await sql.unsafe(`
      INSERT INTO ${FIXTURE_SCHEMA}.entitlements (
        id,
        license_key_id,
        status,
        grace_period_ends_at,
        updated_at
      ) VALUES (
        '30000000-0000-4000-8000-000000000031',
        '${KEY_A}',
        'grace_period',
        '${deadline}',
        '${DECISION_AT}'
      )
    `);

    const before = await heartbeatDecision(KEY_A, SESSION_A);
    expect(before.status).toBe('grace_period');
    expect(new Date(before.decided_at).toISOString()).toBe(DECISION_AT);

    const afterDeadline = '2026-07-27T12:02:00.000Z';
    await setDecisionClock(afterDeadline);
    const after = await heartbeatDecision(KEY_A, SESSION_A);
    expect(after).toMatchObject({ status: 'expired', session_touched: false });
    expect(new Date(after.decided_at).toISOString()).toBe(afterDeadline);
  });

  it('touches a null last_seen_at without replacing a newer stored timestamp', async () => {
    const futureLastSeen = '2026-07-27T12:00:02.000Z';
    await seedKeyAndSession(KEY_A, SESSION_A);
    await sql.unsafe(`
      INSERT INTO ${FIXTURE_SCHEMA}.entitlements (
        id,
        license_key_id,
        status,
        grace_period_ends_at,
        updated_at
      ) VALUES (
        '30000000-0000-4000-8000-000000000033',
        '${KEY_A}',
        'active',
        NULL,
        '${DECISION_AT}'
      );
      UPDATE ${FIXTURE_SCHEMA}.license_sessions
         SET last_seen_at = NULL
       WHERE id = '${SESSION_A}'::UUID
    `);

    const nullTouch = await heartbeatDecision(KEY_A, SESSION_A);
    expect(nullTouch).toMatchObject({ status: 'active', session_touched: true });
    expect((await sessionState(SESSION_A))!.last_seen_at.toISOString()).toBe(
      DECISION_AT,
    );

    await sql.unsafe(`
      UPDATE ${FIXTURE_SCHEMA}.license_sessions
         SET last_seen_at = '${futureLastSeen}'
       WHERE id = '${SESSION_A}'::UUID
    `);
    const olderDecision = await heartbeatDecision(KEY_A, SESSION_A);
    expect(new Date(olderDecision.decided_at).toISOString()).toBe(DECISION_AT);
    expect((await sessionState(SESSION_A))!.last_seen_at.toISOString()).toBe(
      futureLastSeen,
    );
  });

  it('never regresses last_seen_at when an older heartbeat finishes after a newer one', async () => {
    await seedKeyAndSession(KEY_A, SESSION_A);
    await sql.unsafe(`
      INSERT INTO ${FIXTURE_SCHEMA}.entitlements (
        id,
        license_key_id,
        status,
        grace_period_ends_at,
        updated_at
      ) VALUES (
        '30000000-0000-4000-8000-000000000032',
        '${KEY_A}',
        'active',
        NULL,
        '${DECISION_AT}'
      )
    `);

    let releaseClockBarrier!: () => void;
    let clockBarrierLocked!: () => void;
    const releaseBarrier = new Promise<void>((resolve) => {
      releaseClockBarrier = resolve;
    });
    const barrierLocked = new Promise<void>((resolve) => {
      clockBarrierLocked = resolve;
    });
    const clockBarrier = sql.begin(async (tx) => {
      await tx.unsafe(
        `SELECT pg_catalog.pg_advisory_xact_lock(${CLOCK_PAUSE_LOCK})`,
      );
      clockBarrierLocked();
      await releaseBarrier;
    });
    await barrierLocked;

    let startOlderHeartbeat!: () => void;
    let olderBackendReady!: (pid: number) => void;
    const startOlder = new Promise<void>((resolve) => {
      startOlderHeartbeat = resolve;
    });
    const olderBackend = new Promise<number>((resolve) => {
      olderBackendReady = resolve;
    });
    const olderHeartbeat = sql.begin(async (tx) => {
      const [backend] = await tx.unsafe<Array<{ pid: number }>>(
        'SELECT pg_catalog.pg_backend_pid() AS pid',
      );
      if (!backend) throw new Error('Older heartbeat backend pid was unavailable');
      olderBackendReady(backend.pid);
      await startOlder;

      const [row] = await tx.unsafe<Array<{ decision: HeartbeatDecision }>>(`
        SELECT ${FIXTURE_SCHEMA}.license_heartbeat_decision(
          '${keyHashFor(KEY_A)}'::TEXT,
          '${SESSION_A}'::UUID
        ) AS decision
      `);
      if (!row) throw new Error('Older heartbeat decision returned no row');
      return row.decision;
    });

    const olderBackendPid = await olderBackend;
    let newerDecision!: HeartbeatDecision;
    try {
      await setClockPause(olderBackendPid, CLOCK_PAUSE_LOCK);
      startOlderHeartbeat();
      await waitForBackendLock(olderBackendPid);

      // The older backend has captured DECISION_AT and is now paused inside the
      // fixture clock, before the production session UPDATE takes its row lock.
      await setDecisionClock(NEWER_DECISION_AT);
      newerDecision = await heartbeatDecision(KEY_A, SESSION_A);

      expect(new Date(newerDecision.decided_at).toISOString()).toBe(
        NEWER_DECISION_AT,
      );
      expect(newerDecision).toMatchObject({
        status: 'active',
        session_touched: true,
      });
      expect((await sessionState(SESSION_A))!.last_seen_at.toISOString()).toBe(
        NEWER_DECISION_AT,
      );
    } finally {
      // Both resolvers are idempotent. Releasing them in cleanup prevents a
      // failed assertion from stranding either transaction.
      startOlderHeartbeat();
      releaseClockBarrier();
      await Promise.allSettled([clockBarrier, olderHeartbeat]);
    }

    const olderDecision = await olderHeartbeat;
    expect(new Date(olderDecision.decided_at).toISOString()).toBe(DECISION_AT);
    expect(olderDecision).toMatchObject({
      status: 'active',
      session_touched: true,
    });
    expect((await sessionState(SESSION_A))!.last_seen_at.toISOString()).toBe(
      NEWER_DECISION_AT,
    );
  });

  it('waits for payment recovery and observes one post-transition entitlement state', async () => {
    await seedKeyAndSession(KEY_A, SESSION_A);
    await sql.unsafe(`
      INSERT INTO ${FIXTURE_SCHEMA}.entitlements (
        id,
        license_key_id,
        status,
        grace_period_ends_at,
        updated_at
      ) VALUES (
        '30000000-0000-4000-8000-000000000041',
        '${KEY_A}',
        'grace_period',
        '${DECISION_AT}'::TIMESTAMPTZ + INTERVAL '1 day',
        '${DECISION_AT}'
      )
    `);

    let releaseRecovery!: () => void;
    let recoveryUpdated!: () => void;
    const release = new Promise<void>((resolve) => {
      releaseRecovery = resolve;
    });
    const updated = new Promise<void>((resolve) => {
      recoveryUpdated = resolve;
    });

    const recovery = sql.begin(async (tx) => {
      await tx.unsafe(`
        UPDATE ${FIXTURE_SCHEMA}.entitlements
           SET status = 'active',
               grace_period_ends_at = NULL,
               updated_at = '${DECISION_AT}'
         WHERE license_key_id = '${KEY_A}'::UUID
      `);
      recoveryUpdated();
      await release;
    });

    await updated;
    let decisionSettled = false;
    const decisionPromise = heartbeatDecision(KEY_A, SESSION_A).then((decision) => {
      decisionSettled = true;
      return decision;
    });

    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(decisionSettled).toBe(false);

    releaseRecovery();
    await recovery;
    const decision = await decisionPromise;
    expect(decision).toMatchObject({
      status: 'active',
      session_touched: true,
    });
  });

  it('cannot touch or validate a session deactivated while the RPC is in flight', async () => {
    await seedKeyAndSession(KEY_A, SESSION_A);
    await sql.unsafe(`
      INSERT INTO ${FIXTURE_SCHEMA}.entitlements (
        id,
        license_key_id,
        status,
        grace_period_ends_at,
        updated_at
      ) VALUES (
        '30000000-0000-4000-8000-000000000051',
        '${KEY_A}',
        'active',
        NULL,
        '${DECISION_AT}'
      )
    `);

    let releaseDeactivation!: () => void;
    let sessionDeactivated!: () => void;
    const release = new Promise<void>((resolve) => {
      releaseDeactivation = resolve;
    });
    const deactivated = new Promise<void>((resolve) => {
      sessionDeactivated = resolve;
    });

    const adminDeactivation = sql.begin(async (tx) => {
      await tx.unsafe(`
        UPDATE ${FIXTURE_SCHEMA}.license_sessions
           SET active = false
         WHERE id = '${SESSION_A}'::UUID
      `);
      sessionDeactivated();
      await release;
    });

    await deactivated;
    let decisionSettled = false;
    const decisionPromise = heartbeatDecision(KEY_A, SESSION_A).then((decision) => {
      decisionSettled = true;
      return decision;
    });

    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(decisionSettled).toBe(false);

    releaseDeactivation();
    await adminDeactivation;
    const decision = await decisionPromise;
    expect(decision).toMatchObject({
      status: 'session_invalidated',
      session_touched: false,
    });
    expect(await sessionState(SESSION_A)).toMatchObject({ active: false });
    expect((await sessionState(SESSION_A))!.last_seen_at.toISOString()).toBe(OLD_LAST_SEEN);
  });

  it('rejects a stale presented hash after an in-flight key rotation commits', async () => {
    await seedKeyAndSession(KEY_A, SESSION_A);
    await sql.unsafe(`
      INSERT INTO ${FIXTURE_SCHEMA}.entitlements (
        id,
        license_key_id,
        status,
        grace_period_ends_at,
        updated_at
      ) VALUES (
        '30000000-0000-4000-8000-000000000061',
        '${KEY_A}',
        'active',
        NULL,
        '${DECISION_AT}'
      )
    `);

    const oldHash = keyHashFor(KEY_A);
    const rotatedHash = `rotated-${KEY_A}`;
    let releaseRotation!: () => void;
    let keyRotated!: () => void;
    const release = new Promise<void>((resolve) => {
      releaseRotation = resolve;
    });
    const rotated = new Promise<void>((resolve) => {
      keyRotated = resolve;
    });

    const rotation = sql.begin(async (tx) => {
      await tx.unsafe(`
        UPDATE ${FIXTURE_SCHEMA}.license_keys
           SET key_hash = '${rotatedHash}'
         WHERE id = '${KEY_A}'::UUID
      `);
      keyRotated();
      await release;
    });

    await rotated;
    let staleDecisionSettled = false;
    const staleDecisionPromise = heartbeatDecisionForHash(oldHash, SESSION_A)
      .then((decision) => {
        staleDecisionSettled = true;
        return decision;
      });

    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(staleDecisionSettled).toBe(false);

    releaseRotation();
    await rotation;
    const stale = await staleDecisionPromise;
    expect(stale).toMatchObject({
      status: 'revoked',
      candidate_count: 0,
      session_touched: false,
    });
    expect((await sessionState(SESSION_A))!.last_seen_at.toISOString()).toBe(OLD_LAST_SEEN);

    const current = await heartbeatDecisionForHash(rotatedHash, SESSION_A);
    expect(current).toMatchObject({
      status: 'active',
      candidate_count: 1,
      session_touched: true,
    });
  });

  it('fails fast instead of deadlocking an opposite-order commerce writer', async () => {
    await seedKeyAndSession(KEY_A, SESSION_A);
    await sql.unsafe(`
      INSERT INTO ${FIXTURE_SCHEMA}.entitlements (
        id,
        license_key_id,
        status,
        grace_period_ends_at,
        updated_at
      ) VALUES (
        '30000000-0000-4000-8000-000000000071',
        '${KEY_A}',
        'active',
        NULL,
        '${DECISION_AT}'
      )
    `);

    let entitlementLocked!: () => void;
    let attemptKeyLock!: () => void;
    const locked = new Promise<void>((resolve) => {
      entitlementLocked = resolve;
    });
    const attemptKey = new Promise<void>((resolve) => {
      attemptKeyLock = resolve;
    });

    const commerceWriter = sql.begin(async (tx) => {
      await tx.unsafe(`
        SELECT id
          FROM ${FIXTURE_SCHEMA}.entitlements
         WHERE license_key_id = '${KEY_A}'::UUID
         FOR UPDATE
      `);
      entitlementLocked();
      await attemptKey;
      await tx.unsafe(`
        SELECT id
          FROM ${FIXTURE_SCHEMA}.license_keys
         WHERE id = '${KEY_A}'::UUID
         FOR UPDATE
      `);
    });

    await locked;
    let heartbeatBackendReady!: (pid: number) => void;
    const heartbeatBackend = new Promise<number>((resolve) => {
      heartbeatBackendReady = resolve;
    });
    const startedAt = Date.now();
    const heartbeatOutcome = sql.begin(async (tx) => {
      const [backend] = await tx.unsafe<Array<{ pid: number }>>(
        'SELECT pg_catalog.pg_backend_pid() AS pid',
      );
      if (!backend) throw new Error('Heartbeat backend pid was unavailable');
      heartbeatBackendReady(backend.pid);
      const [row] = await tx.unsafe<Array<{ decision: HeartbeatDecision }>>(`
        SELECT ${FIXTURE_SCHEMA}.license_heartbeat_decision(
          '${keyHashFor(KEY_A)}'::TEXT,
          '${SESSION_A}'::UUID
        ) AS decision
      `);
      if (!row) throw new Error('Heartbeat decision returned no row');
      return row.decision;
    }).then(
      (decision) => ({ ok: true as const, decision }),
      (error: unknown) => ({ ok: false as const, error }),
    );

    const backendPid = await heartbeatBackend;
    await waitForBackendLock(backendPid);
    attemptKeyLock();

    const outcome = await heartbeatOutcome;
    expect(outcome.ok).toBe(false);
    if (outcome.ok) {
      throw new Error(`Expected lock timeout, got ${outcome.decision.status}`);
    }
    expect(outcome.error).toMatchObject({ code: '55P03' });
    expect(Date.now() - startedAt).toBeLessThan(2_000);

    await commerceWriter;
    expect(await sessionState(SESSION_A)).toMatchObject({
      active: true,
      last_seen_at: new Date(OLD_LAST_SEEN),
    });
  });

  it('allows only service_role to execute the RPC', async () => {
    const [privileges] = await sql.unsafe<Array<{
      anon_execute: boolean;
      authenticated_execute: boolean;
      service_execute: boolean;
    }>>(`
      SELECT
        pg_catalog.has_function_privilege(
          'anon',
          procedure.oid,
          'EXECUTE'
        ) AS anon_execute,
        pg_catalog.has_function_privilege(
          'authenticated',
          procedure.oid,
          'EXECUTE'
        ) AS authenticated_execute,
        pg_catalog.has_function_privilege(
          'service_role',
          procedure.oid,
          'EXECUTE'
        ) AS service_execute
      FROM pg_catalog.pg_proc AS procedure
      JOIN pg_catalog.pg_namespace AS namespace
        ON namespace.oid = procedure.pronamespace
      WHERE namespace.nspname = '${FIXTURE_SCHEMA}'
        AND procedure.proname = 'license_heartbeat_decision'
    `);

    expect(privileges).toEqual({
      anon_execute: false,
      authenticated_execute: false,
      service_execute: true,
    });
  });
});
