/**
 * Members route status filter (P2 batch, B3) + enrichment failure surfacing (B4).
 *
 * ?status=active|banned|left (default active):
 * - active: left_at IS NULL, DB-side count/pagination (historical behavior)
 * - banned: rows with an ACTIVE ban infraction regardless of left_at — bot
 *   bans set left_at via guildMemberRemove, so these were unreachable
 * - left:   left_at NOT NULL minus banned
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock dependencies ───────────────────────────────────────

const mockRequireGuildOwner = vi.fn();
vi.mock('@/lib/api/require-owner', () => ({
  requireGuildOwner: () => mockRequireGuildOwner(),
}));

const mockRateLimit = vi.fn();
vi.mock('@/lib/api/admin-rate-limit', () => ({
  checkAdminRateLimit: (...args: unknown[]) => mockRateLimit(...args),
}));

const mockEnrich = vi.fn();
vi.mock('@/lib/api/member-enrichment', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/member-enrichment')>();
  return { ...actual, enrichMembers: (...args: unknown[]) => mockEnrich(...args) };
});

// Scripted supabase: every from(table) records its chained ops; awaiting the
// chain hands the record to the current handler.
interface Entry {
  table: string;
  ops: Array<[string, unknown[]]>;
}

const CHAIN_METHODS = ['select', 'eq', 'in', 'is', 'not', 'or', 'order', 'range'] as const;

let entries: Entry[] = [];
let handler: (entry: Entry) => { data?: unknown; error?: unknown; count?: number };

const mockSupabase = {
  from: (table: string) => {
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
  },
};
vi.mock('@/lib/supabase/admin', () => ({
  createAdminSupabase: () => mockSupabase,
}));

import { GET } from '../app/api/members/route';
import { MemberEnrichmentError } from '@/lib/api/member-enrichment';

// ── Helpers ─────────────────────────────────────────────────

function buildRequest(params: Record<string, string> = {}) {
  const sp = new URLSearchParams(params);
  const url = `http://localhost/api/members?${sp.toString()}`;
  return new Request(url, {
    headers: { 'x-forwarded-for': '1.2.3.4' },
  }) as unknown as import('next/server').NextRequest;
}

function identityRow(id: string, joined: string, extra: Record<string, unknown> = {}) {
  return { discord_id: id, username: `u-${id}`, avatar_url: null, roles: [], joined_at: joined, ...extra };
}

function hasOp(entry: Entry, method: string, args?: unknown[]): boolean {
  return entry.ops.some(([m, a]) => m === method && (args === undefined || JSON.stringify(a) === JSON.stringify(args)));
}

beforeEach(() => {
  vi.clearAllMocks();
  entries = [];
  handler = () => ({ data: [], error: null });
  mockRateLimit.mockResolvedValue(null);
  mockRequireGuildOwner.mockResolvedValue({
    ok: true,
    ctx: { userId: 'user-1', discordId: '123', guildId: 'guild-1' },
  });
  mockEnrich.mockImplementation(async (_admin: unknown, _guildId: unknown, rows: unknown[]) => rows);
});

// ── Tests ───────────────────────────────────────────────────

describe('GET /api/members — status filter', () => {
  it('defaults to active: left_at IS NULL with DB-side count', async () => {
    handler = (entry) => {
      expect(entry.table).toBe('members');
      return { data: [identityRow('111', '2026-01-01T00:00:00Z')], count: 42, error: null };
    };

    const res = await GET(buildRequest());
    const body = await res.json();

    expect(body.success).toBe(true);
    expect(body.status).toBe('active');
    expect(body.total).toBe(42);
    expect(body.members).toHaveLength(1);
    expect(hasOp(entries[0], 'is', ['left_at', null])).toBe(true);
  });

  it('rejects an unknown status with 400', async () => {
    const res = await GET(buildRequest({ status: 'lurking' }));
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.success).toBe(false);
    expect(entries).toHaveLength(0);
  });

  it('banned with no active bans returns an empty page without touching members', async () => {
    handler = (entry) => {
      expect(entry.table).toBe('infractions');
      return { data: [], error: null };
    };

    const res = await GET(buildRequest({ status: 'banned' }));
    const body = await res.json();

    expect(body.success).toBe(true);
    expect(body.members).toEqual([]);
    expect(body.total).toBe(0);
    expect(entries.filter((e) => e.table === 'members')).toHaveLength(0);
  });

  it('banned dedupes infraction rows, ignores left_at, and paginates in memory', async () => {
    handler = (entry) => {
      if (entry.table === 'infractions') {
        // b1 has two active bans — the id set must dedupe.
        return {
          data: [{ member_id: 'b1' }, { member_id: 'b1' }, { member_id: 'b2' }, { member_id: 'b3' }],
          error: null,
        };
      }
      return {
        data: [
          identityRow('b1', '2026-01-01T00:00:00Z'),
          identityRow('b2', '2026-01-02T00:00:00Z'),
          identityRow('b3', '2026-01-03T00:00:00Z'),
        ],
        error: null,
      };
    };

    const res = await GET(buildRequest({ status: 'banned', limit: '2', page: '2' }));
    const body = await res.json();

    expect(body.success).toBe(true);
    expect(body.total).toBe(3);
    // Sorted joined_at desc: b3, b2 | b1 — page 2 holds the oldest.
    expect(body.members.map((m: { discord_id: string }) => m.discord_id)).toEqual(['b1']);

    const membersQuery = entries.find((e) => e.table === 'members');
    expect(membersQuery).toBeDefined();
    expect(hasOp(membersQuery!, 'in', ['discord_id', ['b1', 'b2', 'b3']])).toBe(true);
    // Banned members are reachable regardless of left_at.
    expect(hasOp(membersQuery!, 'is')).toBe(false);
    expect(hasOp(membersQuery!, 'not')).toBe(false);
  });

  it('left excludes banned members from rows and count', async () => {
    handler = (entry) => {
      if (entry.table === 'infractions') {
        return { data: [{ member_id: 'b1' }], error: null };
      }
      return {
        data: [
          identityRow('b1', '2026-01-05T00:00:00Z', { left_at: '2026-01-06T00:00:00Z' }),
          identityRow('l2', '2026-01-04T00:00:00Z', { left_at: '2026-01-07T00:00:00Z' }),
        ],
        error: null,
      };
    };

    const res = await GET(buildRequest({ status: 'left' }));
    const body = await res.json();

    expect(body.success).toBe(true);
    expect(body.total).toBe(1);
    expect(body.members.map((m: { discord_id: string }) => m.discord_id)).toEqual(['l2']);

    const membersQuery = entries.find((e) => e.table === 'members');
    expect(hasOp(membersQuery!, 'not', ['left_at', 'is', null])).toBe(true);
  });

  it('surfaces enrichment failures as 500 instead of fabricated zeros', async () => {
    handler = () => ({ data: [identityRow('111', '2026-01-01T00:00:00Z')], count: 1, error: null });
    mockEnrich.mockRejectedValue(new MemberEnrichmentError('economy_wallets', { message: 'down' }));

    const res = await GET(buildRequest());
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.success).toBe(false);
  });
});
