/**
 * Tests for the appeals feature — AppealsManager (persistence/validation) and
 * the decision-DM notifier.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@somnibot/shared', () => ({
  createLogger: () => ({
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  }),
  SOMNI_PALETTE: { HOT_PINK: 0xff1493, CYAN: 0x00d4ff, ORANGE: 0xff6b00, NEAR_BLACK: 0x0d0d0d },
}));

vi.mock('discord.js', () => ({
  EmbedBuilder: class {
    data: Record<string, unknown> = {};
    setColor(c: unknown) { this.data.color = c; return this; }
    setTitle(t: unknown) { this.data.title = t; return this; }
    setDescription(d: unknown) { this.data.description = d; return this; }
    addFields(...f: unknown[]) { this.data.fields = f; return this; }
    setFooter() { return this; }
    setTimestamp() { return this; }
  },
}));

import {
  AppealsManager,
  calculateAppealExpiry,
  type AppealRecord,
} from '../features/appeals/appeals-manager.js';
import {
  buildDecisionDmEmbed,
  deliverDecisionDm,
  deliverDecisionDmsForGuild,
} from '../features/appeals/appeal-notifier.js';
import { defaultBrandKit } from '../features/branding/brand-kit.js';

// ── Supabase mock ─────────────────────────────────────────
// A chain whose builder methods return `this`, with terminal resolvers keyed by
// table. Each manager method makes 1–2 calls; tests set the state they need.

interface TableState {
  insertSingle: { data: unknown; error: unknown };
  maybeSingle: { data: unknown; error: unknown };
  awaited: { data: unknown; error: unknown; count?: number };
}

function makeSupa() {
  const state: Record<string, TableState> = {
    infractions: { insertSingle: { data: null, error: null }, maybeSingle: { data: null, error: null }, awaited: { data: [], error: null } },
    appeals: { insertSingle: { data: null, error: null }, maybeSingle: { data: null, error: null }, awaited: { data: [], error: null, count: 0 } },
  };
  const calls: Record<string, unknown[]> = {};
  const makeChain = (table: string) => {
    let inserting = false;
    const chain: Record<string, unknown> = {};
    const methods = ['select', 'insert', 'update', 'delete', 'eq', 'neq', 'in', 'is', 'not', 'order', 'limit', 'range', 'lte', 'gte', 'gt', 'lt', 'match'];
    for (const m of methods) {
      chain[m] = vi.fn((...args: unknown[]) => {
        (calls[`${table}.${m}`] ??= []).push(args);
        if (m === 'insert') inserting = true;
        return chain;
      });
    }
    chain.single = vi.fn(() => Promise.resolve(inserting ? state[table]!.insertSingle : state[table]!.maybeSingle));
    chain.maybeSingle = vi.fn(() => Promise.resolve(state[table]!.maybeSingle));
    chain.then = (resolve: (v: unknown) => unknown) => resolve(state[table]!.awaited);
    return chain;
  };
  return { supa: { from: vi.fn((t: string) => makeChain(t)) }, state, calls };
}

const INFRACTION = { id: 'inf-1', member_id: 'user-1' };

function appealRow(overrides: Partial<AppealRecord> = {}): AppealRecord {
  return {
    id: 'appeal-1',
    guild_id: 'guild-1',
    infraction_id: 'inf-1',
    appellant_discord_id: 'user-1',
    reason: 'Please reconsider',
    status: 'pending',
    reviewer_id: null,
    decision_notified: false,
    decided_at: null,
    created_at: '2026-07-23T00:00:00Z',
    expires_at: '2026-07-30T00:00:00Z',
    ...overrides,
  };
}

describe('AppealsManager.submit', () => {
  let supa: ReturnType<typeof makeSupa>;
  let mgr: AppealsManager;

  beforeEach(() => {
    supa = makeSupa();
    mgr = new AppealsManager(supa.supa as never);
  });

  it('creates a pending appeal when the infraction exists and belongs to the appellant', async () => {
    supa.state.infractions.maybeSingle = { data: INFRACTION, error: null };
    supa.state.appeals.insertSingle = { data: appealRow(), error: null };

    const res = await mgr.submit({
      guildId: 'guild-1', infractionId: 'inf-1', appellantDiscordId: 'user-1', reason: 'Please reconsider',
    });

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.deduped).toBe(false);
      expect(res.appeal.status).toBe('pending');
    }
  });

  it('rejects an empty or over-long reason without touching the DB', async () => {
    const res = await mgr.submit({ guildId: 'guild-1', infractionId: 'inf-1', appellantDiscordId: 'user-1', reason: '   ' });
    expect(res).toEqual({ ok: false, error: 'invalid_reason' });
    expect(supa.supa.from).not.toHaveBeenCalled();
  });

  it('rejects when the infraction does not exist in the guild', async () => {
    supa.state.infractions.maybeSingle = { data: null, error: null };
    const res = await mgr.submit({ guildId: 'guild-1', infractionId: 'nope', appellantDiscordId: 'user-1', reason: 'x' });
    expect(res).toEqual({ ok: false, error: 'infraction_not_found' });
  });

  it('rejects when the appellant is not the infraction owner (no appealing for others)', async () => {
    supa.state.infractions.maybeSingle = { data: { id: 'inf-1', member_id: 'someone-else' }, error: null };
    const res = await mgr.submit({ guildId: 'guild-1', infractionId: 'inf-1', appellantDiscordId: 'user-1', reason: 'x' });
    expect(res).toEqual({ ok: false, error: 'not_appellant' });
  });

  it('dedups a replayed submit: 23505 reads back the existing pending appeal', async () => {
    supa.state.infractions.maybeSingle = { data: INFRACTION, error: null };
    supa.state.appeals.insertSingle = { data: null, error: { code: '23505', message: 'duplicate' } };
    supa.state.appeals.maybeSingle = { data: appealRow(), error: null };

    const res = await mgr.submit({ guildId: 'guild-1', infractionId: 'inf-1', appellantDiscordId: 'user-1', reason: 'again' });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.deduped).toBe(true);
  });
});

describe('AppealsManager decide / sweep / list', () => {
  let supa: ReturnType<typeof makeSupa>;
  let mgr: AppealsManager;

  beforeEach(() => {
    supa = makeSupa();
    mgr = new AppealsManager(supa.supa as never);
  });

  it('decide returns the updated row when it was still pending', async () => {
    supa.state.appeals.maybeSingle = { data: appealRow({ status: 'approved', reviewer_id: 'owner-1' }), error: null };
    const res = await mgr.decide('guild-1', 'appeal-1', 'approved', 'owner-1');
    expect(res?.status).toBe('approved');
    // atomic guard: the update is filtered on status='pending'
    expect(supa.calls['appeals.eq']).toEqual(
      expect.arrayContaining([['status', 'pending']]),
    );
  });

  it('decide returns null when the appeal was not pending (already decided)', async () => {
    supa.state.appeals.maybeSingle = { data: null, error: null };
    const res = await mgr.decide('guild-1', 'appeal-1', 'denied', 'owner-1');
    expect(res).toBeNull();
  });

  it('sweepExpired returns the count of expired appeals', async () => {
    supa.state.appeals.awaited = { data: [{ id: 'a' }, { id: 'b' }], error: null };
    const count = await mgr.sweepExpired('guild-1');
    expect(count).toBe(2);
  });

  it('listForGuild returns the page and total count', async () => {
    supa.state.appeals.awaited = { data: [appealRow()], error: null, count: 7 };
    const res = await mgr.listForGuild('guild-1', { status: 'pending' });
    expect(res.total).toBe(7);
    expect(res.appeals).toHaveLength(1);
  });

  it('listForMember returns the member appeals', async () => {
    supa.state.appeals.awaited = { data: [appealRow(), appealRow({ id: 'appeal-2' })], error: null };
    const res = await mgr.listForMember('guild-1', 'user-1');
    expect(res).toHaveLength(2);
  });

  it('collectUndeliveredDecisions returns decided-but-unnotified rows', async () => {
    supa.state.appeals.awaited = { data: [appealRow({ status: 'denied', decided_at: '2026-07-24T00:00:00Z' })], error: null };
    const res = await mgr.collectUndeliveredDecisions('guild-1');
    expect(res).toHaveLength(1);
  });
});

describe('calculateAppealExpiry', () => {
  it('is in the future by the given number of days', () => {
    const iso = calculateAppealExpiry(7);
    const delta = new Date(iso).getTime() - Date.now();
    // ~7 days, allowing a little slack for execution time.
    expect(delta).toBeGreaterThan(6.9 * 24 * 3600 * 1000);
    expect(delta).toBeLessThan(7.1 * 24 * 3600 * 1000);
  });
});

// ── Notifier ──────────────────────────────────────────────

describe('appeal decision DM', () => {
  it('builds an approved embed', () => {
    const embed = buildDecisionDmEmbed(appealRow({ status: 'approved' }), 'Acme', defaultBrandKit('Acme'));
    expect(String(embed.data.title)).toContain('Approved');
    expect(String(embed.data.description)).toContain('Acme');
  });

  it('builds a denied embed', () => {
    const embed = buildDecisionDmEmbed(appealRow({ status: 'denied' }), 'Acme', defaultBrandKit('Acme'));
    expect(String(embed.data.title)).toContain('Denied');
    expect(String(embed.data.description)).toContain('stands');
  });

  it('delivers the DM when the user is reachable', async () => {
    const send = vi.fn().mockResolvedValue({});
    const client = { users: { fetch: vi.fn().mockResolvedValue({ send }) } };
    const outcome = await deliverDecisionDm(client as never, appealRow({ status: 'approved' }), 'Acme', defaultBrandKit('Acme'));
    expect(outcome).toBe('delivered');
    expect(send).toHaveBeenCalled();
  });

  it('reports terminal when the member cannot be DM’d (code 50007)', async () => {
    const client = { users: { fetch: vi.fn().mockResolvedValue({ send: vi.fn().mockRejectedValue({ code: 50007 }) }) } };
    const outcome = await deliverDecisionDm(client as never, appealRow({ status: 'denied' }), 'Acme', defaultBrandKit('Acme'));
    expect(outcome).toBe('terminal');
  });

  it('reports transient on an unknown error (so the latch is not burned)', async () => {
    const client = { users: { fetch: vi.fn().mockRejectedValue(new Error('network')) } };
    const outcome = await deliverDecisionDm(client as never, appealRow({ status: 'denied' }), 'Acme', defaultBrandKit('Acme'));
    expect(outcome).toBe('transient');
  });

  it('flips the latch for delivered and terminal outcomes but not transient', async () => {
    const appeals = [
      appealRow({ id: 'ok', status: 'denied' }),
      appealRow({ id: 'gone', status: 'denied' }),
      appealRow({ id: 'retry', status: 'denied' }),
    ];
    const manager = {
      collectUndeliveredDecisions: vi.fn().mockResolvedValue(appeals),
      markDecisionNotified: vi.fn().mockResolvedValue(undefined),
    };
    const fetch = vi.fn()
      .mockResolvedValueOnce({ send: vi.fn().mockResolvedValue({}) })     // ok -> delivered
      .mockResolvedValueOnce({ send: vi.fn().mockRejectedValue({ code: 50007 }) }) // gone -> terminal
      .mockRejectedValueOnce(new Error('network'));                        // retry -> transient
    const client = { users: { fetch } };

    const flipped = await deliverDecisionDmsForGuild(client as never, manager as never, 'guild-1', 'Acme');
    expect(flipped).toBe(2);
    expect(manager.markDecisionNotified).toHaveBeenCalledWith('ok');
    expect(manager.markDecisionNotified).toHaveBeenCalledWith('gone');
    expect(manager.markDecisionNotified).not.toHaveBeenCalledWith('retry');
  });
});
