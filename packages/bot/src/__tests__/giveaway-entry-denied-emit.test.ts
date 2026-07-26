/**
 * Giveaway entry-rejection audit (#57).
 *
 * Entry attempts are hot (button clicks), so denials are audited via the
 * batched event rail: the role gate and the level gate each emit
 * giveaway.entry_denied (success:false at the AuditService mapping) with the
 * specific reason. A successful entry keeps emitting giveaway.entered only.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@somnibot/shared', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('discord.js', () => ({
  EmbedBuilder: class {
    setTitle() { return this; } setDescription() { return this; } setColor() { return this; }
    setTimestamp() { return this; } setFooter() { return this; } addFields() { return this; }
  },
  ActionRowBuilder: class { addComponents() { return this; } },
  ButtonBuilder: class {
    setCustomId() { return this; } setLabel() { return this; } setEmoji() { return this; }
    setStyle() { return this; } setDisabled() { return this; }
  },
  ButtonStyle: { Primary: 1, Secondary: 2, Success: 3, Danger: 4 },
}));

import { GiveawayManager } from '../features/giveaways/giveaway-manager.js';

function chain(result: any) {
  const c: any = {};
  for (const m of ['select', 'insert', 'update', 'delete', 'upsert', 'eq', 'neq', 'gt', 'gte',
    'lt', 'lte', 'in', 'is', 'not', 'order', 'limit', 'match', 'or', 'range']) {
    c[m] = vi.fn(() => c);
  }
  c.single = vi.fn(() => Promise.resolve(result));
  c.maybeSingle = vi.fn(() => Promise.resolve(result));
  c.then = (resolve: (v: any) => any) => resolve(result);
  return c;
}

function makeSupa(tables: Record<string, any> = {}) {
  return {
    from: vi.fn((t: string) => chain(tables[t] ?? { data: null, error: null })),
    rpc: vi.fn(async () => ({ data: null, error: null })),
  } as any;
}

const bus = () => ({ emit: vi.fn() }) as any;

function makeGiveaway(overrides: Record<string, unknown> = {}) {
  return {
    id: 'gw1', guild_id: 'g1', channel_id: 'ch1', message_id: null,
    prize: 'Prize', prize_product_id: null, prize_license_count: 1,
    winner_count: 1, ends_at: new Date(Date.now() + 60_000).toISOString(),
    required_role_id: null, required_level: null, required_entitlement_product_id: null,
    entries: [] as string[], winners: [] as string[],
    status: 'active', created_by: 'creator', created_at: new Date().toISOString(),
    ...overrides,
  };
}

function makeGuild(memberRoles: { has: (id: string) => boolean } = { has: () => false }) {
  const members = new Map<string, any>([
    ['u1', { id: 'u1', roles: { cache: memberRoles } }],
  ]);
  return { id: 'g1', channels: { cache: new Map() }, members: { cache: members } } as any;
}

function makeInteraction() {
  return {
    customId: 'giveaway_enter:gw1',
    user: { id: 'u1' },
    reply: vi.fn(async () => {}),
  } as any;
}

describe('giveaway.entry_denied emits', () => {
  it('emits reason=role_gate when the member lacks the required role', async () => {
    const eventBus = bus();
    const supa = makeSupa({
      giveaways: { data: makeGiveaway({ required_role_id: 'r1' }), error: null },
    });
    const mgr = new GiveawayManager(makeGuild(), supa, {} as any, eventBus);

    const handled = await mgr.handleEntry(makeInteraction());

    expect(handled).toBe(true);
    expect(eventBus.emit).toHaveBeenCalledWith('giveaway.entry_denied', 'g1',
      expect.objectContaining({ giveawayId: 'gw1', userId: 'u1', reason: 'role_gate', requiredRoleId: 'r1' }));
    expect(eventBus.emit).not.toHaveBeenCalledWith('giveaway.entered', expect.anything(), expect.anything());
  });

  it('emits reason=level_gate with the member level when below the requirement', async () => {
    const eventBus = bus();
    const supa = makeSupa({
      giveaways: { data: makeGiveaway({ required_level: 10 }), error: null },
      member_levels: { data: { level: 3 }, error: null },
    });
    const mgr = new GiveawayManager(makeGuild(), supa, {} as any, eventBus);

    await mgr.handleEntry(makeInteraction());

    expect(eventBus.emit).toHaveBeenCalledWith('giveaway.entry_denied', 'g1',
      expect.objectContaining({ reason: 'level_gate', requiredLevel: 10, userLevel: 3 }));
  });

  it('emits reason=not_active when the giveaway has ended (or is unknown/paused)', async () => {
    const eventBus = bus();
    const supa = makeSupa({
      giveaways: { data: makeGiveaway({ status: 'ended' }), error: null },
    });
    const mgr = new GiveawayManager(makeGuild(), supa, {} as any, eventBus);

    const handled = await mgr.handleEntry(makeInteraction());

    expect(handled).toBe(true);
    expect(eventBus.emit).toHaveBeenCalledWith('giveaway.entry_denied', 'g1',
      expect.objectContaining({ giveawayId: 'gw1', userId: 'u1', reason: 'not_active' }));
  });

  it('emits reason=member_not_found when the member record is missing', async () => {
    const eventBus = bus();
    const supa = makeSupa({
      giveaways: { data: makeGiveaway(), error: null },
    });
    const guild = makeGuild();
    guild.members.cache = new Map(); // no member record
    const mgr = new GiveawayManager(guild, supa, {} as any, eventBus);

    await mgr.handleEntry(makeInteraction());

    expect(eventBus.emit).toHaveBeenCalledWith('giveaway.entry_denied', 'g1',
      expect.objectContaining({ giveawayId: 'gw1', userId: 'u1', reason: 'member_not_found' }));
  });

  it('does NOT emit entry_denied when the gates pass', async () => {
    const eventBus = bus();
    const supa = makeSupa({
      giveaways: { data: makeGiveaway({ required_role_id: 'r1' }), error: null },
    });
    // giveaway_add_entry RPC returns the updated entries array
    supa.rpc = vi.fn(async () => ({ data: [{ entries: ['u1'] }], error: null }));
    const mgr = new GiveawayManager(makeGuild({ has: (id: string) => id === 'r1' }), supa, {} as any, eventBus);

    await mgr.handleEntry(makeInteraction());

    expect(eventBus.emit).not.toHaveBeenCalledWith('giveaway.entry_denied', expect.anything(), expect.anything());
    expect(eventBus.emit).toHaveBeenCalledWith('giveaway.entered', 'g1',
      expect.objectContaining({ giveawayId: 'gw1', userId: 'u1', withdrawn: false }));
  });
});

// ── AuditService mapping ────────────────────────────────────

describe('AuditService maps giveaway.entry_denied', () => {
  it('writes a failed giveaways row attributed to the denied member', async () => {
    const { AuditService } = await import('../features/audit/audit-service.js');
    const upsert = vi.fn().mockResolvedValue({ error: null });
    const supabase = { from: vi.fn().mockReturnValue({ upsert }) };
    const handlers: Array<(event: any) => void> = [];
    const auditBus = { onAny: (h: (event: any) => void) => handlers.push(h) };

    const service = new AuditService('g1', supabase as any, auditBus as any);
    service.start();
    handlers.forEach((h) => h({
      type: 'giveaway.entry_denied',
      guildId: 'g1',
      timestamp: Date.now(),
      data: { giveawayId: 'gw1', userId: 'u1', reason: 'role_gate', requiredRoleId: 'r1' },
    }));
    await (service as any).flush();
    service.stop();

    const batch = upsert.mock.calls[0][0];
    expect(batch[0]).toMatchObject({
      guild_id: 'g1',
      action: 'giveaway.entry_denied',
      category: 'giveaways',
      actor_type: 'user',
      actor_id: 'u1',
      target_id: 'gw1',
      details: { reason: 'role_gate', requiredRoleId: 'r1' },
      success: false,
    });
    // M1: actor_id already carries the member — no redundant details copy.
    expect(batch[0].details).not.toHaveProperty('userId');
    // Repeat clicks dedupe to ONE row per member/giveaway/reason.
    expect(batch[0].occurrence_key).toBe('giveaway.entry_denied:gw1:u1:role_gate');
  });

  it('dedupes repeat clicks in-queue via the member/giveaway/reason occurrence key', async () => {
    const { AuditService } = await import('../features/audit/audit-service.js');
    const upsert = vi.fn().mockResolvedValue({ error: null });
    const supabase = { from: vi.fn().mockReturnValue({ upsert }) };
    const handlers: Array<(event: any) => void> = [];
    const auditBus = { onAny: (h: (event: any) => void) => handlers.push(h) };

    const service = new AuditService('g1', supabase as any, auditBus as any);
    service.start();
    const denial = {
      type: 'giveaway.entry_denied',
      guildId: 'g1',
      timestamp: Date.now(),
      data: { giveawayId: 'gw1', userId: 'u1', reason: 'not_active' },
    };
    handlers.forEach((h) => h(denial));
    handlers.forEach((h) => h(denial)); // spam click — same key
    handlers.forEach((h) => h({
      ...denial,
      data: { giveawayId: 'gw1', userId: 'u1', reason: 'role_gate' }, // different reason → own row
    }));
    await (service as any).flush();
    service.stop();

    const batch = upsert.mock.calls[0][0];
    expect(batch).toHaveLength(2);
    expect(batch.map((r: any) => r.occurrence_key)).toEqual([
      'giveaway.entry_denied:gw1:u1:not_active',
      'giveaway.entry_denied:gw1:u1:role_gate',
    ]);
  });
});
