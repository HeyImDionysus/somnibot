/**
 * backfillMembers reconciliation + erasure suppression (P2 batch, Cluster B).
 *
 * Covers:
 * - B5: existing-row read pages with .range() instead of a truncated .limit()
 * - B1: stale left_at rows are reconciled per-row (identity refresh only —
 *   member_number / total_time_seconds are never written)
 * - B6: onboarding_completed comes from Discord's flag/pending state for new
 *   rows, plus a chunked repair pass for provably-not-pending existing rows
 * - B2: per-chunk member-number draw with bounded 23505 redraw, honest insert
 *   counting from the returned rows, and continue-not-break on chunk failure
 * - B8: /forgetme-marked ids are excluded from every write; an unreadable
 *   marker list skips the backfill entirely; recordMemberJoin clears the
 *   marker BEFORE writing the member row
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@somnibot/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@somnibot/shared')>()),
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('discord.js', () => ({
  GuildMemberFlags: { CompletedOnboarding: 1 << 1 },
}));

import { backfillMembers, recordMemberJoin } from '../features/welcome/member-service.js';

// ── Scripted supabase mock ──────────────────────────────────
//
// Each from(table) call records every chained method + args; awaiting the
// chain hands the recorded entry to `handler`, which returns { data, error }.
// This makes both payload assertions and call-order assertions exact.

interface Entry {
  table: string;
  ops: Array<[string, unknown[]]>;
}

const CHAIN_METHODS = [
  'select', 'eq', 'in', 'is', 'not', 'order', 'limit', 'range',
  'maybeSingle', 'single', 'insert', 'update', 'upsert', 'delete',
] as const;

function makeScriptedSupabase(
  handler: (entry: Entry) => { data?: unknown; error?: unknown; count?: number },
  rpcHandler: (name: string) => { data: unknown; error: unknown } = () => ({ data: 1, error: null }),
) {
  const entries: Entry[] = [];
  return {
    entries,
    from: vi.fn((table: string) => {
      const entry: Entry = { table, ops: [] };
      entries.push(entry);
      const chain: Record<string, unknown> = {};
      for (const m of CHAIN_METHODS) {
        chain[m] = (...args: unknown[]) => {
          entry.ops.push([m, args]);
          return chain;
        };
      }
      chain.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
        Promise.resolve(handler(entry)).then(res, rej);
      return chain;
    }),
    rpc: vi.fn(async (name: string) => rpcHandler(name)),
  };
}

function opArgs(entry: Entry, method: string): unknown[] | undefined {
  return entry.ops.find(([m]) => m === method)?.[1];
}

function firstOp(entry: Entry): string {
  return entry.ops[0]?.[0] ?? '';
}

// ── Fake Discord objects ────────────────────────────────────

function makeDiscordMember(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    user: {
      bot: false,
      tag: `${id}#0001`,
      displayAvatarURL: () => `https://cdn.discord.com/${id}.png`,
    },
    joinedAt: new Date('2026-02-01T00:00:00Z'),
    joinedTimestamp: new Date('2026-02-01T00:00:00Z').getTime(),
    pending: false,
    flags: { has: () => false },
    ...overrides,
  };
}

function makeGuild(members: ReturnType<typeof makeDiscordMember>[], memberCount = members.length) {
  const collection = new Map(members.map((m) => [m.id, m]));
  return {
    id: 'guild-1',
    memberCount,
    members: { fetch: vi.fn(async () => collection) },
  };
}

type MemberRow = { discord_id: string; left_at: string | null; onboarding_completed: boolean };

/**
 * Standard handler: serves paged member/erasure reads from arrays, succeeds
 * on writes, and reports every upsert row as inserted.
 */
function standardHandler(memberRows: MemberRow[], erasureIds: string[] = []) {
  return (entry: Entry): { data?: unknown; error?: unknown } => {
    if (firstOp(entry) === 'select') {
      const [from, to] = opArgs(entry, 'range') as [number, number];
      if (entry.table === 'members') {
        return { data: memberRows.slice(from, to + 1), error: null };
      }
      if (entry.table === 'member_erasures') {
        return { data: erasureIds.map((id) => ({ discord_id: id })).slice(from, to + 1), error: null };
      }
    }
    if (firstOp(entry) === 'upsert') {
      const rows = (opArgs(entry, 'upsert') as [Array<{ discord_id: string }>])[0];
      return { data: rows.map((r) => ({ discord_id: r.discord_id })), error: null };
    }
    if (firstOp(entry) === 'update') {
      // The CAS reconcile reads the affected rows back; one matched row.
      const id = entry.ops.find(([m, a]) => m === 'eq' && (a as [string, string])[0] === 'discord_id');
      return { data: [{ discord_id: id ? (id[1] as [string, string])[1] : 'x' }], error: null };
    }
    return { data: null, error: null };
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ── B5: paged existing-row read ─────────────────────────────

describe('backfillMembers — paged reads (B5)', () => {
  it('pages the existing-row read past 1000 rows and skips all known ids', async () => {
    const page1: MemberRow[] = Array.from({ length: 1000 }, (_, i) => ({
      discord_id: `old-${i}`,
      left_at: null,
      onboarding_completed: true,
    }));
    const page2: MemberRow[] = [{ discord_id: 'old-1000', left_at: null, onboarding_completed: true }];
    const supabase = makeScriptedSupabase(standardHandler([...page1, ...page2]));

    // old-1000 lives on the SECOND page — a truncated read would re-insert it.
    const guild = makeGuild([
      makeDiscordMember('old-1000'),
      makeDiscordMember('new-1'),
    ]);

    const inserted = await backfillMembers(supabase as never, guild as never);

    expect(inserted).toBe(1);
    const reads = supabase.entries.filter(
      (e) => e.table === 'members' && firstOp(e) === 'select',
    );
    expect(reads.length).toBe(2);
    expect(opArgs(reads[0], 'range')).toEqual([0, 999]);
    expect(opArgs(reads[1], 'range')).toEqual([1000, 1999]);

    const upserts = supabase.entries.filter((e) => firstOp(e) === 'upsert');
    expect(upserts.length).toBe(1);
    const rows = (opArgs(upserts[0], 'upsert') as [Array<{ discord_id: string }>])[0];
    expect(rows.map((r) => r.discord_id)).toEqual(['new-1']);
  });
});

// ── B1: stale left_at reconciliation ────────────────────────

describe('backfillMembers — left_at reconciliation (B1)', () => {
  it('marks departed active rows left from a complete fetch and refreshes the live count including bots', async () => {
    const supabase = makeScriptedSupabase(standardHandler([
      { discord_id: 'current', left_at: null, onboarding_completed: true },
      { discord_id: 'departed', left_at: null, onboarding_completed: true },
      { discord_id: 'erased-departed', left_at: null, onboarding_completed: true },
    ], ['erased-departed']));
    const guild = makeGuild([
      makeDiscordMember('current'),
      makeDiscordMember('bot', { user: { bot: true } }),
    ], 3);

    await backfillMembers(supabase as never, guild as never);

    expect(guild.memberCount).toBe(2);
    const departedUpdate = supabase.entries.find(
      (entry) => entry.table === 'members' && opArgs(entry, 'in') !== undefined,
    );
    expect(departedUpdate).toBeDefined();
    expect((opArgs(departedUpdate!, 'update') as [Record<string, unknown>])[0]).toEqual({
      left_at: expect.any(String),
    });
    expect(departedUpdate!.ops.filter(([method]) => method === 'eq').map(([, args]) => args)).toEqual([
      ['guild_id', 'guild-1'],
    ]);
    expect(opArgs(departedUpdate!, 'is')).toEqual(['left_at', null]);
    expect(opArgs(departedUpdate!, 'in')).toEqual(['discord_id', ['departed']]);
  });

  it('clears stale left_at per-row, refreshing identity but never history columns', async () => {
    const supabase = makeScriptedSupabase(standardHandler([
      { discord_id: 'rejoiner', left_at: '2026-01-15T00:00:00Z', onboarding_completed: true },
    ]));
    const guild = makeGuild([makeDiscordMember('rejoiner')]);

    await backfillMembers(supabase as never, guild as never);

    const updates = supabase.entries.filter((e) => firstOp(e) === 'update');
    expect(updates.length).toBe(1);
    const payload = (opArgs(updates[0], 'update') as [Record<string, unknown>])[0];
    expect(payload).toEqual({
      left_at: null,
      is_returning: true,
      username: 'rejoiner#0001',
      avatar_url: 'https://cdn.discord.com/rejoiner.png',
      joined_at: '2026-02-01T00:00:00.000Z',
    });
    expect(payload).not.toHaveProperty('member_number');
    expect(payload).not.toHaveProperty('total_time_seconds');
    // Scoped to exactly this guild + member, compare-and-set on the
    // snapshotted left_at so a mid-backfill leave/rejoin is never overwritten.
    const eqArgs = updates[0].ops.filter(([m]) => m === 'eq').map(([, a]) => a);
    expect(eqArgs).toEqual([
      ['guild_id', 'guild-1'],
      ['discord_id', 'rejoiner'],
      ['left_at', '2026-01-15T00:00:00Z'],
    ]);
    // Nothing to insert.
    expect(supabase.entries.some((e) => firstOp(e) === 'upsert')).toBe(false);
  });

  it('folds the onboarding repair into the stale-left update when the fetch proves completion', async () => {
    const supabase = makeScriptedSupabase(standardHandler([
      { discord_id: 'rejoiner', left_at: '2026-01-15T00:00:00Z', onboarding_completed: false },
      { discord_id: 'screening', left_at: '2026-01-15T00:00:00Z', onboarding_completed: false },
    ]));
    const guild = makeGuild([
      makeDiscordMember('rejoiner', { pending: false }),
      makeDiscordMember('screening', { pending: true }),
    ]);

    await backfillMembers(supabase as never, guild as never);

    const updates = supabase.entries.filter((e) => firstOp(e) === 'update');
    expect(updates.length).toBe(2);
    const byId = new Map(updates.map((e) => [
      (e.ops.filter(([m]) => m === 'eq')[1][1] as [string, string])[1],
      (opArgs(e, 'update') as [Record<string, unknown>])[0],
    ]));
    expect(byId.get('rejoiner')).toMatchObject({ left_at: null, onboarding_completed: true });
    // Still in Discord's screening — the repair must NOT touch them.
    expect(byId.get('screening')).not.toHaveProperty('onboarding_completed');
  });
});

// ── B6: onboarding_completed truthfulness ───────────────────

describe('backfillMembers — onboarding_completed (B6)', () => {
  it('derives onboarding_completed for new rows from flag || !pending', async () => {
    const supabase = makeScriptedSupabase(standardHandler([]));
    const guild = makeGuild([
      makeDiscordMember('done-flag', { pending: true, flags: { has: () => true } }),
      makeDiscordMember('done-not-pending', { pending: false, flags: { has: () => false } }),
      makeDiscordMember('still-pending', { pending: true, flags: { has: () => false } }),
    ]);

    await backfillMembers(supabase as never, guild as never);

    const upserts = supabase.entries.filter((e) => firstOp(e) === 'upsert');
    const rows = (opArgs(upserts[0], 'upsert') as [Array<{ discord_id: string; onboarding_completed: boolean }>])[0];
    const byId = new Map(rows.map((r) => [r.discord_id, r.onboarding_completed]));
    expect(byId.get('done-flag')).toBe(true);
    expect(byId.get('done-not-pending')).toBe(true);
    expect(byId.get('still-pending')).toBe(false);
  });

  it('repairs onboarding_completed=false rows in chunks when the member is provably past screening', async () => {
    const supabase = makeScriptedSupabase(standardHandler([
      { discord_id: 'locked-out', left_at: null, onboarding_completed: false },
      { discord_id: 'genuinely-pending', left_at: null, onboarding_completed: false },
      { discord_id: 'already-done', left_at: null, onboarding_completed: true },
    ]));
    const guild = makeGuild([
      makeDiscordMember('locked-out', { pending: false }),
      makeDiscordMember('genuinely-pending', { pending: true }),
      makeDiscordMember('already-done', { pending: false }),
    ]);

    await backfillMembers(supabase as never, guild as never);

    const updates = supabase.entries.filter((e) => firstOp(e) === 'update');
    expect(updates.length).toBe(1);
    expect((opArgs(updates[0], 'update') as [Record<string, unknown>])[0]).toEqual({
      onboarding_completed: true,
    });
    expect(opArgs(updates[0], 'in')).toEqual(['discord_id', ['locked-out']]);
  });
});

// ── B2: numbering + honest counting ─────────────────────────

describe('backfillMembers — chunk numbering and counting (B2)', () => {
  it('redraws the member number on 23505, counts real inserts, and continues past a failed chunk', async () => {
    // 201 missing members → two chunks (200 + 1).
    const members = Array.from({ length: 201 }, (_, i) =>
      makeDiscordMember(`m-${String(i).padStart(3, '0')}`, {
        joinedTimestamp: i,
        joinedAt: new Date(i),
      }));

    let upsertCall = 0;
    const upsertPayloads: Array<Array<{ discord_id: string; member_number: number }>> = [];
    const handler = (entry: Entry): { data?: unknown; error?: unknown } => {
      if (firstOp(entry) === 'select') {
        return { data: [], error: null };
      }
      if (firstOp(entry) === 'upsert') {
        upsertCall += 1;
        const rows = (opArgs(entry, 'upsert') as [Array<{ discord_id: string; member_number: number }>])[0];
        upsertPayloads.push(rows);
        // Chunk 1, attempt 1: a live join stole a number → 23505.
        if (upsertCall === 1) return { data: null, error: { code: '23505', message: 'duplicate key' } };
        // Chunk 1, attempt 2: 150 of 200 actually inserted (rest were dupes).
        if (upsertCall === 2) {
          return { data: rows.slice(0, 150).map((r) => ({ discord_id: r.discord_id })), error: null };
        }
        // Chunk 2: non-retryable failure — must not abort the count made so far.
        return { data: null, error: { code: '42501', message: 'permission denied' } };
      }
      return { data: null, error: null };
    };

    let draw = 0;
    const supabase = makeScriptedSupabase(handler, () => {
      draw += 1;
      // Successive draws move forward, as MAX+1 would after inserts/joins.
      return { data: draw * 1000, error: null };
    });
    const guild = makeGuild(members);

    const inserted = await backfillMembers(supabase as never, guild as never);

    // Only rows PostgREST returned count — never rows.length.
    expect(inserted).toBe(150);
    // One draw per attempt: chunk1 attempt1, chunk1 attempt2, chunk2 attempt1.
    expect(supabase.rpc).toHaveBeenCalledTimes(3);
    // The retry re-based its numbering on the fresh draw.
    expect(upsertPayloads[0][0].member_number).toBe(1000);
    expect(upsertPayloads[1][0].member_number).toBe(2000);
    expect(upsertPayloads[1][199].member_number).toBe(2199);
    // Chunk 2 was still attempted after chunk 1 settled (continue, not break).
    expect(upsertPayloads[2][0].discord_id).toBe('m-200');
  });
});

// ── B8: erasure suppression ─────────────────────────────────

describe('backfillMembers — erasure markers (B8)', () => {
  it('never writes rows for erased ids — neither inserts nor reconciles', async () => {
    const supabase = makeScriptedSupabase(standardHandler(
      [{ discord_id: 'erased-stale', left_at: '2026-01-15T00:00:00Z', onboarding_completed: false }],
      ['erased-new', 'erased-stale'],
    ));
    const guild = makeGuild([
      makeDiscordMember('erased-new'),
      makeDiscordMember('erased-stale'),
      makeDiscordMember('normal'),
    ]);

    const inserted = await backfillMembers(supabase as never, guild as never);

    expect(inserted).toBe(1);
    const upserts = supabase.entries.filter((e) => firstOp(e) === 'upsert');
    const rows = (opArgs(upserts[0], 'upsert') as [Array<{ discord_id: string }>])[0];
    expect(rows.map((r) => r.discord_id)).toEqual(['normal']);
    expect(supabase.entries.some((e) => firstOp(e) === 'update')).toBe(false);
  });

  it('skips the whole backfill when the erasure list cannot be read', async () => {
    const handler = (entry: Entry): { data?: unknown; error?: unknown } => {
      if (entry.table === 'member_erasures') return { data: null, error: { message: 'boom' } };
      if (firstOp(entry) === 'select') return { data: [], error: null };
      return { data: null, error: null };
    };
    const supabase = makeScriptedSupabase(handler);
    const guild = makeGuild([makeDiscordMember('new-1')]);

    const inserted = await backfillMembers(supabase as never, guild as never);

    expect(inserted).toBe(0);
    expect(supabase.entries.some((e) => firstOp(e) === 'upsert' || firstOp(e) === 'update')).toBe(false);
  });
});

describe('recordMemberJoin — erasure marker cleanup (B8)', () => {
  it('deletes the erasure marker before any member write (voluntary rejoin = fresh consent)', async () => {
    const handler = (entry: Entry): { data?: unknown; error?: unknown } => {
      if (entry.table === 'members' && firstOp(entry) === 'select') {
        return { data: { total_time_seconds: 10, left_at: null, joined_at: null }, error: null };
      }
      if (firstOp(entry) === 'upsert') {
        return { data: { discord_id: 'user-1' }, error: null };
      }
      return { data: null, error: null };
    };
    const supabase = makeScriptedSupabase(handler);

    const member = {
      id: 'user-1',
      guild: { id: 'guild-1' },
      user: {
        tag: 'User#0001',
        displayAvatarURL: () => 'https://cdn.discord.com/user-1.png',
      },
    };

    const result = await recordMemberJoin(supabase as never, member as never, true);

    expect(result).toEqual({ discord_id: 'user-1' });
    expect(supabase.entries[0].table).toBe('member_erasures');
    expect(firstOp(supabase.entries[0])).toBe('delete');
    const eqArgs = supabase.entries[0].ops.filter(([m]) => m === 'eq').map(([, a]) => a);
    expect(eqArgs).toEqual([['guild_id', 'guild-1'], ['discord_id', 'user-1']]);
    // Every members-table write happens after the marker delete.
    const memberWriteIndex = supabase.entries.findIndex((e) => e.table === 'members');
    expect(memberWriteIndex).toBeGreaterThan(0);
  });
});

// ── Review F2: late-erasure sweep ───────────────────────────

describe('backfillMembers — late-erasure sweep (review F2)', () => {
  it('removes a row inserted for a member whose /forgetme landed mid-backfill', async () => {
    // First erasure read (pre-partition): empty. Second (post-insert sweep):
    // 'late-erased' has filed /forgetme while chunks were inserting.
    let erasureReads = 0;
    const supabase = makeScriptedSupabase((entry) => {
      if (entry.table === 'members' && firstOp(entry) === 'select') {
        return { data: [], error: null };
      }
      if (entry.table === 'member_erasures' && firstOp(entry) === 'select') {
        erasureReads += 1;
        return {
          data: erasureReads === 1 ? [] : [{ discord_id: 'late-erased' }],
          error: null,
        };
      }
      if (firstOp(entry) === 'upsert') {
        const rows = (opArgs(entry, 'upsert') as [Array<{ discord_id: string }>])[0];
        return { data: rows.map((r) => ({ discord_id: r.discord_id })), error: null };
      }
      return { data: null, error: null };
    });
    const guild = makeGuild([makeDiscordMember('late-erased'), makeDiscordMember('ok')]);

    const inserted = await backfillMembers(supabase as never, guild as never);

    // Both rows inserted, then the marked one swept back out and un-counted.
    expect(erasureReads).toBe(2);
    const del = supabase.entries.find((e) => e.table === 'members' && firstOp(e) === 'delete');
    expect(del).toBeDefined();
    const inArgs = del!.ops.find(([m]) => m === 'in')?.[1] as [string, string[]];
    expect(inArgs).toEqual(['discord_id', ['late-erased']]);
    expect(inserted).toBe(1);
  });

  it('issues no delete when no new markers appeared during the run', async () => {
    const supabase = makeScriptedSupabase(standardHandler([]));
    const guild = makeGuild([makeDiscordMember('ok')]);

    const inserted = await backfillMembers(supabase as never, guild as never);

    expect(inserted).toBe(1);
    expect(supabase.entries.some((e) => firstOp(e) === 'delete')).toBe(false);
  });
});
