/**
 * Anti-raid — raid mode survives a bot restart.
 *
 * THE DEFECT THIS PINS: raid mode lived only in Valkey (5-minute PX) with an
 * in-memory fallback. Both die with the process, so restarting mid-raid — the
 * moment an operator is MOST likely to restart — lost everything at once:
 * containment stopped, any lockdown stayed pinned at "Very High" with invites
 * paused and nothing scheduled to undo it, and members banned during the raid
 * were never unbanned.
 *
 * The durable row (migration 20260727003000) is the recovery record. Valkey
 * stays the hot path.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@somnibot/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@somnibot/shared')>()),
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const { mockValkeySet, mockValkeyGet } = vi.hoisted(() => ({
  mockValkeySet: vi.fn(async () => 'OK'),
  mockValkeyGet: vi.fn(async () => null),
}));
vi.mock('../services/valkey.js', () => ({
  getValkey: () => ({ set: mockValkeySet, get: mockValkeyGet, del: vi.fn(), pipeline: vi.fn() }),
}));

import { resumeRaidState } from '../features/anti-raid/index.js';

/** Supabase stub serving (or refusing) one anti_raid_state row. */
function makeSupa(opts: {
  row?: { expires_at: string; trigger_joins?: number } | null;
  readError?: { message: string } | null;
  throws?: boolean;
} = {}) {
  const deletes: string[] = [];
  const from = vi.fn((table: string) => {
    if (opts.throws) throw new Error('connection reset');
    const chain: Record<string, unknown> = {};
    chain.select = vi.fn(() => chain);
    chain.eq = vi.fn((_col: string, val: unknown) => {
      if (table === 'anti_raid_state') deletes.push(String(val));
      return chain;
    });
    chain.delete = vi.fn(() => chain);
    chain.maybeSingle = vi.fn(async () => ({
      data: opts.row === undefined ? null : opts.row,
      error: opts.readError ?? null,
    }));
    return chain;
  });
  return { supabase: { from } as never, deletes };
}

const guild = { id: 'guild-1', name: 'Test' } as never;

beforeEach(() => {
  vi.clearAllMocks();
  mockValkeySet.mockResolvedValue('OK' as never);
});

describe('resumeRaidState', () => {
  it('re-arms containment for the REMAINING time when a raid is still live', async () => {
    // 90 seconds left of the 5-minute window.
    const expires = new Date(Date.now() + 90_000).toISOString();
    const { supabase } = makeSupa({ row: { expires_at: expires, trigger_joins: 14 } });

    const result = await resumeRaidState(guild, supabase);

    expect(result).toBe('resumed');
    expect(mockValkeySet).toHaveBeenCalledTimes(1);
    const [, , mode, ttl] = mockValkeySet.mock.calls[0] as unknown as [string, string, string, number];
    expect(mode).toBe('PX');
    // Re-arming for the FULL window would extend a raid past its real end.
    expect(ttl).toBeGreaterThan(80_000);
    expect(ttl).toBeLessThanOrEqual(90_000);
  });

  it('does NOT re-enter raid mode for a raid that already ended', async () => {
    const expires = new Date(Date.now() - 60_000).toISOString();
    const { supabase, deletes } = makeSupa({ row: { expires_at: expires } });

    const result = await resumeRaidState(guild, supabase);

    expect(result).toBe('expired');
    // Re-arming here would contain joins for a raid that is over.
    expect(mockValkeySet).not.toHaveBeenCalled();
    // And the record is cleared so the next join takes the ordinary
    // "raid is over" branch that restores verification and sweeps unbans.
    expect(deletes).toContain('guild-1');
  });

  it('does nothing when there is no raid on record', async () => {
    const { supabase } = makeSupa({ row: null });
    expect(await resumeRaidState(guild, supabase)).toBe('none');
    expect(mockValkeySet).not.toHaveBeenCalled();
  });

  it('does nothing on a read error rather than guessing', async () => {
    const { supabase } = makeSupa({ readError: { message: 'connection reset' } });
    expect(await resumeRaidState(guild, supabase)).toBe('none');
    expect(mockValkeySet).not.toHaveBeenCalled();
  });

  it('never throws when the database is unreachable', async () => {
    const { supabase } = makeSupa({ throws: true });
    // Boot must not be blocked by a failed recovery read.
    await expect(resumeRaidState(guild, supabase)).resolves.toBe('none');
  });

  it('ignores a corrupt expiry instead of re-arming forever', async () => {
    const { supabase, deletes } = makeSupa({ row: { expires_at: 'not-a-date' } });

    const result = await resumeRaidState(guild, supabase);

    // A NaN remaining time must not become an infinite or negative TTL.
    expect(result).toBe('expired');
    expect(mockValkeySet).not.toHaveBeenCalled();
    expect(deletes).toContain('guild-1');
  });

  it('falls back to in-memory state when Valkey is down', async () => {
    mockValkeySet.mockRejectedValue(new Error('ECONNREFUSED') as never);
    const expires = new Date(Date.now() + 120_000).toISOString();
    const { supabase } = makeSupa({ row: { expires_at: expires } });

    // Containment still resumes — the durable record is the source of truth,
    // Valkey is only the hot path.
    await expect(resumeRaidState(guild, supabase)).resolves.toBe('resumed');
  });
});
