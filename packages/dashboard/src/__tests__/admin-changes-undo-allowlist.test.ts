/**
 * Tests for the admin-changes undo route's defense-in-depth allowlist.
 *
 * The undo route replays a stored undo_payload ({ table, data, match }) as a
 * Supabase update. Because that payload is read back from a DB row, a corrupted
 * or tampered row could try to steer the write at a non-allowlisted table
 * (users, guild_secrets) or at columns undo never legitimately writes. These
 * tests verify that such payloads are rejected at APPLY time with no DB write,
 * and that a legitimate undo still works.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextResponse } from 'next/server';

// ── Mock dependencies ───────────────────────────────────────

const mockRequirePermission = vi.fn();
vi.mock('@/lib/rbac', () => ({
  requirePermission: (...args: unknown[]) => mockRequirePermission(...args),
  authErrorResponse: vi.fn(),
}));

const mockRateLimit = vi.fn();
vi.mock('@/lib/api/admin-rate-limit', () => ({
  checkAdminRateLimit: (...args: unknown[]) => mockRateLimit(...args),
}));

const mockParseBody = vi.fn();
vi.mock('@/lib/api/validation', () => ({
  parseBody: (...args: unknown[]) => mockParseBody(...args),
  schemas: {},
}));

const mockSupabase = { from: vi.fn() };
vi.mock('@/lib/supabase/admin', () => ({
  createAdminSupabase: () => mockSupabase,
}));

import { POST } from '@/app/api/admin-changes/route';
import {
  validateUndoPayload,
  UNDOABLE_TABLES,
  UNDO_TABLE_COLUMNS,
} from '@/lib/api/undo-allowlist';

// ── Helpers ─────────────────────────────────────────────────

function buildRequest(body: unknown) {
  return new Request('http://localhost/api/admin-changes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-forwarded-for': '1.2.3.4' },
    body: JSON.stringify(body),
  }) as unknown as import('next/server').NextRequest;
}

/**
 * Wire the mocked Supabase client so that:
 *   - `.from('admin_changes')` returns a chain whose `.single()` yields the
 *     change first (the select) and a reverse-record id afterwards (the insert),
 *     and whose update/link awaits resolve to `{ error: null }`.
 *   - any other `.from(table)` access is the undo target write; its
 *     `.update().match()` is spied so tests can assert whether it fired.
 */
function wireSupabase(change: Record<string, unknown> | null) {
  const targetUpdate = vi.fn().mockReturnThis();
  const targetMatch = vi.fn().mockResolvedValue({ error: null });

  // `.single()` is called twice against admin_changes: first the select of the
  // change to undo, then the insert of the reverse record.
  const single = vi
    .fn()
    .mockResolvedValueOnce({ data: change })
    .mockResolvedValue({ data: { id: 'undo-record-1' } });

  mockSupabase.from.mockImplementation((table: string) => {
    if (table === 'admin_changes') {
      // A chainable + thenable object: `.update().eq().eq()` awaits resolve to
      // `{ error: null }`, while `.insert().select().single()` returns data.
      const chain: Record<string, unknown> = {
        select: vi.fn(() => chain),
        eq: vi.fn(() => chain),
        insert: vi.fn(() => chain),
        update: vi.fn(() => chain),
        single,
        then: (resolve: (v: { error: null }) => unknown) => resolve({ error: null }),
      };
      return chain;
    }
    // Any non-admin_changes table access = the undo target write.
    return { update: targetUpdate, match: targetMatch };
  });

  return { targetUpdate, targetMatch };
}

function okAuth(guildId = 'guild-1', discordId = '123') {
  mockRequirePermission.mockResolvedValue({ guildId, discordId });
}

const validUndoBody = { action: 'undo', id: '00000000-0000-0000-0000-000000000001' };

beforeEach(() => {
  vi.clearAllMocks();
  mockRateLimit.mockResolvedValue(null); // not rate limited
  mockParseBody.mockResolvedValue({ ok: true, data: validUndoBody });
});

// ── Unit tests: validateUndoPayload ─────────────────────────

describe('validateUndoPayload', () => {
  it('accepts a payload targeting an allowlisted table and columns', () => {
    const res = validateUndoPayload({
      table: 'guild_config',
      data: { welcome_message: 'hi' },
      match: { guild_id: 'guild-1' },
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.table).toBe('guild_config');
      expect(res.data).toEqual({ welcome_message: 'hi' });
      expect(res.match).toEqual({ guild_id: 'guild-1' });
    }
  });

  it('rejects a non-allowlisted table (users)', () => {
    const res = validateUndoPayload({
      table: 'users',
      data: { is_admin: true },
      match: { id: 'attacker' },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain('users');
  });

  it('rejects a non-allowlisted table (guild_secrets)', () => {
    const res = validateUndoPayload({
      table: 'guild_secrets',
      data: { value: 'leak' },
      match: { guild_id: 'guild-1' },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain('guild_secrets');
  });

  it('rejects an off-list column in data even on an allowlisted table', () => {
    const res = validateUndoPayload({
      table: 'guild_config',
      // `owner_discord_id` is not a guild_config column.
      data: { owner_discord_id: 'attacker' },
      match: { guild_id: 'guild-1' },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain('owner_discord_id');
  });

  it('rejects an off-list column in match even on an allowlisted table', () => {
    const res = validateUndoPayload({
      table: 'economy_items',
      data: { price: 10 },
      match: { some_bogus_column: 'x' },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain('some_bogus_column');
  });

  it('rejects an empty match (would update every row)', () => {
    const res = validateUndoPayload({
      table: 'economy_items',
      data: { price: 1 },
      match: {},
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain('match');
  });

  it('rejects non-object / array payloads and fields', () => {
    expect(validateUndoPayload(null).ok).toBe(false);
    expect(validateUndoPayload('drop table').ok).toBe(false);
    expect(
      validateUndoPayload({ table: 'guild_config', data: ['x'], match: { guild_id: 'g' } }).ok,
    ).toBe(false);
    expect(
      validateUndoPayload({ table: 'guild_config', data: { welcome_message: 'x' }, match: null }).ok,
    ).toBe(false);
    expect(
      validateUndoPayload({ table: 123, data: {}, match: { guild_id: 'g' } }).ok,
    ).toBe(false);
  });

  it('keeps the table allowlist and column map in sync', () => {
    expect([...UNDOABLE_TABLES].sort()).toEqual(Object.keys(UNDO_TABLE_COLUMNS).sort());
    // Sensitive tables must never be undoable.
    expect(UNDOABLE_TABLES.has('users')).toBe(false);
    expect(UNDOABLE_TABLES.has('guild_secrets')).toBe(false);
    expect(UNDOABLE_TABLES.has('dashboard_roles')).toBe(false);
  });
});

// ── Route tests: POST /api/admin-changes ────────────────────

describe('POST /api/admin-changes — undo apply-time allowlist', () => {
  it('rejects a payload pointing at a non-allowlisted table with no DB write', async () => {
    okAuth();
    const { targetUpdate, targetMatch } = wireSupabase({
      id: validUndoBody.id,
      guild_id: 'guild-1',
      is_undoable: true,
      is_undone: false,
      undo_payload: { table: 'users', data: { is_admin: true }, match: { id: 'x' } },
    });

    const res = await POST(buildRequest(validUndoBody));
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error).toContain('Undo blocked');
    expect(json.error).toContain('users');
    // Critically: no write to the target table happened.
    expect(targetUpdate).not.toHaveBeenCalled();
    expect(targetMatch).not.toHaveBeenCalled();
    // And the change was NOT marked undone (no admin_changes update either).
    expect(mockSupabase.from).not.toHaveBeenCalledWith('users');
  });

  it('rejects a payload with an off-list column with no DB write', async () => {
    okAuth();
    const { targetUpdate, targetMatch } = wireSupabase({
      id: validUndoBody.id,
      guild_id: 'guild-1',
      is_undoable: true,
      is_undone: false,
      undo_payload: {
        table: 'guild_config',
        data: { owner_discord_id: 'attacker' },
        match: { guild_id: 'guild-1' },
      },
    });

    const res = await POST(buildRequest(validUndoBody));
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error).toContain('Undo blocked');
    expect(json.error).toContain('owner_discord_id');
    expect(targetUpdate).not.toHaveBeenCalled();
    expect(targetMatch).not.toHaveBeenCalled();
  });

  it('applies a legitimate undo against an allowlisted table + columns', async () => {
    okAuth('guild-1', 'admin-42');
    const { targetUpdate, targetMatch } = wireSupabase({
      id: validUndoBody.id,
      guild_id: 'guild-1',
      is_undoable: true,
      is_undone: false,
      action: 'update',
      target_type: 'economy',
      target_id: 'item-9',
      description: 'changed price',
      before_state: { price: 5 },
      after_state: { price: 10 },
      blast_radius: 'low',
      undo_payload: {
        table: 'economy_items',
        data: { price: 5 },
        match: { id: 'item-9', guild_id: 'guild-1' },
      },
    });

    const res = await POST(buildRequest(validUndoBody));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    // The undo write actually happened against economy_items.
    expect(mockSupabase.from).toHaveBeenCalledWith('economy_items');
    expect(targetUpdate).toHaveBeenCalledWith({ price: 5 });
    expect(targetMatch).toHaveBeenCalledWith({ id: 'item-9', guild_id: 'guild-1' });
  });

  it('is a no-op (no target write) when undo_payload is null but still marks undone', async () => {
    okAuth();
    const { targetUpdate } = wireSupabase({
      id: validUndoBody.id,
      guild_id: 'guild-1',
      is_undoable: true,
      is_undone: false,
      action: 'noop',
      target_type: 't',
      target_id: 'x',
      description: 'd',
      before_state: null,
      after_state: null,
      blast_radius: 'low',
      undo_payload: null,
    });

    const res = await POST(buildRequest(validUndoBody));
    expect(res.status).toBe(200);
    expect(targetUpdate).not.toHaveBeenCalled();
  });
});
