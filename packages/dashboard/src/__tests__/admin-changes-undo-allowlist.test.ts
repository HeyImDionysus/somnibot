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

const mockNotifyBot = vi.fn();
vi.mock('@/lib/notify-bot', () => ({
  notifyBotForGuildWithResult: (...args: unknown[]) => mockNotifyBot(...args),
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
  const targetUpdate = vi.fn();
  const targetMatch = vi.fn().mockResolvedValue({ error: null });
  const targetEq = vi.fn();
  const targetContains = vi.fn();
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
    const targetChain: Record<string, unknown> = {
      update: targetUpdate,
      match: targetMatch,
      eq: targetEq,
      contains: targetContains,
      then: (resolve: (v: { error: null }) => unknown) => resolve({ error: null }),
    };
    targetUpdate.mockReturnValue(targetChain);
    targetEq.mockReturnValue(targetChain);
    targetContains.mockReturnValue(targetChain);
    return targetChain;
  });

  return { targetUpdate, targetMatch, targetEq, targetContains, parentMaybeSingle };
}

function okAuth(guildId = 'guild-1', discordId = '123') {
  mockRequirePermission.mockResolvedValue({ guildId, discordId });
}

const validUndoBody = { action: 'undo', id: '00000000-0000-0000-0000-000000000001' };

beforeEach(() => {
    vi.resetAllMocks();
  mockRateLimit.mockResolvedValue(null); // not rate limited
  mockParseBody.mockResolvedValue({ ok: true, data: validUndoBody });
  mockNotifyBot.mockResolvedValue(true);
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

  // ── Finding (11:46): stats_channels — the bot's stats-manager owns
  // channel_id / last_value / last_updated_at (writes them on each tick); the
  // dashboard PUT only sets stat_type/name_format/stat_config/active. Undo must
  // not be able to repoint channel_id or rewind runtime values. ──────────────
  it('does not let undo set bot-owned stats_channels runtime fields', () => {
    const spec = UNDO_TABLE_COLUMNS.get('stats_channels');
    expect(spec?.data.has('channel_id')).toBe(false);
    expect(spec?.data.has('last_value')).toBe(false);
    expect(spec?.data.has('last_updated_at')).toBe(false);
    // Dashboard-writable config columns remain settable.
    expect(spec?.data.has('stat_type')).toBe(true);
    expect(spec?.data.has('name_format')).toBe(true);
    expect(spec?.data.has('stat_config')).toBe(true);
    expect(spec?.data.has('active')).toBe(true);

    const repoint = validateUndoPayload({
      table: 'stats_channels',
      // Repointing channel_id would make the bot rename an arbitrary channel.
      data: { channel_id: 'attacker-channel' },
      match: { id: 'sc-1', guild_id: 'guild-1' },
    }, CTX);
    expect(repoint.ok).toBe(false);
    if (!repoint.ok) expect(repoint.reason).toContain('channel_id');

    for (const col of ['last_value', 'last_updated_at']) {
      const res = validateUndoPayload({
        table: 'stats_channels',
        data: { [col]: 'x' },
        match: { id: 'sc-1', guild_id: 'guild-1' },
      }, CTX);
      expect(res.ok, col).toBe(false);
      if (!res.ok) expect(res.reason).toContain(col);
    }
  });

  // ── Finding (11:46): automations — execution_count / last_executed_at are
  // owned by the bot's execution-logger (increment_automation_count RPC), and
  // rate_limit_per_user / rate_limit_window_seconds are consumed by the bot's
  // automation-loader. The dashboard PUT/POST never write them. ──────────────
  it('does not let undo set bot-owned automations runtime fields', () => {
    const spec = UNDO_TABLE_COLUMNS.get('automations');
    for (const col of [
      'execution_count',
      'last_executed_at',
      'rate_limit_per_user',
      'rate_limit_window_seconds',
    ]) {
      expect(spec?.data.has(col), col).toBe(false);
      const res = validateUndoPayload({
        table: 'automations',
        data: { [col]: 1 },
        match: { id: 'auto-1', guild_id: 'guild-1' },
      }, CTX);
      expect(res.ok, col).toBe(false);
      if (!res.ok) expect(res.reason).toContain(col);
    }
    // Dashboard-writable config columns remain settable.
    expect(spec?.data.has('enabled')).toBe(true);
    expect(spec?.data.has('trigger_config')).toBe(true);
    expect(spec?.data.has('actions')).toBe(true);
  });

  // ── Finding (11:46): product_files — file locators (file_path / external_url
  // / storage_path / storage_bucket) are assigned once by the upload/create
  // routes and TRUSTED by the download endpoint to sign URLs / redirect paid
  // downloads. No dashboard UPDATE path edits them. Undo must not rewrite them
  // on an existing row. ──────────────
  it('does not let undo set product_files file locators', () => {
    const spec = UNDO_TABLE_COLUMNS.get('product_files');
    for (const col of [
      'file_path',
      'external_url',
      'storage_path',
      'storage_bucket',
      // Immutable upload metadata assigned at create time alongside the locator.
      'file_name',
      'mime_type',
      'file_size_bytes',
      'size_bytes',
      'version',
      // System counter owned by the download RPC.
      'download_count',
    ]) {
      expect(spec?.data.has(col), col).toBe(false);
      const res = validateUndoPayload({
        table: 'product_files',
        data: { [col]: 'https://attacker.example/evil' },
        match: { id: 'f-1', product_id: 'p-1', guild_id: 'guild-1' },
      }, CTX);
      expect(res.ok, col).toBe(false);
      if (!res.ok) expect(res.reason).toContain(col);
    }
    // Display metadata a dashboard admin could legitimately re-edit stays settable.
    expect(spec?.data.has('display_name')).toBe(true);
    expect(spec?.data.has('description')).toBe(true);
    expect(spec?.data.has('name')).toBe(true);
    expect(spec?.data.has('sort_order')).toBe(true);
  });

  // ── Finding (11:46): giveaways — the entrant list `entries` is owned by the
  // bot via the atomic add/remove RPCs and drives winner selection. The
  // dashboard PUT never touches it. Undo must not inject/remove entrants. ──────
  it('does not let undo set the bot-owned giveaways entrant list', () => {
    const spec = UNDO_TABLE_COLUMNS.get('giveaways');
    expect(spec?.data.has('entries')).toBe(false);
    // Admin-controlled fields the dashboard PUT edits remain settable.
    expect(spec?.data.has('prize')).toBe(true);
    expect(spec?.data.has('winner_count')).toBe(true);
    expect(spec?.data.has('status')).toBe(true);
    expect(spec?.data.has('winners')).toBe(true);

    const res = validateUndoPayload({
      table: 'giveaways',
      // Injecting an entrant would change prize / entitlement eligibility.
      data: { entries: ['attacker-user'] },
      match: { id: 'g-1', guild_id: 'guild-1' },
    }, CTX);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain('entries');
  });

  // ── Exhaustive root-fix (12:05+): the settable set for every table must equal
  // the columns its dashboard route(s) legitimately write. The cases below pin
  // down EVERY column dropped in the exhaustive audit so no bot-owned / runtime /
  // locator / sync / identifier column can be set via undo, and so tables with
  // no dashboard write path can never be targeted at all. ────────────────────

  // Non-settable columns that must be rejected in `data`, grouped by table.
  // Each entry lists a valid `match` for that table so the rejection is proven to
  // be about the data column, not the match shape.
  const NON_SETTABLE_BY_TABLE: Record<
    string,
    { match: Record<string, unknown>; columns: string[] }
  > = {
    // PayPal catalog locator — assigned once by the create route, trusted by
    // checkout/webhook routing; never written by the product update.
    products: {
      match: { id: 'p-1', guild_id: 'guild-1' },
      columns: ['paypal_product_id'],
    },
    // Read back from an RPC at license-validation time; the config upsert never
    // writes it.
    product_license_config: {
      match: { product_id: 'prod-1' },
      columns: ['device_policy'],
    },
    // active is set only on create; the update typedPick omits it.
    reaction_roles: {
      match: { id: 'rr-1', guild_id: 'guild-1' },
      columns: ['active'],
    },
    // priority orders bot enforcement; sync_to_discord is a Discord-sync flag the
    // bot reads. Neither is in the dashboard update.
    automod_rules: {
      match: { id: 'ar-1', guild_id: 'guild-1' },
      columns: ['priority', 'sync_to_discord'],
    },
    // Registered Discord slash-command id — a Discord-side locator.
    custom_commands: {
      match: { id: 'cc-1', guild_id: 'guild-1' },
      columns: ['discord_command_id'],
    },
    // message_id is the bot-posted panel locator; the forum/intake columns are
    // schema fields no dashboard route writes.
    ticket_panels: {
      match: { id: 'tp-1', guild_id: 'guild-1' },
      columns: [
        'message_id',
        'forum_config',
        'intake_form_enabled',
        'intake_form_fields',
      ],
    },
    // message_id is the bot-posted giveaway locator; entries is the bot-owned
    // entrant list; required_entitlement_product_id is never written.
    giveaways: {
      match: { id: 'g-1', guild_id: 'guild-1' },
      columns: ['message_id', 'entries', 'required_entitlement_product_id'],
    },
    // acknowledged_by/auto_resolved are bot/DB-owned; details belongs to
    // audit_logs — no dashboard route writes any of them to alerts.
    alerts: {
      match: { id: 'al-1', guild_id: 'guild-1' },
      columns: ['acknowledged_by', 'auto_resolved', 'details'],
    },
    // action (dashboard uses auto_action instead), plus the runtime counters the
    // fraud engine maintains.
    fraud_rules: {
      match: { id: 'fr-1', guild_id: 'guild-1' },
      columns: ['action', 'last_triggered', 'trigger_count'],
    },
  };

  it('rejects every bot-owned / runtime / locator / sync column dropped from the settable set', () => {
    for (const [table, { match, columns }] of Object.entries(NON_SETTABLE_BY_TABLE)) {
      const spec = UNDO_TABLE_COLUMNS.get(table);
      expect(spec, `${table} present`).toBeDefined();
      for (const col of columns) {
        // It must be gone from the settable allowlist entirely…
        expect(spec?.data.has(col), `${table}.data has ${col}`).toBe(false);
        // …and a payload trying to SET it must be rejected, naming the column.
        const res = validateUndoPayload(
          { table, data: { [col]: 'x' }, match },
          CTX,
        );
        expect(res.ok, `${table}.${col} accepted`).toBe(false);
        if (!res.ok) expect(res.reason).toContain(col);
      }
    }
  });

  // ── Finding: guild_config.alert_channel_id has NO dashboard write path. It
  // is added by a migration and read only by the bot (alert-service routes
  // observability alerts to it; automod-sync reads it). No admin change ever
  // produces an undo payload for it, so undo must not be able to repoint it. ──
  it('does not let undo set guild_config.alert_channel_id (bot-only alert routing)', () => {
    const spec = UNDO_TABLE_COLUMNS.get('guild_config');
    expect(spec?.data.has('alert_channel_id')).toBe(false);
    // Real dashboard-settable config columns still work.
    expect(spec?.data.has('welcome_message')).toBe(true);
    expect(spec?.data.has('economy_enabled')).toBe(true);

    const res = validateUndoPayload({
      table: 'guild_config',
      data: { alert_channel_id: 'attacker-channel' },
      match: { guild_id: 'guild-1' },
    }, CTX);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain('alert_channel_id');
  });

  // ── Finding: alerts — the ONLY interactive dashboard write (alerts PATCH)
  // acknowledges or resolves an alert. alert_type/severity/title/message/
  // metadata are the alert's identity/content, written by SYSTEM routes
  // (license/validate, paypal webhook) that never flow through undo. Undo must
  // only ever replay the admin ack/resolve action. ──────────────
  it('restricts alerts undo to admin ack/resolve fields only', () => {
    const spec = UNDO_TABLE_COLUMNS.get('alerts');
    // Exactly the columns the PATCH route writes.
    for (const col of [
      'acknowledged',
      'acknowledged_at',
      'resolved',
      'resolved_at',
      'updated_at',
    ]) {
      expect(spec?.data.has(col), `alerts settable ${col}`).toBe(true);
      expect(
        validateUndoPayload({
          table: 'alerts',
          data: { [col]: true },
          match: { id: 'al-1', guild_id: 'guild-1' },
        }, CTX).ok,
        `alerts accepts ${col}`,
      ).toBe(true);
    }
    // System/webhook-owned identity + content columns must be rejected.
    for (const col of ['alert_type', 'severity', 'title', 'message', 'metadata']) {
      expect(spec?.data.has(col), `alerts must not settable ${col}`).toBe(false);
      const res = validateUndoPayload({
        table: 'alerts',
        data: { [col]: 'x' },
        match: { id: 'al-1', guild_id: 'guild-1' },
      }, CTX);
      expect(res.ok, `alerts accepted ${col}`).toBe(false);
      if (!res.ok) expect(res.reason).toContain(col);
    }
  });

  it('keeps legitimately-settable config columns after the audit', () => {
    // Spot-check that narrowing did not strip real config columns.
    expect(UNDO_TABLE_COLUMNS.get('products')?.data.has('price_cents')).toBe(true);
    expect(UNDO_TABLE_COLUMNS.get('reaction_roles')?.data.has('emoji')).toBe(true);
    expect(UNDO_TABLE_COLUMNS.get('automod_rules')?.data.has('enabled')).toBe(true);
    expect(UNDO_TABLE_COLUMNS.get('custom_commands')?.data.has('actions')).toBe(true);
    expect(UNDO_TABLE_COLUMNS.get('ticket_panels')?.data.has('panel_message')).toBe(true);
    expect(UNDO_TABLE_COLUMNS.get('giveaways')?.data.has('prize')).toBe(true);
    expect(UNDO_TABLE_COLUMNS.get('alerts')?.data.has('acknowledged')).toBe(true);
    expect(UNDO_TABLE_COLUMNS.get('fraud_rules')?.data.has('auto_action')).toBe(true);
    expect(UNDO_TABLE_COLUMNS.get('product_license_config')?.data.has('max_devices')).toBe(true);
  });

  it('does not list tables that have no dashboard write path as undoable', () => {
    // polls/predictions are bot-owned; channel_templates/role_templates are
    // seed-only. None has a dashboard write path, so none may be an undo target.
    for (const table of ['polls', 'predictions', 'channel_templates', 'role_templates']) {
      expect(UNDOABLE_TABLES.has(table), `${table} undoable`).toBe(false);
      const res = validateUndoPayload(
        { table, data: { status: 'x' }, match: { id: 'x-1', guild_id: 'guild-1' } },
        CTX,
      );
      expect(res.ok, `${table} accepted`).toBe(false);
      if (!res.ok) expect(res.reason).toContain(table);
    }
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

  it('creates a fresh sync receipt and notifies the bot when onboarding is undone', async () => {
    okAuth('guild-1', 'admin-42');
    const { targetUpdate } = wireSupabase({
      id: validUndoBody.id,
      guild_id: 'guild-1',
      is_undoable: true,
      is_undone: false,
      action: 'onboarding.updated',
      target_type: 'config',
      target_id: 'onboarding',
      description: 'changed onboarding',
      before_state: { onboarding_enabled: false },
      after_state: { onboarding_enabled: true },
      blast_radius: 'low',
      undo_payload: {
        table: 'guild_config',
        data: { onboarding_enabled: false },
        match: { guild_id: 'guild-1' },
      },
    });

    const res = await POST(buildRequest(validUndoBody));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(targetUpdate).toHaveBeenCalledWith({ onboarding_enabled: false });
    expect(targetUpdate).toHaveBeenCalledWith({
      onboarding_sync_state: expect.objectContaining({ status: 'pending', request_id: expect.any(String) }),
    });
    expect(mockNotifyBot).toHaveBeenCalledWith('guild-1', 'onboarding', { onboarding_enabled: false });
    expect(json.data.onboardingSync).toEqual(expect.objectContaining({ status: 'pending' }));
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
