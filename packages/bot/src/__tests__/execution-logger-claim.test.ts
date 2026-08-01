/**
 * ExecutionLogger durable-occurrence claim + finalize.
 *
 * claim() stakes a row keyed on the occurrence id BEFORE actions run; a
 * redelivered occurrence's INSERT hits the unique index (23505) → claimed:false
 * so the engine skips it. finalize() updates the claimed row with results.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@somnibot/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@somnibot/shared')>()),
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { ExecutionLogger } from '../features/automations/execution-logger.js';

const CLAIM = {
  automationId: 'auto-1',
  guildId: 'g1',
  triggeredBy: 'u1',
  triggerEvent: 'message.sent',
  occurrenceId: 'occ-1',
};

const RESULT = {
  automationId: 'auto-1',
  guildId: 'g1',
  triggeredBy: 'u1',
  triggerEvent: 'message.sent',
  conditionsPassed: true,
  actionsExecuted: 1,
  actionsFailed: 0,
  errors: [],
  durationMs: 5,
};

/** Supabase stub whose insert→select→single resolves to the given claim outcome. */
function makeSupa(insertOutcome: { data: unknown; error: unknown }) {
  const update = vi.fn(() => ({ eq: vi.fn(() => Promise.resolve({ error: null })) }));
  // The delete chain must be fully chainable: claim()'s stale-pre-action
  // reclaim now traverses .delete().eq()x7.lt().select() before resolving.
  // Resolving zero rows models "the existing row is live/finalized" — the
  // reclaim matches nothing and the claim stays skipped, which is exactly what
  // this suite asserts.
  const removeChain: any = {};
  const removeEq = vi.fn(() => removeChain);
  removeChain.eq = removeEq;
  removeChain.lt = vi.fn(() => removeChain);
  removeChain.select = vi.fn(() => removeChain);
  removeChain.then = (resolve: (v: unknown) => void) => resolve({ data: [], error: null });
  const remove = vi.fn(() => removeChain);
  const insert = vi.fn(() => ({ select: vi.fn(() => ({ single: vi.fn(() => Promise.resolve(insertOutcome)) })) }));
  const selectChain: any = {};
  selectChain.eq = vi.fn(() => selectChain);
  selectChain.maybeSingle = vi.fn(async () => ({ data: null, error: null }));
  return {
    _update: update,
    _remove: remove,
    _removeEq: removeEq,
    // The reclaim guard's candidate/hold lookups: resolving no candidate row
    // keeps the 23505 as a plain already-claimed skip, which is this suite's
    // subject.
    from: vi.fn(() => ({ insert, update, delete: remove, select: vi.fn(() => selectChain) })),
    rpc: vi.fn().mockResolvedValue({ error: null }),
  } as any;
}

describe('ExecutionLogger occurrence claim', () => {
  it('claims a fresh occurrence and returns its row id', async () => {
    const logger = new ExecutionLogger(makeSupa({ data: { id: 'row-1' }, error: null }));
    const res = await logger.claim(CLAIM);
    expect(res).toEqual({ claimed: true, rowId: 'row-1' });
  });

  it('treats a 23505 unique-violation as an already-claimed occurrence (skip)', async () => {
    const logger = new ExecutionLogger(makeSupa({ data: null, error: { code: '23505', message: 'dup' } }));
    const res = await logger.claim(CLAIM);
    expect(res).toEqual({ claimed: false, rowId: null });
  });

  it('allows processing (no dedup) when the claim insert errors for another reason', async () => {
    const logger = new ExecutionLogger(makeSupa({ data: null, error: { code: '42501', message: 'nope' } }));
    const res = await logger.claim(CLAIM);
    expect(res).toEqual({ claimed: true, rowId: null });
  });

  it('finalize updates the claimed row by id', async () => {
    const supa = makeSupa({ data: { id: 'row-1' }, error: null });
    const logger = new ExecutionLogger(supa);
    await logger.finalize('row-1', RESULT);
    expect(supa._update).toHaveBeenCalled();
  });

  it('terminalizes a stale STARTED claim as interrupted on redelivery (round 27)', async () => {
    // A worker that died between the actions marker and finalize leaves the
    // row pre-action shaped forever: the reclaim refuses marked rows by
    // design and no later writer exists. The redelivery must invoke the
    // interrupted-finalize RPC — and still never re-run the occurrence.
    const supa = makeSupa({ data: null, error: { code: '23505', message: 'dup' } });
    supa.rpc = vi.fn(async (fn: string) => {
      if (fn === 'reclaim_stale_automation_execution') return { data: false, error: null };
      if (fn === 'finalize_stale_started_automation_execution') return { data: true, error: null };
      return { data: null, error: null };
    });
    const logger = new ExecutionLogger(supa);

    const res = await logger.claim(CLAIM);

    expect(res).toEqual({ claimed: false, rowId: null });
    const finalizeCall = (supa.rpc as ReturnType<typeof vi.fn>).mock.calls
      .find((call: unknown[]) => call[0] === 'finalize_stale_started_automation_execution');
    expect(finalizeCall).toBeDefined();
    expect((finalizeCall![1] as Record<string, unknown>).p_occurrence_id).toBe(CLAIM.occurrenceId);
    expect((finalizeCall![1] as Record<string, unknown>).p_automation_id).toBe(CLAIM.automationId);
  });

  it('skips started-claim finalization when the pre-action reclaim already removed the row', async () => {
    const supa = makeSupa({ data: null, error: { code: '23505', message: 'dup' } });
    supa.rpc = vi.fn(async (fn: string) => {
      if (fn === 'reclaim_stale_automation_execution') return { data: true, error: null };
      return { data: null, error: null };
    });
    const logger = new ExecutionLogger(supa);

    await logger.claim(CLAIM);

    const calls = (supa.rpc as ReturnType<typeof vi.fn>).mock.calls.map((call: unknown[]) => call[0]);
    expect(calls).not.toContain('finalize_stale_started_automation_execution');
  });

  it('classifies occurrence rows through the cheap pre-check (rounds 30-31)', async () => {
    const supa = makeSupa({ data: { id: 'row-1' }, error: null });
    const selectChain: any = {};
    selectChain.eq = vi.fn(() => selectChain);
    selectChain.limit = vi.fn(() => selectChain);
    const holdChain: any = {};
    holdChain.eq = vi.fn(() => holdChain);
    holdChain.limit = vi.fn(() => holdChain);
    holdChain.maybeSingle = vi.fn(async () => ({ data: null, error: null }));
    supa.from = vi.fn((table: string) => (table === 'automation_mass_action_holds'
      ? { select: vi.fn(() => holdChain) }
      : { select: vi.fn(() => selectChain) }));
    const logger = new ExecutionLogger(supa);
    const row = (overrides: Record<string, unknown>) => ({
      actions_started: false,
      conditions_passed: false,
      actions_executed: 0,
      actions_failed: 0,
      duration_ms: 0,
      created_at: new Date().toISOString(),
      ...overrides,
    });

    // Executed/terminal rows: consumed (skip before quota spend).
    selectChain.maybeSingle = vi.fn(async () => ({
      data: row({ conditions_passed: true, actions_executed: 1, duration_ms: 5 }),
      error: null,
    }));
    await expect(logger.isOccurrenceConsumed('auto-1', 'g1', 'occ-1')).resolves.toBe(true);

    // STARTED rows: consumed — the sweep owns their recovery.
    selectChain.maybeSingle = vi.fn(async () => ({
      data: row({ actions_started: true }),
      error: null,
    }));
    await expect(logger.isOccurrenceConsumed('auto-1', 'g1', 'occ-1')).resolves.toBe(true);

    // FRESH pre-action row: another worker mid-run — skip quota-free.
    selectChain.maybeSingle = vi.fn(async () => ({ data: row({}), error: null }));
    await expect(logger.isOccurrenceConsumed('auto-1', 'g1', 'occ-1')).resolves.toBe(true);

    // STALE pre-action row (round 31): a STRANDED claim must fall through to
    // claim() so its 23505 reclaim path can re-run the occurrence — the
    // startup sweep repairs only started rows. Round 32: that verdict now
    // requires NO durable hold to be linked (holdChain below returns none).
    selectChain.maybeSingle = vi.fn(async () => ({
      data: row({ id: 'row-1', created_at: new Date(Date.now() - 60 * 60_000).toISOString() }),
      error: null,
    }));
    holdChain.maybeSingle = vi.fn(async () => ({ data: null, error: null }));
    await expect(logger.isOccurrenceConsumed('auto-1', 'g1', 'occ-1')).resolves.toBe(false);

    // Round 32: a HELD execution keeps the pre-action shape for as long as
    // approval takes — its redeliveries must skip quota-free, not round-trip
    // to a refusing claim().
    holdChain.maybeSingle = vi.fn(async () => ({ data: { id: 'hold-1' }, error: null }));
    await expect(logger.isOccurrenceConsumed('auto-1', 'g1', 'occ-1')).resolves.toBe(true);
    holdChain.maybeSingle = vi.fn(async () => ({ data: null, error: null }));

    // No row / read errors: fail open — the claim INSERT stays authoritative.
    selectChain.maybeSingle = vi.fn(async () => ({ data: null, error: null }));
    await expect(logger.isOccurrenceConsumed('auto-1', 'g1', 'occ-1')).resolves.toBe(false);
    selectChain.maybeSingle = vi.fn(async () => ({ data: null, error: { message: 'down' } }));
    await expect(logger.isOccurrenceConsumed('auto-1', 'g1', 'occ-1')).resolves.toBe(false);
  });

  it('sweeps stale started executions guild-wide via the plural RPC (round 28)', async () => {
    const supa = makeSupa({ data: { id: 'row-1' }, error: null });
    supa.rpc = vi.fn(async () => ({ data: 3, error: null }));
    const logger = new ExecutionLogger(supa);

    await expect(logger.finalizeStaleStartedSweep('g1')).resolves.toBe(3);

    expect(supa.rpc).toHaveBeenCalledWith(
      'finalize_stale_started_automation_executions',
      expect.objectContaining({ p_guild_id: 'g1' }),
    );
  });

  it('releases a proven-unused occurrence claim by row id', async () => {
    const supa = makeSupa({ data: { id: 'row-1' }, error: null });
    const logger = new ExecutionLogger(supa);
    await logger.release('row-1');
    expect(supa._remove).toHaveBeenCalledTimes(1);
    expect(supa._removeEq).toHaveBeenCalledWith('id', 'row-1');
  });
});
