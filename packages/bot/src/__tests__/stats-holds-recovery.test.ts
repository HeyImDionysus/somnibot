/**
 * Round-5 review repairs that lacked dedicated units:
 *
 *  - stats-manager (3689375350): a created counter channel whose identity
 *    write fails must be deleted, not leaked — with channel_id still null,
 *    every later update would create ANOTHER channel and a restart has no id
 *    to recover the orphan with.
 *  - mass-action-hold (3689375360): owner-notice delivery must be CLAIMED
 *    before Discord is called; recording the message id only afterwards merely
 *    elects which duplicate card's id is stored.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@somnibot/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@somnibot/shared')>()),
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('discord.js', () => ({
  ChannelType: { GuildText: 0, GuildVoice: 2, GuildCategory: 4 },
}));

describe('StatsChannelManager — failed identity write does not leak the channel', () => {
  function statsSupa(channelIdWriteError: { message: string } | null) {
    return {
      from: vi.fn((table: string) => {
        const chain: any = {};
        for (const m of ['select', 'eq', 'neq', 'in', 'order', 'limit']) chain[m] = vi.fn(() => chain);
        chain.update = vi.fn((payload: Record<string, unknown>) => {
          chain._payload = payload;
          return chain;
        });
        chain.maybeSingle = vi.fn(async () => ({
          data: table === 'guild_config' ? { stats_channels_enabled: true } : null,
          error: null,
        }));
        chain.single = vi.fn(async () => ({ data: null, error: null }));
        chain.then = (resolve: (v: unknown) => void) => {
          if (chain._payload && 'channel_id' in chain._payload) {
            return resolve({ data: null, error: channelIdWriteError });
          }
          if (table === 'stats_channels' && !chain._payload) {
            return resolve({
              data: [{
                id: 'sc-new',
                guild_id: 'g1',
                channel_id: null,
                name_format: 'Members: {value}',
                type: 'member_count',
                stat_type: 'member_count',
                stat_config: {},
                enabled: true,
                last_value: null,
              }],
              error: null,
            });
          }
          return resolve({ data: null, error: null });
        };
        return chain;
      }),
    } as any;
  }

  /** Minimal discord.js Collection surface gatherStats() traverses. */
  function coll() {
    const c: any = new Map();
    c.filter = () => coll();
    c.map = () => [];
    return c;
  }

  function makeGuild(created: { id: string; delete: ReturnType<typeof vi.fn> }) {
    return {
      id: 'g1',
      name: 'G',
      memberCount: 10,
      members: { cache: coll(), fetch: vi.fn(async () => coll()) },
      roles: { cache: coll() },
      presences: { cache: coll() },
      channels: {
        cache: coll(),
        create: vi.fn(async () => created),
        fetch: vi.fn(async () => coll()),
      },
    } as any;
  }

  it('deletes the just-created channel when the identity write fails', async () => {
    const { StatsChannelManager } = await import('../features/stats-channels/stats-manager.js');
    const created = { id: 'vc-orphan', delete: vi.fn(async () => ({})) };
    const mgr = new StatsChannelManager(
      makeGuild(created),
      statsSupa({ message: 'db unavailable' }),
      60,
    );
    await mgr.start().catch(() => {});
    mgr.stop?.();

    expect(created.delete).toHaveBeenCalledTimes(1);
  });

  it('keeps the channel when the identity write succeeds', async () => {
    const { StatsChannelManager } = await import('../features/stats-channels/stats-manager.js');
    const created = { id: 'vc-kept', delete: vi.fn(async () => ({})), setName: vi.fn(async () => ({})) };
    const mgr = new StatsChannelManager(makeGuild(created), statsSupa(null), 60);
    await mgr.start().catch(() => {});
    mgr.stop?.();

    expect(created.delete).not.toHaveBeenCalled();
  });
});

describe('MassActionHoldService — owner notice is claimed before Discord is called', () => {
  const HOLD = {
    id: 'hold-1',
    guild_id: 'g1',
    automation_id: 'auto-1',
    member_count: 40,
    threshold: 25,
    created_at: new Date().toISOString(),
    notification_message_id: null as string | null,
  };

  function makeService(options: { claimWins: boolean }) {
    const calls: string[] = [];
    const updatePayloads: Array<Record<string, unknown>> = [];
    const supabase = {
      from: vi.fn((table: string) => {
        const chain: any = {};
        const filters: Record<string, unknown> = {};
        for (const m of ['select', 'order', 'limit']) chain[m] = vi.fn(() => chain);
        chain.eq = vi.fn((c: string, v: unknown) => { filters[c] = v; return chain; });
        chain.is = vi.fn((c: string, v: unknown) => { filters[`is:${c}`] = v; return chain; });
        chain.update = vi.fn((payload: Record<string, unknown>) => {
          chain._payload = payload;
          updatePayloads.push(payload);
          return chain;
        });
        chain.maybeSingle = vi.fn(async () => ({
          data: table === 'guild_config' ? { alert_channel_id: 'alerts-ch' } : null,
          error: null,
        }));
        chain.then = (resolve: (v: unknown) => void) => {
          if (chain._payload) {
            const value = String(chain._payload.notification_message_id ?? '');
            if (value.startsWith('pending:')) {
              calls.push('claim');
              return resolve({
                data: options.claimWins ? [{ id: HOLD.id }] : [],
                error: null,
              });
            }
            calls.push('record');
            return resolve({ data: [{ id: HOLD.id }], error: null });
          }
          return resolve({ data: null, error: null });
        };
        return chain;
      }),
    } as any;

    const send = vi.fn(async () => {
      calls.push('send');
      return { id: 'msg-1' };
    });
    const channel = {
      isTextBased: () => true,
      send,
      messages: { fetch: vi.fn(async () => ({ find: () => undefined })) },
    };
    const guild = { id: 'g1', channels: { cache: new Map([['alerts-ch', channel]]) } } as any;
    return { supabase, guild, calls, send, updatePayloads };
  }

  async function load() {
    const { MassActionHoldService } = await import('../features/automations/mass-action-hold.js');
    return MassActionHoldService;
  }

  it('claims delivery BEFORE sending, then records the real message id', async () => {
    const MassActionHoldService = await load();
    const { supabase, guild, calls, send } = makeService({ claimWins: true });
    const service = new MassActionHoldService(supabase, guild);

    await service.ensureOwnerNotice({ ...HOLD } as never, 'Bulk kick');

    expect(send).toHaveBeenCalledTimes(1);
    // The ordering IS the finding: claim → send → record. Send-first meant two
    // concurrent recovery paths could both post a card and the conditional
    // update could only choose which duplicate's id to keep.
    expect(calls).toEqual(['claim', 'send', 'record']);
  });

  it('sends NOTHING when another path already owns the claim', async () => {
    const MassActionHoldService = await load();
    const { supabase, guild, send } = makeService({ claimWins: false });
    const service = new MassActionHoldService(supabase, guild);

    await service.ensureOwnerNotice({ ...HOLD } as never, 'Bulk kick');

    expect(send).not.toHaveBeenCalled();
  });

  it('leaves a FRESH pending claim alone', async () => {
    const MassActionHoldService = await load();
    const { supabase, guild, send } = makeService({ claimWins: true });
    const service = new MassActionHoldService(supabase, guild);

    await service.ensureOwnerNotice(
      { ...HOLD, notification_message_id: `pending:${HOLD.id}:${Date.now()}` } as never,
      'Bulk kick',
    );

    expect(send).not.toHaveBeenCalled();
  });

  it('reclaims a STALE pending claim and delivers', async () => {
    const MassActionHoldService = await load();
    const { supabase, guild, calls, send } = makeService({ claimWins: true });
    const service = new MassActionHoldService(supabase, guild);

    await service.ensureOwnerNotice(
      { ...HOLD, notification_message_id: `pending:${HOLD.id}:${Date.now() - 20 * 60_000}` } as never,
      'Bulk kick',
    );

    // Stale sentinel released, delivery re-claimed, card posted exactly once.
    expect(send).toHaveBeenCalledTimes(1);
    expect(calls[calls.length - 1]).toBe('record');
  });
});
