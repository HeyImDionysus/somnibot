/**
 * Stranded pre-action execution claims are reclaimable (review 3689473041).
 *
 * A run whose condition evaluation failed during an outage — and whose release
 * DELETE failed in the same outage — left a pre-action row behind. Every later
 * redelivery of that occurrence hit the unique index (23505) and skipped the
 * automation permanently, with no hold row for the mass-action recovery scan
 * to find. claim() now CAS-deletes provably stale pre-action rows (exact
 * insert defaults + age floor) and retries the insert once.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@somnibot/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@somnibot/shared')>()),
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { ExecutionLogger } from '../features/automations/execution-logger.js';

const PARAMS = {
  automationId: 'auto-1',
  guildId: 'g1',
  triggeredBy: 'user-1',
  triggerEvent: 'member.joined',
  occurrenceId: 'occ-1',
};

function makeSupa(options: {
  /** Every insert conflicts (23505). */
  conflict?: boolean;
  /** Rows the CAS delete removes; [] models a live/finalized row that matched nothing. */
  reclaimRows?: Array<{ id: string }>;
  /** After a successful reclaim, the retried insert succeeds. */
  retryInsertSucceeds?: boolean;
  /** The existing row backs a durable mass-action hold awaiting approval. */
  backingHold?: boolean;
  releaseFailures?: number;
}) {
  let inserts = 0;
  let releaseAttempts = 0;
  const deleteFilters: Record<string, unknown>[] = [];
  const reclaimCalls: Array<Record<string, unknown>> = [];
  const from = vi.fn((table: string) => {
    const filters: Record<string, unknown> = {};
    const chain: any = {};
    for (const m of ['select', 'order', 'limit']) chain[m] = vi.fn(() => chain);
    chain.maybeSingle = vi.fn(async () => {
      if (table === 'automation_mass_action_holds') {
        return { data: options.backingHold ? { id: 'hold-1' } : null, error: null };
      }
      // Candidate lookup for the reclaim guard: the conflicting row exists.
      return { data: { id: 'existing-row' }, error: null };
    });
    chain.eq = vi.fn((column: string, value: unknown) => { filters[column] = value; return chain; });
    chain.lt = vi.fn((column: string, value: unknown) => { filters[`lt:${column}`] = value; return chain; });
    chain.insert = vi.fn(() => {
      inserts++;
      chain._isInsert = true;
      return chain;
    });
    chain.delete = vi.fn(() => { chain._isDelete = true; return chain; });
    chain.update = vi.fn(() => chain);
    chain.single = vi.fn(async () => {
      if (chain._isInsert) {
        const isRetry = inserts > 1;
        if (options.conflict && (!isRetry || !options.retryInsertSucceeds)) {
          return { data: null, error: { code: '23505', message: 'duplicate key value' } };
        }
        return { data: { id: `row-${inserts}` }, error: null };
      }
      return { data: null, error: null };
    });
    chain.then = (resolve: (v: unknown) => void) => {
      if (chain._isDelete) {
        if (filters.id) {
          // release() path — delete by row id.
          releaseAttempts++;
          if ((options.releaseFailures ?? 0) >= releaseAttempts) {
            return resolve({ data: null, error: { message: 'db unavailable' } });
          }
          return resolve({ data: null, error: null });
        }
        deleteFilters.push({ ...filters });
        return resolve({ data: options.reclaimRows ?? [], error: null });
      }
      return resolve({ data: null, error: null });
    };
    return chain;
  });
  const rpc = vi.fn(async (name: string, args: Record<string, unknown>) => {
    if (name === 'finalize_stale_started_automation_execution') {
      // Round 27: a failed reclaim legitimately falls through to the
      // started-claim finalizer. Neutral here — these suites exercise the
      // reclaim CAS itself.
      return { data: false, error: null };
    }
    if (name !== 'reclaim_stale_automation_execution') {
      throw new Error(`Unexpected RPC ${name}`);
    }
    reclaimCalls.push(args);
    // The atomic statement's verdict: hold-backed or live/finalized rows match
    // nothing; only a genuinely stranded pre-action row is removed.
    const removed = !options.backingHold && (options.reclaimRows ?? []).length > 0;
    return { data: removed, error: null };
  });
  return {
    supabase: { from, rpc } as any,
    counts: () => ({ inserts, releaseAttempts }),
    deleteFilters,
    reclaimCalls,
  };
}

describe('ExecutionLogger.claim — stale pre-action reclaim', () => {
  it('reclaims a stranded pre-action row and wins the retried insert', async () => {
    const { supabase, counts, reclaimCalls } = makeSupa({
      conflict: true,
      reclaimRows: [{ id: 'stale-row' }],
      retryInsertSucceeds: true,
    });
    const logger = new ExecutionLogger(supabase);

    const result = await logger.claim(PARAMS);

    expect(result.claimed).toBe(true);
    expect(counts().inserts).toBe(2);
    // The atomic reclaim carries the full claim identity plus the age floor;
    // the defaults + hold NOT EXISTS live inside the SQL statement itself.
    expect(reclaimCalls[0]).toMatchObject({
      p_guild_id: 'g1',
      p_automation_id: 'auto-1',
      p_occurrence_id: 'occ-1',
    });
    expect(typeof reclaimCalls[0]!.p_stale_before).toBe('string');
  });

  it('stays skipped when the existing row is live or finalized (CAS matches nothing)', async () => {
    const { supabase, counts } = makeSupa({ conflict: true, reclaimRows: [] });
    const logger = new ExecutionLogger(supabase);

    const result = await logger.claim(PARAMS);

    expect(result.claimed).toBe(false);
    expect(counts().inserts).toBe(1); // no blind retry without a reclaimed row
  });

  it('concedes when the retried insert loses to another shard', async () => {
    const { supabase } = makeSupa({
      conflict: true,
      reclaimRows: [{ id: 'stale-row' }],
      retryInsertSucceeds: false,
    });
    const logger = new ExecutionLogger(supabase);

    const result = await logger.claim(PARAMS);

    expect(result.claimed).toBe(false);
  });
});

describe('ExecutionLogger.release — transient failures retry before throwing', () => {
  it('survives two transient failures', async () => {
    const { supabase, counts } = makeSupa({ releaseFailures: 2 });
    const logger = new ExecutionLogger(supabase);

    await expect(logger.release('row-1')).resolves.toBeUndefined();
    expect(counts().releaseAttempts).toBe(3);
  });

  it('throws once retries are exhausted so the caller still hears about it', async () => {
    const { supabase } = makeSupa({ releaseFailures: 99 });
    const logger = new ExecutionLogger(supabase);

    await expect(logger.release('row-1')).rejects.toThrow('Failed to release');
  });
});

describe('ExecutionLogger.claim — held executions are never reclaimed', () => {
  it('skips instead of deleting a claim that backs a mass-action hold', async () => {
    // A held execution stays pre-action shaped for as long as approval takes —
    // hours, legitimately. Reclaiming it would ON DELETE SET NULL the hold's
    // execution_id, detach the approval log, and strand the replacement claim.
    const { supabase, counts, deleteFilters } = makeSupa({
      conflict: true,
      reclaimRows: [{ id: 'stale-row' }],
      retryInsertSucceeds: true,
      backingHold: true,
    });
    const logger = new ExecutionLogger(supabase);

    const result = await logger.claim(PARAMS);

    expect(result.claimed).toBe(false);
    expect(counts().inserts).toBe(1);
    // The hold guard is INSIDE the atomic statement (NOT EXISTS evaluated by
    // the same DELETE), so the RPC runs but removes nothing — no blind retry.
    expect(deleteFilters).toHaveLength(0);
  });
});
