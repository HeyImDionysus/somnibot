/**
 * Rail A (event rail) row shapes — drives the REAL AuditService.
 *
 * The event rail is: feature emits a platform event → AuditService maps it via
 * EVENT_TO_AUDIT → the batched flush writes audit_logs. These tests assert the
 * ROW a given event produces, which is the contract an owner reads on the
 * dashboard Audit page. Mapping tables are easy to add to and easy to get
 * subtly wrong; asserting the row (not the table) catches both.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@somnibot/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@somnibot/shared')>()),
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { AuditService } from '../features/audit/audit-service.js';

type Row = Record<string, unknown>;

/** Minimal stand-in for PlatformEventBus: onAny + a synchronous emit. */
class FakeBus {
  private any: Array<(e: unknown) => void> = [];
  onAny(handler: (e: unknown) => void): void {
    this.any.push(handler);
  }
  offAny(handler: (e: unknown) => void): void {
    const index = this.any.indexOf(handler);
    if (index >= 0) this.any.splice(index, 1);
  }
  emit(type: string, guildId: string, data: unknown): void {
    for (const h of this.any) h({ type, guildId, timestamp: Date.now(), data });
  }
}

function makeSupabase(rows: Row[]) {
  return {
    from: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({ maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }) }),
      }),
      upsert: vi.fn().mockImplementation((batch: Row[]) => {
        rows.push(...batch);
        return Promise.resolve({ error: null });
      }),
      insert: vi.fn().mockImplementation((batch: Row | Row[]) => {
        rows.push(...(Array.isArray(batch) ? batch : [batch]));
        return Promise.resolve({ error: null });
      }),
    }),
  };
}

/** Emit events through a live AuditService and return the flushed rows. */
async function rowsForAll(events: Array<[string, Record<string, unknown>]>, guildId = 'g1'): Promise<Row[]> {
  const rows: Row[] = [];
  const bus = new FakeBus();
  const service = new AuditService(guildId, makeSupabase(rows) as never, bus as never);
  service.start();
  for (const [type, data] of events) bus.emit(type, guildId, data);
  await service.stop();
  return rows;
}

/** Emit one event through a live AuditService and return the flushed rows. */
function rowsFor(type: string, data: Record<string, unknown>, guildId = 'g1'): Promise<Row[]> {
  return rowsForAll([[type, data]], guildId);
}

describe('rail A rows — music', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('music.queued records the ADD side of the shared queue', async () => {
    const rows = await rowsFor('music.queued', {
      userId: 'u1',
      title: 'Song',
      author: 'Artist',
      uri: 'https://x/y',
      trackCount: 1,
      playlistName: null,
      queueLength: 3,
      sessionStarted: true,
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      guild_id: 'g1',
      action: 'music.queued',
      category: 'music',
      actor_type: 'user',
      actor_id: 'u1',
      target_type: 'music_queue',
      target_id: 'u1',
      success: true,
    });
    expect(rows[0]!.details).toMatchObject({ title: 'Song', trackCount: 1, sessionStarted: true });
  });

  it('music.control_applied and music.denied describe the same control identically', async () => {
    const [applied] = await rowsFor('music.control_applied', { userId: 'u1', action: 'volume', value: 80 });
    const [denied] = await rowsFor('music.denied', { userId: 'u1', action: 'volume' });

    // Same category and same target shape — the ONLY difference between the
    // two outcomes of one control is the action name and the success flag.
    expect(applied!.category).toBe(denied!.category);
    expect(applied!.target_type).toBe(denied!.target_type);
    expect(applied!.target_id).toBe(denied!.target_id);
    expect(applied!.actor_id).toBe('u1');
    expect(denied!.actor_id).toBe('u1');
    expect(applied!.success).toBe(true);
    expect(denied!.success).toBe(false);
    expect(applied!.details).toMatchObject({ userId: 'u1', action: 'volume', value: 80 });
  });

  it('attributes skip and capacity rejection to the member who caused them', async () => {
    const [skipped, rejected] = await rowsForAll([
      ['music.skipped', {
        userId: 'u1',
        method: 'vote',
        title: 'Song',
        author: 'Artist',
        requestedBy: 'u9',
        queueEnded: false,
      }],
      ['music.capacity_rejected', {
        userId: 'u2',
        reason: 'queue_full',
        limit: 500,
      }],
    ]);

    expect(skipped).toMatchObject({ actor_type: 'user', actor_id: 'u1' });
    expect(rejected).toMatchObject({ actor_type: 'user', actor_id: 'u2' });
  });

  it('uses a member actor for command stops and a system actor for automatic stops', async () => {
    const [command, autoLeave, connectionLost] = await rowsForAll([
      ['music.stopped', { userId: 'u1', reason: 'command', trackCount: 2 }],
      ['music.stopped', { userId: undefined, reason: 'auto_leave', trackCount: 1 }],
      ['music.stopped', { userId: undefined, reason: 'connection_lost', trackCount: 3 }],
    ]);

    expect(command).toMatchObject({ actor_type: 'user', actor_id: 'u1' });
    expect(autoLeave).toMatchObject({ actor_type: 'system', actor_id: 'music-player' });
    expect(connectionLost).toMatchObject({ actor_type: 'system', actor_id: 'music-player' });
  });
});

/**
 * Auto-mod moved from rail B (a direct writeAuditLog per violation, inline in
 * the message pipeline) to rail A. These pin the ROW that migration must keep
 * byte-identical: same action strings, category, actor, target and details as
 * the direct writes produced. If a future edit drifts any of them, the
 * dashboard filter and the fleet's `automod.%` query silently stop matching.
 */
describe('rail A rows — automod (migrated from the direct rail)', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  const base = {
    messageId: 'm1',
    channelId: 'c1',
    memberId: 'u1',
    rule: 'No links',
    ruleType: 'invite',
    violation: 'discord.gg/x',
  };

  it('observe mode writes automod.observe.<action> against the MESSAGE', async () => {
    const rows = await rowsFor('automod.observed', { ...base, wouldAction: 'ban' });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      guild_id: 'g1',
      action: 'automod.observe.ban',
      category: 'moderation',
      actor_type: 'bot',
      actor_id: 'automod',
      target_type: 'message',
      target_id: 'm1',
      success: true,
    });
    expect(rows[0]!.details).toEqual({
      rule: 'No links',
      ruleType: 'invite',
      violation: 'discord.gg/x',
      wouldAction: 'ban',
      channelId: 'c1',
    });
  });

  it('every observe action keeps its own automod.observe.<action> string', async () => {
    const rows = await rowsForAll(
      (['delete', 'warn', 'mute', 'kick', 'ban'] as const).map((wouldAction, i) => [
        'automod.observed',
        { ...base, messageId: `m${i}`, wouldAction },
      ]),
    );

    expect(rows.map((r) => r.action)).toEqual([
      'automod.observe.delete',
      'automod.observe.warn',
      'automod.observe.mute',
      'automod.observe.kick',
      'automod.observe.ban',
    ]);
  });

  it('enforced delete targets the MESSAGE and carries the channel', async () => {
    const [row] = await rowsFor('automod.enforced', { ...base, action: 'delete' });

    expect(row).toMatchObject({
      action: 'automod.delete',
      category: 'moderation',
      actor_type: 'bot',
      actor_id: 'automod',
      target_type: 'message',
      target_id: 'm1',
    });
    expect(row!.details).toEqual({
      rule: 'No links',
      ruleType: 'invite',
      violation: 'discord.gg/x',
      channelId: 'c1',
    });
  });

  it('enforced warn targets the MEMBER and carries the infraction', async () => {
    const [row] = await rowsFor('automod.enforced', {
      ...base, action: 'warn', infractionId: 'inf1', activeWarnings: 3,
    });

    expect(row).toMatchObject({ action: 'automod.warn', target_type: 'member', target_id: 'u1' });
    expect(row!.details).toEqual({
      rule: 'No links',
      ruleType: 'invite',
      violation: 'discord.gg/x',
      infractionId: 'inf1',
      activeWarnings: 3,
    });
  });

  it('enforced mute targets the MEMBER and carries the duration', async () => {
    const [row] = await rowsFor('automod.enforced', { ...base, action: 'mute', durationMinutes: 10 });

    expect(row).toMatchObject({ action: 'automod.mute', target_type: 'member', target_id: 'u1' });
    expect(row!.details).toEqual({
      rule: 'No links',
      ruleType: 'invite',
      violation: 'discord.gg/x',
      durationMinutes: 10,
    });
  });

  it('enforced kick and ban target the MEMBER with the plain rule details', async () => {
    const rows = await rowsForAll([
      ['automod.enforced', { ...base, messageId: 'ma', action: 'kick' }],
      ['automod.enforced', { ...base, messageId: 'mb', action: 'ban' }],
    ]);

    expect(rows.map((r) => r.action)).toEqual(['automod.kick', 'automod.ban']);
    for (const row of rows) {
      expect(row).toMatchObject({ target_type: 'member', target_id: 'u1' });
      expect(row.details).toEqual({
        rule: 'No links', ruleType: 'invite', violation: 'discord.gg/x',
      });
    }
  });

  it('every automod row still matches the `automod.%` action prefix the fleet queries', async () => {
    const rows = await rowsForAll([
      ['automod.observed', { ...base, messageId: 'm1', wouldAction: 'delete' }],
      ['automod.enforced', { ...base, messageId: 'm2', action: 'delete' }],
      ['automod.enforced', { ...base, messageId: 'm3', action: 'warn' }],
      ['automod.enforced', { ...base, messageId: 'm4', action: 'mute' }],
      ['automod.enforced', { ...base, messageId: 'm5', action: 'kick' }],
      ['automod.enforced', { ...base, messageId: 'm6', action: 'ban' }],
    ]);

    expect(rows).toHaveLength(6);
    expect(rows.every((r) => String(r.action).startsWith('automod.'))).toBe(true);
  });

  it('a redelivered messageCreate collapses onto ONE row (occurrence key)', async () => {
    const rows = await rowsForAll([
      ['automod.enforced', { ...base, action: 'ban' }],
      ['automod.enforced', { ...base, action: 'ban' }],
    ]);

    // The batched rail can re-flush a failed batch; without an occurrence key
    // that would duplicate rows the direct rail never duplicated.
    expect(rows).toHaveLength(1);
    expect(rows[0]!.occurrence_key).toBe('automod.ban:m1');
  });

  it('scopes rows to the AuditService’s own guild', async () => {
    const rows: Row[] = [];
    const bus = new FakeBus();
    const service = new AuditService('g1', makeSupabase(rows) as never, bus as never);
    service.start();
    bus.emit('automod.enforced', 'other-guild', { ...base, action: 'ban' });
    await service.stop();

    expect(rows).toHaveLength(0);
  });
});
