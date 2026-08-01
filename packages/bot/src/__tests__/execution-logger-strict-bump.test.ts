/**
 * Round 25 (P2): finalizeStrict wrote truthful history but skipped the
 * fired-counter bookkeeping finalize()/log() perform, so every approved
 * mass action left execution_count / last_executed_at unchanged and the
 * Automations page underreported "Fired Nx". The strict path must bump the
 * counter after a successful history write — and ONLY then, exactly once.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@somnibot/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@somnibot/shared')>()),
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { ExecutionLogger } from '../features/automations/execution-logger.js';

const RESULT = {
  automationId: 'auto-1',
  guildId: 'g1',
  triggeredBy: 'u1',
  triggerEvent: 'member.verified',
  conditionsPassed: true,
  actionsExecuted: 2,
  actionsFailed: 0,
  errors: [] as string[],
  durationMs: 5,
};

function makeSupa(updateOutcome: { data: unknown; error: unknown }) {
  const maybeSingle = vi.fn(async () => updateOutcome);
  const select = vi.fn(() => ({ maybeSingle }));
  const eq = vi.fn(() => ({ select }));
  const update = vi.fn(() => ({ eq }));
  const fallbackEq = vi.fn(async () => ({ error: null }));
  const fallbackUpdate = vi.fn(() => ({ eq: fallbackEq }));
  const rpc = vi.fn(async () => ({ error: null }));
  return {
    _update: update,
    _fallbackUpdate: fallbackUpdate,
    _rpc: rpc,
    from: vi.fn((table: string) => (table === 'automations'
      ? { update: fallbackUpdate }
      : { update })),
    rpc,
  };
}

describe('finalizeStrict fired-counter bookkeeping', () => {
  it('bumps the automation counter after a successful history write', async () => {
    const supa = makeSupa({ data: { id: 'row-1' }, error: null });
    const logger = new ExecutionLogger(supa as never);

    await logger.finalizeStrict('row-1', RESULT);

    expect(supa._update).toHaveBeenCalledTimes(1);
    expect(supa._rpc).toHaveBeenCalledWith('increment_automation_count', {
      automation_uuid: 'auto-1',
    });
  });

  it('skips the bump when the caller already counted this run', async () => {
    const supa = makeSupa({ data: { id: 'row-1' }, error: null });
    const logger = new ExecutionLogger(supa as never);

    await logger.finalizeStrict('row-1', RESULT, { skipCountBump: true });

    // History still overwritten truthfully — only the counter is skipped.
    expect(supa._update).toHaveBeenCalledTimes(1);
    expect(supa._rpc).not.toHaveBeenCalled();
  });

  it('does not bump when the history write fails (strict throw)', async () => {
    const supa = makeSupa({ data: null, error: { message: 'boom' } });
    const logger = new ExecutionLogger(supa as never);

    await expect(logger.finalizeStrict('row-1', RESULT)).rejects.toThrow(
      'Failed to finalize execution: boom',
    );
    expect(supa._rpc).not.toHaveBeenCalled();
  });

  it('does not bump when the row disappeared (strict throw)', async () => {
    const supa = makeSupa({ data: null, error: null });
    const logger = new ExecutionLogger(supa as never);

    await expect(logger.finalizeStrict('row-1', RESULT)).rejects.toThrow(
      'Execution row disappeared before finalization',
    );
    expect(supa._rpc).not.toHaveBeenCalled();
  });

  it('falls back to a last_executed_at touch when the counter RPC errors, without throwing', async () => {
    const supa = makeSupa({ data: { id: 'row-1' }, error: null });
    supa.rpc.mockResolvedValue({ error: { message: 'no rpc' } } as never);
    const logger = new ExecutionLogger(supa as never);

    await logger.finalizeStrict('row-1', RESULT);

    expect(supa._fallbackUpdate).toHaveBeenCalledTimes(1);
  });
});
