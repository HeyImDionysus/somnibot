/**
 * Member enrichment error propagation (P2 batch, B4).
 *
 * The three stats queries used to swallow their errors, returning fabricated
 * zeros with success:true — a silently-zeroed members page or CSV export is
 * indistinguishable from real data. Any query error must now throw a typed
 * MemberEnrichmentError for the routes to surface as a 500.
 */
import { describe, it, expect, vi } from 'vitest';

import { enrichMembers, MemberEnrichmentError } from '@/lib/api/member-enrichment';

type TableResult = { data: unknown; error: { message: string } | null };

function chainBuilder(result: TableResult) {
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'in', 'order']) {
    chain[m] = vi.fn().mockReturnValue(chain);
  }
  // Paged reads resolve per .range() call: all rows land on the first page
  // (short page ends the loop). Errors surface on the first page too.
  chain.range = vi.fn((from: number) =>
    Promise.resolve(from === 0 ? result : { data: [], error: null }),
  );
  chain.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
    Promise.resolve(result).then(res, rej);
  return chain;
}

function makeSupabase(results: Partial<Record<string, TableResult>>) {
  return {
    from: vi.fn((table: string) => chainBuilder(results[table] ?? { data: [], error: null })),
  };
}

const IDENTITY_ROWS = [
  { discord_id: '111', username: 'alice', avatar_url: null, roles: [], joined_at: '2026-01-01T00:00:00Z' },
  { discord_id: '222', username: 'bob', avatar_url: null, roles: [], joined_at: '2026-01-02T00:00:00Z' },
];

describe('enrichMembers', () => {
  it('returns [] for empty input without querying', async () => {
    const supabase = makeSupabase({});
    const result = await enrichMembers(supabase as never, 'guild-1', []);
    expect(result).toEqual([]);
    expect(supabase.from).not.toHaveBeenCalled();
  });

  it('joins levels, wallets, and infraction statuses on success', async () => {
    const supabase = makeSupabase({
      member_levels: { data: [{ member_id: '111', xp: 500, level: 3 }], error: null },
      economy_wallets: { data: [{ user_id: '222', wallet: 10, bank: 90, suspended: true }], error: null },
      infractions: {
        data: [
          { member_id: '111', type: 'ban' },
          { member_id: '222', type: 'mute' },
        ],
        error: null,
      },
    });

    const result = await enrichMembers(supabase as never, 'guild-1', IDENTITY_ROWS);

    expect(result[0]).toMatchObject({ id: '111', xp: 500, level: 3, wallet: 0, is_banned: true, is_muted: false });
    expect(result[1]).toMatchObject({ id: '222', xp: 0, wallet: 10, bank: 90, suspended: true, is_muted: true, is_banned: false });
  });

  it.each([
    ['member_levels'],
    ['economy_wallets'],
    ['infractions'],
  ] as const)('throws MemberEnrichmentError when the %s query fails', async (table) => {
    const supabase = makeSupabase({
      [table]: { data: null, error: { message: `${table} exploded` } },
    });

    const attempt = enrichMembers(supabase as never, 'guild-1', IDENTITY_ROWS);

    await expect(attempt).rejects.toBeInstanceOf(MemberEnrichmentError);
    await expect(attempt).rejects.toMatchObject({ source: table });
  });

  it('never fabricates zeros when a query fails', async () => {
    const supabase = makeSupabase({
      economy_wallets: { data: null, error: { message: 'timeout' } },
    });

    await expect(enrichMembers(supabase as never, 'guild-1', IDENTITY_ROWS)).rejects.toThrow(
      'economy_wallets enrichment query failed',
    );
  });
});
