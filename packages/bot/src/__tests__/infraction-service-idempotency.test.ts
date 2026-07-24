/**
 * infraction-service.createInfraction — persisted correlation-key idempotency.
 * Guards the fleet finding: a re-delivered /warn must not create a second row.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@somnibot/shared', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { createInfraction } from '../features/moderation/infraction-service.js';

function makeSupabase(insertResult: any, readbackResult: any = { data: null, error: null }) {
  return {
    from: vi.fn(() => {
      const chain: any = {};
      for (const m of ['insert', 'select', 'eq']) chain[m] = vi.fn(() => chain);
      chain.single = vi.fn(async () => insertResult);
      chain.maybeSingle = vi.fn(async () => readbackResult);
      return chain;
    }),
  } as any;
}

const base = {
  guildId: 'g1',
  memberId: 'u1',
  moderatorId: 'mod1',
  type: 'warn' as const,
  reason: 'spam',
  correlationId: 'interaction-123',
};

describe('createInfraction idempotency', () => {
  it('returns the inserted row on first write', async () => {
    const sb = makeSupabase({ data: { id: 'inf1', ...base }, error: null });
    const row = await createInfraction(sb, base);
    expect(row?.id).toBe('inf1');
  });

  it('a replayed write (23505 on correlation key) reads back the original row, not null', async () => {
    const sb = makeSupabase(
      { data: null, error: { code: '23505', message: 'duplicate key' } },
      { data: { id: 'inf-original', ...base }, error: null },
    );
    const row = await createInfraction(sb, base);
    // Dedup no-op: returns the existing row so the caller does not re-fire escalation.
    expect(row?.id).toBe('inf-original');
  });

  it('returns null on a real insert error when no correlation id is supplied', async () => {
    const sb = makeSupabase({ data: null, error: { code: '23505', message: 'dup' } });
    const { correlationId: _drop, ...noCorrelation } = base;
    const row = await createInfraction(sb, noCorrelation);
    expect(row).toBeNull();
  });
});
