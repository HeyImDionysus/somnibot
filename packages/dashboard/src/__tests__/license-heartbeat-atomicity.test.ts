/**
 * Regression coverage for the heartbeat entitlement decision.
 *
 * The decision must come from one database statement. Separate active, grace,
 * and fallback reads can observe different versions of the same row during a
 * payment-recovery transition and incorrectly revoke a paying customer.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/supabase/admin', () => ({ createAdminSupabase: vi.fn() }));
vi.mock('@/lib/api/rate-limit', () => ({
  rateLimits: {
    licenseHeartbeat: vi.fn().mockResolvedValue({
      limited: false,
      remaining: 19,
      retryAfterMs: 0,
    }),
  },
}));

import { POST as heartbeatPost } from '@/app/api/license/heartbeat/route';
import { createAdminSupabase } from '@/lib/supabase/admin';
import {
  buildRequest,
  createMockSupabase,
  registerTable,
} from './helpers';

const PRODUCT_ID = '00000000-0000-4000-a000-000000000001';
const SESSION_ID = '00000000-0000-4000-a000-0000000000aa';
const NOW = new Date('2026-07-27T12:00:00.000Z');
const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const HEARTBEAT_MIGRATION = readFileSync(
  resolve(
    TEST_DIR,
    '../../../supabase/migrations/20260727034500_license_heartbeat_decision.sql',
  ),
  'utf8',
);

type EntitlementState = {
  id: string;
  status: 'active' | 'grace_period' | 'cancelled';
  grace_period_ends_at: string | null;
  updated_at: string;
};

type Scenario = {
  initial: EntitlementState;
  transitionAfterFirstLegacyRead?: EntitlementState;
  transitionDuringAtomicDecision?: EntitlementState;
  advanceClockBeforeLegacyGraceResult?: Date;
  advanceClockBeforeAtomicDecision?: Date;
};

function decisionFor(entitlement: EntitlementState, decisionAt: string) {
  const lapsedGrace = entitlement.status === 'grace_period'
    && entitlement.grace_period_ends_at !== null
    && entitlement.grace_period_ends_at < decisionAt;
  const status = lapsedGrace ? 'expired' : entitlement.status;

  return {
    entitlement_id: entitlement.id,
    status,
    grace_period_ends_at: entitlement.grace_period_ends_at,
    decided_at: decisionAt,
    candidate_count: 1,
    session_touched: status === 'active' || status === 'grace_period',
    next_heartbeat_seconds: 300,
  };
}

function setupScenario(scenario: Scenario) {
  const mock = createMockSupabase();
  let state = scenario.initial;
  let legacyReadCount = 0;
  let legacyClockAdvanced = false;

  const keys = registerTable(mock, 'license_keys');
  keys.maybeSingle.mockResolvedValue({
    data: { id: 'key-1', status: 'active', product_id: PRODUCT_ID },
    error: null,
  });

  const sessions = registerTable(mock, 'license_sessions');
  sessions.maybeSingle.mockResolvedValue({
    data: { id: SESSION_ID, active: true },
    error: null,
  });
  sessions.then = vi.fn().mockImplementation((resolve) =>
    resolve?.({ data: null, error: null, count: null }),
  );

  const config = registerTable(mock, 'product_license_config');
  config.maybeSingle.mockResolvedValue({
    data: { heartbeat_interval_seconds: 300 },
    error: null,
  });

  function legacyEntitlementQuery() {
    const query = registerTable(createMockSupabase(), 'entitlements');
    let requiredStatus: string | null = null;
    const excludedStatuses = new Set<string>();
    let graceAfter: string | null = null;

    query.eq.mockImplementation((column: string, value: unknown) => {
      if (column === 'status') requiredStatus = String(value);
      return query;
    });
    query.neq.mockImplementation((column: string, value: unknown) => {
      if (column === 'status') excludedStatuses.add(String(value));
      return query;
    });
    query.gt.mockImplementation((column: string, value: string) => {
      if (column === 'grace_period_ends_at') graceAfter = value;
      return query;
    });
    query.maybeSingle.mockImplementation(async () => {
      legacyReadCount += 1;
      const observed = state;

      if (
        graceAfter
        && scenario.advanceClockBeforeLegacyGraceResult
        && !legacyClockAdvanced
      ) {
        // The old route captured its comparison clock before this query
        // completed. Move real time beyond the deadline while preserving that
        // stale filter value to reproduce the acceptance bug.
        vi.setSystemTime(scenario.advanceClockBeforeLegacyGraceResult);
        legacyClockAdvanced = true;
      }

      const matchesStatus = requiredStatus === null || observed.status === requiredStatus;
      const survivesExclusions = !excludedStatuses.has(observed.status);
      const survivesGraceClock = graceAfter === null
        || (
          observed.grace_period_ends_at !== null
          && observed.grace_period_ends_at > graceAfter
        );
      const data = matchesStatus && survivesExclusions && survivesGraceClock
        ? observed
        : null;

      if (legacyReadCount === 1 && scenario.transitionAfterFirstLegacyRead) {
        state = scenario.transitionAfterFirstLegacyRead;
      }

      return { data, error: null };
    });

    return query;
  }

  mock.from.mockImplementation((table: string) => {
    if (table === 'entitlements') return legacyEntitlementQuery();
    if (table === 'license_keys') return keys;
    if (table === 'license_sessions') return sessions;
    if (table === 'product_license_config') return config;
    return mock._query;
  });

  mock.rpc.mockImplementation(async (fn: string) => {
    if (fn !== 'license_heartbeat_decision') {
      return { data: null, error: { message: `Unexpected RPC: ${fn}` } };
    }
    if (scenario.transitionDuringAtomicDecision) {
      state = scenario.transitionDuringAtomicDecision;
    }
    if (scenario.advanceClockBeforeAtomicDecision) {
      vi.setSystemTime(scenario.advanceClockBeforeAtomicDecision);
    }
    return {
      data: decisionFor(state, new Date().toISOString()),
      error: null,
    };
  });

  vi.mocked(createAdminSupabase).mockReturnValue(mock as never);
  return { mock, sessions };
}

function heartbeatRequest() {
  return buildRequest('/api/license/heartbeat', {
    method: 'POST',
    body: {
      license_key: 'SOMNI-TEST-1234-ABCD',
      session_id: SESSION_ID,
    },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('POST /api/license/heartbeat — atomic entitlement decision', () => {
  it('does not revoke when payment recovery changes grace_period to active between legacy reads', async () => {
    const futureDeadline = new Date(NOW.getTime() + 60_000).toISOString();
    const active: EntitlementState = {
      id: 'ent-1',
      status: 'active',
      grace_period_ends_at: null,
      updated_at: NOW.toISOString(),
    };
    const { mock } = setupScenario({
      initial: {
        id: 'ent-1',
        status: 'grace_period',
        grace_period_ends_at: futureDeadline,
        updated_at: NOW.toISOString(),
      },
      // With separate reads: active sees no row, then recovery commits, then
      // grace/fallback reads exclude the now-active row and return "revoked".
      transitionAfterFirstLegacyRead: active,
      // One database statement observes the recovered row consistently.
      transitionDuringAtomicDecision: active,
    });

    const body = await (await heartbeatPost(heartbeatRequest() as never)).json();

    expect(body).toMatchObject({ valid: true, status: 'active' });
    expect(mock.rpc).toHaveBeenCalledWith('license_heartbeat_decision', {
      p_key_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
      p_session_id: SESSION_ID,
    });
    expect(mock.from).not.toHaveBeenCalledWith('license_keys');
    expect(mock.from).not.toHaveBeenCalledWith('entitlements');
    expect(mock.from).not.toHaveBeenCalledWith('license_sessions');
  });

  it('keeps grace live when its deadline equals the database decision time', async () => {
    const deadline = NOW.toISOString();
    const { mock } = setupScenario({
      initial: {
        id: 'ent-1',
        status: 'grace_period',
        grace_period_ends_at: deadline,
        updated_at: NOW.toISOString(),
      },
    });

    const body = await (await heartbeatPost(heartbeatRequest() as never)).json();

    expect(body).toMatchObject({
      valid: true,
      status: 'grace_period',
      grace_period_ends_at: deadline,
    });
    expect(mock.rpc).toHaveBeenCalledOnce();
  });

  it('uses the database decision clock after query delay instead of a stale pre-query clock', async () => {
    const deadline = new Date(NOW.getTime() + 60_000).toISOString();
    const afterDeadline = new Date(NOW.getTime() + 120_000);
    const { sessions } = setupScenario({
      initial: {
        id: 'ent-1',
        status: 'grace_period',
        grace_period_ends_at: deadline,
        updated_at: NOW.toISOString(),
      },
      advanceClockBeforeLegacyGraceResult: afterDeadline,
      advanceClockBeforeAtomicDecision: afterDeadline,
    });

    const body = await (await heartbeatPost(heartbeatRequest() as never)).json();

    expect(body).toMatchObject({
      valid: false,
      status: 'expired',
      next_heartbeat_seconds: 0,
    });
    expect(sessions.update).not.toHaveBeenCalled();
  });

  it('returns service_unavailable for a live verdict that did not atomically touch the session', async () => {
    const { mock } = setupScenario({
      initial: {
        id: 'ent-1',
        status: 'active',
        grace_period_ends_at: null,
        updated_at: NOW.toISOString(),
      },
    });
    mock.rpc.mockResolvedValue({
      data: {
        ...decisionFor({
          id: 'ent-1',
          status: 'active',
          grace_period_ends_at: null,
          updated_at: NOW.toISOString(),
        }, NOW.toISOString()),
        session_touched: false,
      },
      error: null,
    });

    const response = await heartbeatPost(heartbeatRequest() as never);
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body).toMatchObject({
      valid: false,
      status: 'service_unavailable',
      retryable: true,
      next_heartbeat_seconds: 0,
    });
  });

  it('fails soft when lock contention aborts the atomic decision', async () => {
    const { mock } = setupScenario({
      initial: {
        id: 'ent-1',
        status: 'active',
        grace_period_ends_at: null,
        updated_at: NOW.toISOString(),
      },
    });
    mock.rpc.mockResolvedValue({
      data: null,
      error: {
        code: '55P03',
        message: 'canceling statement due to lock timeout',
      },
    });

    const response = await heartbeatPost(heartbeatRequest() as never);
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body).toMatchObject({
      valid: false,
      status: 'service_unavailable',
      retryable: true,
      next_heartbeat_seconds: 0,
    });
  });
});

describe('license_heartbeat_decision migration contract', () => {
  it('implements the whole decision as one SQL statement over locked, materialized rows', () => {
    const bodyMatch = HEARTBEAT_MIGRATION.match(/AS \$\$([\s\S]*?)\$\$;/);
    expect(bodyMatch).not.toBeNull();
    const executableBody = bodyMatch![1]!
      .replace(/^\s*--.*$/gm, '')
      .trim();

    expect(executableBody).toMatch(/^WITH key_snapshot AS MATERIALIZED/);
    expect(executableBody.match(/;/g)).toHaveLength(1);
    expect(executableBody).toContain('candidate_entitlements AS MATERIALIZED');
    expect(executableBody).toContain('FOR SHARE OF entitlement');
    expect(executableBody).toContain('pg_catalog.count(*) AS candidate_count');
    expect(executableBody).toContain("'candidate_count', decision.candidate_count");
    expect(executableBody).not.toMatch(/\bFROM\s+public\.entitlements[\s\S]*;\s*SELECT\b/i);
    expect(HEARTBEAT_MIGRATION).toContain("SET lock_timeout = '500ms'");
  });

  it('takes its clock after materializing candidates and lapses grace only on strict less-than', () => {
    const candidatesAt = HEARTBEAT_MIGRATION.indexOf(
      'candidate_entitlements AS MATERIALIZED',
    );
    const clockAt = HEARTBEAT_MIGRATION.indexOf(
      'decision_clock AS MATERIALIZED',
    );

    expect(candidatesAt).toBeGreaterThan(-1);
    expect(clockAt).toBeGreaterThan(candidatesAt);
    expect(HEARTBEAT_MIGRATION).toContain('pg_catalog.clock_timestamp() AS decision_at');
    expect(HEARTBEAT_MIGRATION).toContain(
      'NOT (candidate.grace_period_ends_at < clock.decision_at)',
    );
    expect(HEARTBEAT_MIGRATION).toContain(
      'chosen.grace_period_ends_at < chosen.decision_at',
    );
    expect(HEARTBEAT_MIGRATION).not.toMatch(/grace_period_ends_at\s*<=/);
    expect(HEARTBEAT_MIGRATION).not.toMatch(/\bp_decision_(?:at|time)\b/i);
  });

  it('CAS-touches only the same active session and exposes the RPC only to service_role', () => {
    expect(HEARTBEAT_MIGRATION).toContain(
      'CREATE OR REPLACE FUNCTION public.license_heartbeat_decision(',
    );
    expect(HEARTBEAT_MIGRATION).toContain('p_key_hash TEXT');
    expect(HEARTBEAT_MIGRATION).toContain('key.key_hash = p_key_hash');
    expect(HEARTBEAT_MIGRATION).toContain('p_session_id UUID');
    expect(HEARTBEAT_MIGRATION).toContain('touched_session AS MATERIALIZED');
    expect(HEARTBEAT_MIGRATION).toContain('session.id = p_session_id');
    expect(HEARTBEAT_MIGRATION).toContain(
      'session.license_key_id = key.id',
    );
    expect(HEARTBEAT_MIGRATION).toContain('session.active = true');
    expect(HEARTBEAT_MIGRATION).toContain(
      'COALESCE(session.last_seen_at, decision.decision_at)',
    );
    expect(HEARTBEAT_MIGRATION).toMatch(
      /SET last_seen_at = GREATEST\(\s*COALESCE\(session\.last_seen_at,\s*decision\.decision_at\),\s*decision\.decision_at\s*\)/,
    );
    expect(HEARTBEAT_MIGRATION).toContain(
      'GRANT EXECUTE ON FUNCTION public.license_heartbeat_decision(TEXT, UUID)',
    );
    expect(HEARTBEAT_MIGRATION).toContain('TO service_role;');
    expect(HEARTBEAT_MIGRATION).toContain('FROM PUBLIC, anon, authenticated;');
  });
});
