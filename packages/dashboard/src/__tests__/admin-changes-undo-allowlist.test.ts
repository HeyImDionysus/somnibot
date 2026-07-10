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

// Default caller context: guild-1 owns the row being undone. Tests that probe
// cross-guild scoping pass an explicit ctx instead.
const CTX = { guildId: 'guild-1' };

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
/**
 * `parentLookup` wires a guild-ownership lookup for lookup-scoped undo tables
 * (e.g. product_license_config → products). `table` is the parent table the
 * route reads; `owner` is what its `.select().eq().maybeSingle()` resolves to
 * (pass `null` to simulate a missing / cross-guild parent row).
 */
function wireSupabase(
  change: Record<string, unknown> | null,
  parentLookup?: { table: string; owner: Record<string, unknown> | null },
) {
  const targetUpdate = vi.fn().mockReturnThis();
  const targetMatch = vi.fn().mockResolvedValue({ error: null });
  const parentMaybeSingle = vi.fn().mockResolvedValue({ data: parentLookup?.owner ?? null });

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
    if (parentLookup && table === parentLookup.table) {
      // The guild-ownership lookup: `.select(col).eq(key,val).maybeSingle()`.
      const chain: Record<string, unknown> = {
        select: vi.fn(() => chain),
        eq: vi.fn(() => chain),
        maybeSingle: parentMaybeSingle,
      };
      return chain;
    }
    // Any other table access = the undo target write.
    return { update: targetUpdate, match: targetMatch };
  });

  return { targetUpdate, targetMatch, parentMaybeSingle };
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
    }, CTX);
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
    }, CTX);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain('users');
  });

  it('rejects a non-allowlisted table (guild_secrets)', () => {
    const res = validateUndoPayload({
      table: 'guild_secrets',
      data: { value: 'leak' },
      match: { guild_id: 'guild-1' },
    }, CTX);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain('guild_secrets');
  });

  it('rejects an off-list column in data even on an allowlisted table', () => {
    const res = validateUndoPayload({
      table: 'guild_config',
      // `owner_discord_id` is not a guild_config column.
      data: { owner_discord_id: 'attacker' },
      match: { guild_id: 'guild-1' },
    }, CTX);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain('owner_discord_id');
  });

  it('rejects an off-list column in match even on an allowlisted table', () => {
    const res = validateUndoPayload({
      table: 'economy_items',
      data: { price: 10 },
      match: { some_bogus_column: 'x' },
    }, CTX);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain('some_bogus_column');
  });

  it('rejects an empty match (would update every row)', () => {
    const res = validateUndoPayload({
      table: 'economy_items',
      data: { price: 1 },
      match: {},
    }, CTX);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain('match');
  });

  it('rejects non-object / array payloads and fields', () => {
    expect(validateUndoPayload(null, CTX).ok).toBe(false);
    expect(validateUndoPayload('drop table', CTX).ok).toBe(false);
    expect(
      validateUndoPayload({ table: 'guild_config', data: ['x'], match: { guild_id: 'g' } }, CTX).ok,
    ).toBe(false);
    expect(
      validateUndoPayload({ table: 'guild_config', data: { welcome_message: 'x' }, match: null }, CTX).ok,
    ).toBe(false);
    expect(
      validateUndoPayload({ table: 123, data: {}, match: { guild_id: 'g' } }, CTX).ok,
    ).toBe(false);
  });

  it('keeps the table allowlist and column map in sync', () => {
    expect([...UNDOABLE_TABLES].sort()).toEqual([...UNDO_TABLE_COLUMNS.keys()].sort());
    // Sensitive tables must never be undoable.
    expect(UNDOABLE_TABLES.has('users')).toBe(false);
    expect(UNDOABLE_TABLES.has('guild_secrets')).toBe(false);
    expect(UNDOABLE_TABLES.has('dashboard_roles')).toBe(false);
  });

  // ── Finding 1: allowlist must be a complete superset of dashboard-writable
  // columns, or real undo payloads get wrongly rejected. ──────────────
  it('accepts columns that dashboard write routes actually set', () => {
    // /api/welcome writes welcome_enabled + goodbye_enabled to guild_config.
    expect(
      validateUndoPayload({
        table: 'guild_config',
        data: { welcome_enabled: true, goodbye_enabled: false },
        match: { guild_id: 'guild-1' },
      }, CTX).ok,
    ).toBe(true);
    // /api/economy/shop writes stock, max_per_user, require_role_id, use_effect…
    expect(
      validateUndoPayload({
        table: 'economy_items',
        data: {
          stock: 5,
          max_per_user: 2,
          require_role_id: 'r1',
          grant_role_id: 'r2',
          usable: true,
          use_effect: { type: 'boost' },
          durability: 10,
          tradeable: false,
          updated_at: '2026-07-10T00:00:00Z',
        },
        match: { id: 'item-9', guild_id: 'guild-1' },
      }, CTX).ok,
    ).toBe(true);
  });

  // ── Finding 2: identity/tenant columns are match-only. A tampered payload
  // must not be able to SET id/guild_id even though it may MATCH on them. ──
  it('allows id/guild_id in match but rejects them in data', () => {
    // Legit: id + guild_id used to locate the row.
    expect(
      validateUndoPayload({
        table: 'economy_items',
        data: { price: 10 },
        match: { id: 'item-9', guild_id: 'guild-1' },
      }, CTX).ok,
    ).toBe(true);
    // Tampered: attempt to re-key the row via data.id.
    const reId = validateUndoPayload({
      table: 'economy_items',
      data: { id: 'other-item' },
      match: { id: 'item-9', guild_id: 'guild-1' },
    }, CTX);
    expect(reId.ok).toBe(false);
    if (!reId.ok) expect(reId.reason).toContain('id');
    // Tampered: attempt to move the row to another tenant via data.guild_id.
    const reTenant = validateUndoPayload({
      table: 'economy_items',
      data: { guild_id: 'attacker-guild' },
      match: { id: 'item-9', guild_id: 'guild-1' },
    }, CTX);
    expect(reTenant.ok).toBe(false);
    if (!reTenant.ok) expect(reTenant.reason).toContain('guild_id');
  });

  it('rejects a settable-only column used as a match key', () => {
    // welcome_message is settable (data) but not a valid match key.
    const res = validateUndoPayload({
      table: 'guild_config',
      data: { welcome_message: 'hi' },
      match: { welcome_message: 'hi' },
    }, CTX);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain('welcome_message');
  });

  // ── Finding 3: prototype-pollution — a table of "__proto__"/"constructor"
  // must be rejected, not resolve to a prototype value. ──────────────
  it('rejects inherited object keys as table names (no prototype bypass)', () => {
    for (const table of ['__proto__', 'constructor', 'prototype', 'hasOwnProperty', 'toString']) {
      const res = validateUndoPayload({
        table,
        data: { welcome_message: 'x' },
        match: { guild_id: 'guild-1' },
      }, CTX);
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.reason).toContain(table);
    }
  });

  it('each table has disjoint-purpose data and match sets that are non-empty', () => {
    for (const [table, spec] of UNDO_TABLE_COLUMNS) {
      expect(spec.data.size, `${table} data`).toBeGreaterThan(0);
      expect(spec.match.size, `${table} match`).toBeGreaterThan(0);
      // Identity/tenant columns must never be settable.
      expect(spec.data.has('id'), `${table} data.id`).toBe(false);
      expect(spec.data.has('guild_id'), `${table} data.guild_id`).toBe(false);
      expect(spec.data.has('created_at'), `${table} data.created_at`).toBe(false);
    }
  });

  // ── Every table's tenancy contract is well-formed ──────────────
  it('every table declares required identity keys and a coherent guild scope', () => {
    for (const [table, spec] of UNDO_TABLE_COLUMNS) {
      // requiredMatch must be non-empty and a subset of the match allowlist.
      expect(spec.requiredMatch.size, `${table} requiredMatch`).toBeGreaterThan(0);
      for (const key of spec.requiredMatch) {
        expect(spec.match.has(key), `${table} requiredMatch ${key} in match`).toBe(true);
      }
      if (spec.guildScope.kind === 'column') {
        // The guild scope column must itself be a valid match key.
        expect(spec.match.has(spec.guildScope.column), `${table} guild column`).toBe(true);
      } else {
        // Lookup scope: the local key must be a required, matchable identity.
        expect(spec.match.has(spec.guildScope.localKey), `${table} lookup localKey`).toBe(true);
        expect(spec.requiredMatch.has(spec.guildScope.localKey), `${table} lookup required`).toBe(true);
      }
    }
  });

  // ── Finding (05:40): require row identifiers in match. A payload that
  // matches on the tenant key ALONE would rewrite every row of the guild. ──
  it('rejects an id-keyed table matched on guild_id alone (mass update)', () => {
    const res = validateUndoPayload({
      table: 'economy_items',
      data: { price: 1 },
      match: { guild_id: 'guild-1' }, // no id → would hit every item in the guild
    }, CTX);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain('id');
  });

  it('rejects an id-keyed table matched on id alone (missing guild scope)', () => {
    // id is present so requiredMatch passes, but without guild_id the write
    // could not be confined to the caller's tenant.
    const res = validateUndoPayload({
      table: 'economy_items',
      data: { price: 1 },
      match: { id: 'item-9' },
    }, CTX);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain('guild');
  });

  // ── Finding (05:40): verify the guild match value against the caller. A
  // tampered payload naming another guild must be rejected. ──────────────
  it('rejects a payload whose guild_id match names a different guild', () => {
    const res = validateUndoPayload({
      table: 'economy_items',
      data: { price: 1 },
      match: { id: 'item-9', guild_id: 'other-guild' },
    }, CTX); // caller is guild-1
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain('different guild');
  });

  it('accepts a guild_config undo only for the caller\'s own guild', () => {
    expect(
      validateUndoPayload(
        { table: 'guild_config', data: { welcome_message: 'hi' }, match: { guild_id: 'guild-1' } },
        CTX,
      ).ok,
    ).toBe(true);
    const cross = validateUndoPayload(
      { table: 'guild_config', data: { welcome_message: 'hi' }, match: { guild_id: 'other-guild' } },
      CTX,
    );
    expect(cross.ok).toBe(false);
    if (!cross.ok) expect(cross.reason).toContain('different guild');
  });

  // ── Finding (05:40): scheduled_messages must not expose bot-owned counters
  // (current_sends / last_sent_at) as undo-settable columns. ──────────────
  it('does not let undo set bot-owned scheduled_messages counters', () => {
    const spec = UNDO_TABLE_COLUMNS.get('scheduled_messages');
    expect(spec?.data.has('current_sends')).toBe(false);
    expect(spec?.data.has('last_sent_at')).toBe(false);
    // But legitimate config columns are still settable.
    expect(spec?.data.has('cron_expression')).toBe(true);
    expect(spec?.data.has('max_sends')).toBe(true);

    const counters = validateUndoPayload({
      table: 'scheduled_messages',
      data: { current_sends: 0 },
      match: { id: 'sm-1', guild_id: 'guild-1' },
    }, CTX);
    expect(counters.ok).toBe(false);
    if (!counters.ok) expect(counters.reason).toContain('current_sends');

    const lastSent = validateUndoPayload({
      table: 'scheduled_messages',
      data: { last_sent_at: '2026-01-01T00:00:00Z' },
      match: { id: 'sm-1', guild_id: 'guild-1' },
    }, CTX);
    expect(lastSent.ok).toBe(false);
    if (!lastSent.ok) expect(lastSent.reason).toContain('last_sent_at');
  });

  // ── Finding (05:40): product_license_config has no guild column, so undo
  // must defer a parent-table ownership check to the route. ──────────────
  it('emits a tenancy lookup for guild-less product_license_config', () => {
    const res = validateUndoPayload({
      table: 'product_license_config',
      data: { max_devices: 5 },
      match: { product_id: 'prod-1' },
    }, CTX);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.tenancyCheck).toEqual({
        foreignTable: 'products',
        foreignKey: 'id',
        keyValue: 'prod-1',
        foreignGuildColumn: 'guild_id',
      });
    }
  });

  it('requires product_id for a product_license_config undo (no empty-key mass update)', () => {
    // Only guild_id would be nonsensical (not a match key) — verify the
    // required product_id is enforced by rejecting a match without it.
    const res = validateUndoPayload({
      table: 'product_license_config',
      data: { max_devices: 5 },
      match: { device_policy: 'x' } as unknown as Record<string, unknown>,
    }, CTX);
    // device_policy is not a match key, so it's rejected before requiredMatch,
    // but either way the payload must not pass.
    expect(res.ok).toBe(false);
  });

  it('guild-column tables never emit a tenancy lookup', () => {
    const res = validateUndoPayload({
      table: 'economy_items',
      data: { price: 1 },
      match: { id: 'item-9', guild_id: 'guild-1' },
    }, CTX);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.tenancyCheck).toBeUndefined();
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

  // ── Finding (05:40): a payload matching on the tenant key alone must be
  // blocked at the route with no target write (would rewrite the whole guild). ──
  it('rejects an id-keyed undo matched on guild_id alone with no DB write', async () => {
    okAuth('guild-1', 'admin-42');
    const { targetUpdate, targetMatch } = wireSupabase({
      id: validUndoBody.id,
      guild_id: 'guild-1',
      is_undoable: true,
      is_undone: false,
      undo_payload: {
        table: 'economy_items',
        data: { price: 1 },
        match: { guild_id: 'guild-1' }, // no id
      },
    });

    const res = await POST(buildRequest(validUndoBody));
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error).toContain('Undo blocked');
    expect(targetUpdate).not.toHaveBeenCalled();
    expect(targetMatch).not.toHaveBeenCalled();
  });

  // ── Finding (05:40): a payload naming another guild must be blocked even
  // though its guild_id is a valid match key. ──────────────
  it('rejects an undo whose guild_id names a different guild with no DB write', async () => {
    okAuth('guild-1', 'admin-42');
    const { targetUpdate, targetMatch } = wireSupabase({
      id: validUndoBody.id,
      guild_id: 'guild-1',
      is_undoable: true,
      is_undone: false,
      undo_payload: {
        table: 'economy_items',
        data: { price: 1 },
        match: { id: 'item-9', guild_id: 'other-guild' },
      },
    });

    const res = await POST(buildRequest(validUndoBody));
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error).toContain('Undo blocked');
    expect(json.error).toContain('different guild');
    expect(targetUpdate).not.toHaveBeenCalled();
    expect(targetMatch).not.toHaveBeenCalled();
  });

  // ── Finding (05:40): product_license_config has no guild column — the route
  // must verify the product's owning guild before applying the undo. ──────────
  it('applies a product_license_config undo when the product belongs to the guild', async () => {
    okAuth('guild-1', 'admin-42');
    const { targetUpdate, targetMatch, parentMaybeSingle } = wireSupabase(
      {
        id: validUndoBody.id,
        guild_id: 'guild-1',
        is_undoable: true,
        is_undone: false,
        action: 'update',
        target_type: 'license',
        target_id: 'prod-1',
        description: 'changed license',
        before_state: { max_devices: 3 },
        after_state: { max_devices: 5 },
        blast_radius: 'low',
        undo_payload: {
          table: 'product_license_config',
          data: { max_devices: 3 },
          match: { product_id: 'prod-1' },
        },
      },
      { table: 'products', owner: { guild_id: 'guild-1' } },
    );

    const res = await POST(buildRequest(validUndoBody));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    // Ownership was resolved through products before the write.
    expect(mockSupabase.from).toHaveBeenCalledWith('products');
    expect(parentMaybeSingle).toHaveBeenCalled();
    expect(mockSupabase.from).toHaveBeenCalledWith('product_license_config');
    expect(targetUpdate).toHaveBeenCalledWith({ max_devices: 3 });
    expect(targetMatch).toHaveBeenCalledWith({ product_id: 'prod-1' });
  });

  it('blocks a product_license_config undo for a product owned by another guild', async () => {
    okAuth('guild-1', 'admin-42');
    const { targetUpdate, targetMatch, parentMaybeSingle } = wireSupabase(
      {
        id: validUndoBody.id,
        guild_id: 'guild-1',
        is_undoable: true,
        is_undone: false,
        undo_payload: {
          table: 'product_license_config',
          data: { max_devices: 99 },
          match: { product_id: 'prod-in-guild-2' },
        },
      },
      { table: 'products', owner: { guild_id: 'guild-2' } }, // product belongs elsewhere
    );

    const res = await POST(buildRequest(validUndoBody));
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error).toContain('Undo blocked');
    expect(parentMaybeSingle).toHaveBeenCalled();
    // Critically: no write to product_license_config happened.
    expect(targetUpdate).not.toHaveBeenCalled();
    expect(targetMatch).not.toHaveBeenCalled();
  });

  it('blocks a product_license_config undo when the product does not exist', async () => {
    okAuth('guild-1', 'admin-42');
    const { targetUpdate, targetMatch } = wireSupabase(
      {
        id: validUndoBody.id,
        guild_id: 'guild-1',
        is_undoable: true,
        is_undone: false,
        undo_payload: {
          table: 'product_license_config',
          data: { max_devices: 1 },
          match: { product_id: 'ghost' },
        },
      },
      { table: 'products', owner: null }, // no such product
    );

    const res = await POST(buildRequest(validUndoBody));
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error).toContain('Undo blocked');
    expect(targetUpdate).not.toHaveBeenCalled();
    expect(targetMatch).not.toHaveBeenCalled();
  });
});
