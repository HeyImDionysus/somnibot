import { beforeEach, describe, expect, it, vi } from 'vitest';

import { mockGuild, mockSupabase, mockValkey } from './helpers/discord-mocks.js';
import { CrossFeatureBridge } from '../services/cross-feature-bridge.js';
import { PlatformEventBus } from '../services/event-bus.js';

vi.mock('@somnibot/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@somnibot/shared')>()),
  createLogger: () => ({
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
  }),
}));

type Mutation = {
  readonly table: string;
  readonly kind: 'update' | 'upsert';
  readonly value: Record<string, unknown>;
};

function bridgeFixture() {
  const mutations: Mutation[] = [];
  const rpc = vi.fn(async () => ({
    data: { listings_cancelled: 1, heists_forfeited: 0, wallet_suspended: true },
    error: null,
  }));
  const responses: Record<string, unknown> = {
    giveaways: [{ id: 'giveaway-1' }],
    level_unlock_configs: [{ feature_key: 'fishing', unlock_message: 'Fishing unlocked' }],
    tickets: {
      created_at: '2026-08-23T00:00:00.000Z',
      closed_at: '2026-08-23T00:02:00.000Z',
      creator_id: 'member-1',
    },
  };
  const supabase = mockSupabase();
  supabase.rpc = rpc;
  supabase.from = vi.fn((table: string) => {
    const chain: Record<string, unknown> = {};
    const fluent = () => chain;
    chain.select = vi.fn(fluent);
    chain.eq = vi.fn(fluent);
    chain.limit = vi.fn(fluent);
    chain.update = vi.fn((value: Record<string, unknown>) => {
      mutations.push({ table, kind: 'update', value });
      return chain;
    });
    chain.upsert = vi.fn((value: Record<string, unknown>) => {
      mutations.push({ table, kind: 'upsert', value });
      return chain;
    });
    chain.single = vi.fn(async () => ({ data: responses[table] ?? null, error: null }));
    chain.maybeSingle = vi.fn(async () => ({ data: responses[table] ?? null, error: null }));
    chain.then = (resolve: (value: { readonly data: unknown; readonly error: null }) => void) =>
      resolve({ data: responses[table] ?? null, error: null });
    return chain;
  });
  const valkey = mockValkey();
  valkey.smembers = vi.fn(async () => []);
  valkey.sadd = vi.fn(async () => 1);
  valkey.expire = vi.fn(async () => 1);
  valkey.hincrby = vi.fn(async () => 1);
  valkey.lpush = vi.fn(async () => 1);
  valkey.ltrim = vi.fn(async () => 'OK');
  const guild = mockGuild({ id: 'guild-1', name: 'Test Guild' });
  const eventBus = new PlatformEventBus();
  const bridge = new CrossFeatureBridge(guild, supabase, eventBus, valkey);
  bridge.start();
  return { bridge, eventBus, guild, mutations, rpc, supabase, valkey };
}

describe('CrossFeatureBridge production event integration', () => {
  let fixture: ReturnType<typeof bridgeFixture>;

  beforeEach(() => {
    fixture = bridgeFixture();
  });

  it('durably cleans giveaways, tickets, and economy after a ban', async () => {
    await fixture.eventBus.emitAndWait('member.banned', 'guild-1', {
      discordId: 'member-1', moderatorId: 'moderator-1', reason: 'spam',
    });

    expect(fixture.rpc).toHaveBeenCalledWith('giveaway_remove_entry', {
      p_giveaway_id: 'giveaway-1', p_user_id: 'member-1',
    });
    expect(fixture.rpc).toHaveBeenCalledWith('cleanup_member_economy', {
      p_guild_id: 'guild-1', p_user_id: 'member-1', p_reason: 'banned',
    });
    expect(fixture.mutations).toContainEqual({
      table: 'tickets',
      kind: 'update',
      value: expect.objectContaining({ status: 'closed', close_reason: 'User was banned' }),
    });
  });

  it('durably cleans economy after a kick', async () => {
    await fixture.eventBus.emitAndWait('member.kicked', 'guild-1', {
      discordId: 'member-2', moderatorId: 'moderator-1', reason: 'departure',
    });

    expect(fixture.rpc).toHaveBeenCalledWith('cleanup_member_economy', {
      p_guild_id: 'guild-1', p_user_id: 'member-2', p_reason: 'kicked',
    });
  });

  it('durably cleans economy after a member leaves', async () => {
    await fixture.eventBus.emitAndWait('member.left', 'guild-1', {
      discordId: 'member-2', username: 'Member', roles: ['role-1'],
    });

    expect(fixture.rpc).toHaveBeenCalledWith('cleanup_member_economy', {
      p_guild_id: 'guild-1', p_user_id: 'member-2', p_reason: 'left',
    });
  });

  it('persists level unlock entitlement and refreshes its cache', async () => {
    await fixture.eventBus.emitAndWait('level.up', 'guild-1', {
      discordId: 'member-3', previousLevel: 4, newLevel: 5, totalXp: 500,
    });

    expect(fixture.mutations).toContainEqual({
      table: 'member_feature_unlocks',
      kind: 'upsert',
      value: expect.objectContaining({
        guild_id: 'guild-1', user_id: 'member-3', feature_key: 'fishing',
      }),
    });
    expect(fixture.valkey.sadd).toHaveBeenCalledWith('unlocks:guild-1:member-3', 'fishing');
  });

  it('persists ticket-close duration and updates operational metrics', async () => {
    await fixture.eventBus.emitAndWait('ticket.closed', 'guild-1', {
      ticketId: 'ticket-1', ticketNumber: 1, channelId: 'channel-1',
      userDiscordId: '', actorId: 'moderator-1', panelId: 'panel-1',
    });

    expect(fixture.mutations).toContainEqual({
      table: 'ticket_metrics',
      kind: 'upsert',
      value: expect.objectContaining({
        ticket_id: 'ticket-1', guild_id: 'guild-1', resolution_time_ms: 120_000,
      }),
    });
    expect(fixture.valkey.hincrby).toHaveBeenCalledWith(
      'stats:tickets:guild-1', 'total_resolved', 1,
    );
  });

  it('applies moderation cleanup for a ban infraction', async () => {
    await fixture.eventBus.emitAndWait('infraction.created', 'guild-1', {
      infractionId: 'infraction-1', userId: 'member-4', moderatorId: 'mod-1',
      type: 'ban', reason: 'raid', totalInfractions: 10,
    });

    expect(fixture.rpc).toHaveBeenCalledWith('giveaway_remove_entry', {
      p_giveaway_id: 'giveaway-1', p_user_id: 'member-4',
    });
  });

  it('isolates every durable side effect from another guild', async () => {
    await fixture.eventBus.emitAndWait('member.banned', 'guild-other', {
      discordId: 'member-other', moderatorId: 'moderator-other', reason: 'other guild',
    });

    expect(fixture.rpc).not.toHaveBeenCalled();
    expect(fixture.mutations).toEqual([]);
  });
});
