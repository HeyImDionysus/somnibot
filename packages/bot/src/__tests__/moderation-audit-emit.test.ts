/**
 * observability-gap [moderation-automod] + [moderation-infractions-appeals]:
 * Manual moderation commands (/warn /mute /kick /ban) and /pardon wrote no
 * audit_logs row — they only emitted the non-audit-mapped 'moderation.action'.
 *
 * These tests spy the eventBus and assert each manual command now ALSO emits the
 * audit-mapped event (infraction.created / member.muted|kicked|banned) and that
 * /pardon emits the new 'infraction.pardoned' reversal event.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@somnibot/shared', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  SOMNI_PALETTE: { primary: 0x5865f2, success: 0x57f287, danger: 0xed4245, warning: 0xfee75c },
  InfractionType: { WARN: 'warn', MUTE: 'mute', KICK: 'kick', BAN: 'ban' },
}));

vi.mock('discord.js', async () => {
  const actual = await vi.importActual('discord.js');
  return { ...actual };
});

vi.mock('../services/audit.js', () => ({ writeAuditLog: vi.fn(async () => {}) }));
vi.mock('../features/moderation/escalation.js', () => ({
  getEscalationAction: vi.fn(() => null),
  executeEscalation: vi.fn(async () => {}),
}));
vi.mock('../features/moderation/mod-log.js', () => ({ postModLogEntry: vi.fn(async () => {}) }));
vi.mock('../features/branding/brand-kit.js', () => ({
  resolveBrandKit: vi.fn(async () => ({ primaryColor: 0x1, accentColor: 0x2, poweredByAttribution: null })),
}));

import {
  handleWarnCommand,
  handleMuteCommand,
  handleKickCommand,
  handleBanCommand,
  handlePardonCommand,
} from '../features/moderation/commands.js';

function makeChain(data: any = null) {
  const chain: any = {};
  for (const m of ['from', 'select', 'insert', 'update', 'delete', 'eq', 'order', 'limit', 'in', 'match', 'gte', 'lte', 'neq', 'or']) {
    chain[m] = vi.fn(() => chain);
  }
  chain.single = vi.fn(() => Promise.resolve({ data, error: null }));
  chain.maybeSingle = vi.fn(() => Promise.resolve({ data, error: null }));
  chain.then = (resolve: Function) => resolve({ data: data ? [data] : [], error: null, count: 0 });
  return chain;
}

function makeSupa(overrides: Record<string, any> = {}) {
  return {
    from: vi.fn((t: string) => makeChain(overrides[t] ?? null)),
    rpc: vi.fn(async () => ({ data: null, error: null })),
  } as any;
}

function makeInteraction(options: Record<string, any> = {}) {
  return {
    guildId: 'guild-1',
    user: { id: 'mod-1', username: 'Mod', tag: 'Mod#0001', displayAvatarURL: () => 'url' },
    memberPermissions: { has: () => true },
    guild: {
      id: 'guild-1', name: 'Test', ownerId: 'owner-1',
      members: {
        // id-aware: the invoking moderator (mod-1) outranks the target (target-1)
        // so the /warn role-hierarchy guard passes.
        fetch: vi.fn((id: string) =>
          Promise.resolve(
            id === 'mod-1'
              ? { id: 'mod-1', roles: { highest: { position: 10 } } }
              : {
                  id: 'target-1', displayName: 'Target',
                  user: { id: 'target-1', tag: 'Target#0001', bot: false, createDM: vi.fn().mockResolvedValue({ send: vi.fn().mockResolvedValue({}) }) },
                  roles: { highest: { position: 1 } },
                  moderatable: true, bannable: true, kickable: true,
                  timeout: vi.fn().mockResolvedValue({}),
                  kick: vi.fn().mockResolvedValue({}),
                  ban: vi.fn().mockResolvedValue({}),
                },
          ),
        ),
      },
    },
    options: {
      getUser: vi.fn(() => ({ id: 'target-1', username: 'Target', bot: false })),
      getString: vi.fn((name: string) => (name === 'reason' ? 'Test reason' : null)),
      getInteger: vi.fn(() => 60),
      getMember: vi.fn(() => ({ id: 'target-1', user: { id: 'target-1', bot: false }, roles: { highest: { position: 1 } } })),
      getBoolean: vi.fn(() => null),
      ...options,
    },
    editReply: vi.fn().mockResolvedValue({}),
    deferReply: vi.fn().mockResolvedValue({}),
  } as any;
}

describe('manual moderation commands emit audit-mapped events', () => {
  it('/warn emits infraction.created', async () => {
    const emit = vi.fn();
    const client = { supabase: makeSupa({ infractions: { id: 'inf-1', member_id: 'target-1' } }), eventBus: { emit } } as any;
    await handleWarnCommand(makeInteraction(), client);
    expect(emit).toHaveBeenCalledWith(
      'infraction.created',
      'guild-1',
      expect.objectContaining({ infractionId: 'inf-1', userId: 'target-1', type: 'warn' }),
    );
  });

  it('/mute emits member.muted', async () => {
    const emit = vi.fn();
    const client = { supabase: makeSupa({ infractions: { id: 'inf-1' } }), eventBus: { emit } } as any;
    await handleMuteCommand(makeInteraction(), client);
    expect(emit).toHaveBeenCalledWith(
      'member.muted',
      'guild-1',
      expect.objectContaining({ discordId: 'target-1', durationMinutes: 60 }),
    );
  });

  it('/kick emits member.kicked', async () => {
    const emit = vi.fn();
    const client = { supabase: makeSupa({ infractions: { id: 'inf-1' } }), eventBus: { emit } } as any;
    await handleKickCommand(makeInteraction(), client);
    expect(emit).toHaveBeenCalledWith(
      'member.kicked',
      'guild-1',
      expect.objectContaining({ discordId: 'target-1' }),
    );
  });

  it('/ban emits member.banned', async () => {
    const emit = vi.fn();
    const client = { supabase: makeSupa({ infractions: { id: 'inf-1' } }), eventBus: { emit } } as any;
    await handleBanCommand(makeInteraction({ getInteger: vi.fn(() => 0) }), client);
    expect(emit).toHaveBeenCalledWith(
      'member.banned',
      'guild-1',
      expect.objectContaining({ discordId: 'target-1' }),
    );
  });

  it('/pardon emits infraction.pardoned', async () => {
    const emit = vi.fn();
    const client = { supabase: makeSupa({ infractions: { member_id: 'target-1' } }), eventBus: { emit } } as any;
    const interaction = makeInteraction({
      getString: vi.fn((name: string) => (name === 'infraction_id' ? 'inf-abcdef12' : name === 'reason' ? 'Appeal granted' : null)),
    });
    await handlePardonCommand(interaction, client);
    expect(emit).toHaveBeenCalledWith(
      'infraction.pardoned',
      'guild-1',
      expect.objectContaining({ infractionId: 'inf-abcdef12', userId: 'target-1', moderatorId: 'mod-1' }),
    );
  });
});
