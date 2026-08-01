/**
 * Round 33 (P2): recordDiscordOccurrenceChannels is generation-CAS'd. A
 * creator that stalled past the stale threshold no longer owns the
 * occurrence — recovery reclaimed it (bumping updated_at) — and recording
 * anyway overwrote recovery's result AND handed the stalled worker a fresh
 * generation that blessed its ownership insert, committing competing
 * channels. A lost-response retry whose earlier write actually landed is
 * recognized by the row carrying exactly our channel ids.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@somnibot/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@somnibot/shared')>()),
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { recordDiscordOccurrenceChannels } from '../services/occurrence-fence.js';

function makeSupa(outcomes: {
  read: { data: unknown; error: unknown };
  update?: { data: unknown; error: unknown };
  verify?: { data: unknown; error: unknown };
}) {
  let selectCalls = 0;
  const filters: string[][] = [];
  function makeChain(kind: 'read' | 'update') {
    const chain: any = {};
    const applied: string[] = [];
    filters.push(applied);
    for (const method of ['eq', 'select']) {
      chain[method] = vi.fn((...args: unknown[]) => {
        if (method === 'eq') applied.push(String(args[0]));
        return chain;
      });
    }
    chain.update = vi.fn(() => chain);
    chain.maybeSingle = vi.fn(async () => {
      if (kind === 'update') return outcomes.update ?? { data: null, error: null };
      selectCalls += 1;
      // First select = the merge-base read; a later select = the
      // landed-write verification.
      if (selectCalls === 1) return outcomes.read;
      return outcomes.verify ?? { data: null, error: null };
    });
    return chain;
  }
  return {
    _filters: filters,
    from: vi.fn(() => {
      const chain: any = {};
      chain.select = vi.fn(() => makeChain('read'));
      chain.update = vi.fn(() => makeChain('update'));
      return chain;
    }),
  } as any;
}

describe('recordDiscordOccurrenceChannels generation CAS', () => {
  it('records under the owned generation and returns the fresh one', async () => {
    const supa = makeSupa({
      read: { data: { result: {} }, error: null },
      update: { data: { id: 'occ-1', updated_at: '2026-08-01T10:00:05.000Z' }, error: null },
    });

    const out = await recordDiscordOccurrenceChannels(supa, 'occ-1', ['vc-1'], '2026-08-01T10:00:00.000Z');

    expect(out.updatedAt).toBe('2026-08-01T10:00:05.000Z');
    // Both the read and the CAS update filtered on the expected generation.
    expect(supa._filters.some((f: string[]) => f.includes('updated_at'))).toBe(true);
  });

  it('refuses when the generation moved and the row is not our landed write', async () => {
    const supa = makeSupa({
      read: { data: null, error: null },
      verify: {
        data: { status: 'claimed', result: { createdChannelIds: ['someone-elses'] }, updated_at: 'x' },
        error: null,
      },
    });

    await expect(
      recordDiscordOccurrenceChannels(supa, 'occ-1', ['vc-1'], '2026-08-01T10:00:00.000Z'),
    ).rejects.toThrow('no longer claimed or owned by this worker');
  });

  it('adopts the row generation when a lost-response retry finds exactly our ids', async () => {
    const supa = makeSupa({
      read: { data: null, error: null },
      verify: {
        data: {
          status: 'claimed',
          result: { createdChannelIds: ['vc-1', 'tc-1'] },
          updated_at: '2026-08-01T10:00:07.000Z',
        },
        error: null,
      },
    });

    const out = await recordDiscordOccurrenceChannels(
      supa, 'occ-1', ['vc-1', 'tc-1'], '2026-08-01T10:00:00.000Z',
    );

    expect(out.updatedAt).toBe('2026-08-01T10:00:07.000Z');
  });
});
