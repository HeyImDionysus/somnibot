/**
 * ExecutionLogger durable-occurrence claim + finalize.
 *
 * claim() stakes a row keyed on the occurrence id BEFORE actions run; a
 * redelivered occurrence's INSERT hits the unique index (23505) → claimed:false
 * so the engine skips it. finalize() updates the claimed row with results.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@somnibot/shared', () => ({
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
  const insert = vi.fn(() => ({ select: vi.fn(() => ({ single: vi.fn(() => Promise.resolve(insertOutcome)) })) }));
  return {
    _update: update,
    from: vi.fn(() => ({ insert, update })),
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
});
