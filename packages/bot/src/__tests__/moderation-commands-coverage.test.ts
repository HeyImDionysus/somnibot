/**
 * moderation/commands — coverage tests (635 lines)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('discord.js', () => ({
  SlashCommandBuilder: vi.fn().mockImplementation(function () {
    const self: any = {};
    for (const m of ['setName', 'setDescription', 'setDefaultMemberPermissions', 'addUserOption', 'addStringOption', 'addIntegerOption', 'addBooleanOption']) {
      self[m] = vi.fn().mockImplementation(function (this: any, cbOrVal: any) {
        if (typeof cbOrVal === 'function') {
          const opt: any = {};
          for (const o of ['setName', 'setDescription', 'setRequired', 'setMinValue', 'setMaxValue', 'addChoices']) {
            opt[o] = vi.fn().mockReturnValue(opt);
          }
          cbOrVal(opt);
        }
        return self;
      });
    }
    return self;
  }),
  EmbedBuilder: vi.fn().mockImplementation(function () {
    const e: any = {};
    for (const m of ['setColor', 'setTitle', 'setDescription', 'setFooter', 'setTimestamp', 'addFields', 'setAuthor', 'setThumbnail']) {
      e[m] = vi.fn().mockReturnValue(e);
    }
    return e;
  }),
  PermissionFlagsBits: { ModerateMembers: 1n << 40n, KickMembers: 1n << 1n, BanMembers: 1n << 2n },
}));

vi.mock('@somnibot/shared', () => ({
  SOMNI_PALETTE: { ORANGE: 0xFFA500, RED: 0xFF0000, GREEN: 0x00FF00, BLUE: 0x0000FF, HOT_PINK: 0xFF69B4 },
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('../features/moderation/infraction-service.js', () => ({
  createInfraction: vi.fn().mockResolvedValue({ infraction: { id: 'inf1', type: 'warn' }, replayed: false }),
  getMemberInfractions: vi.fn().mockResolvedValue([
    { id: 'inf1', type: 'warn', reason: 'test', created_at: '2026-01-01', active: true, moderator_id: 'mod1' },
  ]),
  getActiveWarningCount: vi.fn().mockResolvedValue(2),
  pardonInfraction: vi.fn().mockResolvedValue({ id: 'inf1', type: 'warn', pardoned: true }),
  calculateExpiryDate: vi.fn().mockReturnValue('2026-02-01'),
}));

vi.mock('../features/moderation/escalation.js', () => ({
  executeEscalation: vi.fn().mockResolvedValue(undefined),
  getEscalationAction: vi.fn().mockReturnValue(null),
}));

vi.mock('../features/moderation/mod-log.js', () => ({
  postModLogEntry: vi.fn().mockResolvedValue(undefined),
}));

import {
  buildModerationCommands,
  handleWarnCommand,
  handleMuteCommand,
  handleKickCommand,
  handleBanCommand,
  handlePardonCommand,
  handleInfractionsCommand,
} from '../features/moderation/commands.js';

import { getEscalationAction } from '../features/moderation/escalation.js';

function chain(val: any = { data: null, error: null }) {
  const c: any = {};
  for (const m of ['select', 'eq', 'maybeSingle', 'single', 'insert', 'update', 'order', 'limit']) {
    c[m] = vi.fn().mockReturnValue(c);
  }
  c.then = (res: any) => Promise.resolve(val).then(res);
  return c;
}

function client(cfgOverride: any = {}) {
  return {
    supabase: {
      from: vi.fn().mockReturnValue(chain({
        data: { escalation_chain: [], infraction_expiry_days: 30, mod_log_channel_id: 'ch1', ...cfgOverride },
        error: null,
      })),
    },
    eventBus: { emit: vi.fn() },
  };
}

function member(overrides: any = {}) {
  return {
    id: overrides.id ?? 'target1',
    user: {
      id: overrides.id ?? 'target1',
      tag: overrides.tag ?? 'Target#0001',
      bot: overrides.bot ?? false,
      createDM: vi.fn().mockResolvedValue({ send: vi.fn().mockResolvedValue(undefined) }),
    },
    roles: { highest: { position: overrides.rolePos ?? 5 } },
    moderatable: overrides.moderatable ?? true,
    kickable: overrides.kickable ?? true,
    bannable: overrides.bannable ?? true,
    timeout: vi.fn().mockResolvedValue(undefined),
    kick: vi.fn().mockResolvedValue(undefined),
    ban: vi.fn().mockResolvedValue(undefined),
  };
}

function interaction(opts: any = {}) {
  const target = 'target' in opts ? opts.target : member();
  const invokerMember = member({ id: 'mod1', rolePos: 10 });
  return {
    options: {
      getMember: vi.fn().mockReturnValue(target),
      getUser: vi.fn().mockReturnValue(target?.user ?? { id: 'target1', tag: 'Target#0001' }),
      getString: vi.fn().mockImplementation((name: string) => {
        if (name === 'reason') return opts.reason ?? 'Test reason';
        if (name === 'infraction_id') return opts.infractionId ?? 'inf1';
        return null;
      }),
      getInteger: vi.fn().mockReturnValue(opts.duration ?? 60),
      getBoolean: vi.fn().mockReturnValue(opts.activeOnly ?? null),
    },
    user: { id: 'mod1', tag: 'Mod#0001' },
    guild: {
      id: 'g1',
      name: 'Test Guild',
      ownerId: 'owner1',
      members: {
        fetch: vi.fn().mockImplementation(async (id: string) => {
          if (id === 'mod1') return invokerMember;
          if (target && id === target.id) return target;
          return target;
        }),
      },
    },
    guildId: 'g1',
    id: opts.interactionId ?? 'interaction1',
    // Server-side permission re-check gate. Grants by default; a test can pass
    // { hasPermission: false } to exercise the denial path.
    memberPermissions: { has: vi.fn().mockReturnValue(opts.hasPermission ?? true) },
    reply: vi.fn().mockResolvedValue(undefined),
    editReply: vi.fn().mockResolvedValue(undefined),
    deferReply: vi.fn().mockResolvedValue(undefined),
  };
}

describe('buildModerationCommands', () => {
  it('returns all 6 commands', () => {
    const cmds = buildModerationCommands();
    expect(cmds.warn).toBeDefined();
    expect(cmds.mute).toBeDefined();
    expect(cmds.kick).toBeDefined();
    expect(cmds.ban).toBeDefined();
    expect(cmds.pardon).toBeDefined();
    expect(cmds.infractions).toBeDefined();
  });
});

describe('handleWarnCommand', () => {
  beforeEach(() => vi.clearAllMocks());

  it('warns a member', async () => {
    const c = client();
    const i = interaction();
    await handleWarnCommand(i as any, c as any);
    expect(i.editReply).toHaveBeenCalledWith(expect.stringContaining('warned'));
  });

  it('rejects null target', async () => {
    const i = interaction({ target: null });
    await handleWarnCommand(i as any, client() as any);
    expect(i.editReply).toHaveBeenCalledWith(expect.stringContaining('Could not find'));
  });

  it('rejects bots', async () => {
    const i = interaction({ target: member({ bot: true }) });
    await handleWarnCommand(i as any, client() as any);
    expect(i.editReply).toHaveBeenCalledWith(expect.stringContaining('Cannot warn bots'));
  });

  it('rejects self-warn', async () => {
    const i = interaction({ target: member({ id: 'mod1' }) });
    await handleWarnCommand(i as any, client() as any);
    expect(i.editReply).toHaveBeenCalledWith(expect.stringContaining('cannot warn yourself'));
  });

  it('rejects server owner', async () => {
    const i = interaction({ target: member({ id: 'owner1' }) });
    await handleWarnCommand(i as any, client() as any);
    expect(i.editReply).toHaveBeenCalledWith(expect.stringContaining('server owner'));
  });

  it('rejects higher-role member', async () => {
    const i = interaction({ target: member({ rolePos: 15 }) });
    await handleWarnCommand(i as any, client() as any);
    expect(i.editReply).toHaveBeenCalledWith(expect.stringContaining('higher role'));
  });

  it('auto-escalates on threshold', async () => {
    (getEscalationAction as any).mockReturnValueOnce({ action: 'mute', duration: 60 });
    const i = interaction();
    await handleWarnCommand(i as any, client({ escalation_chain: [{ w: 3, a: 'mute' }] }) as any);
    expect(i.editReply).toHaveBeenCalledWith(expect.stringContaining('escalated'));
  });
});

describe('handleMuteCommand', () => {
  beforeEach(() => vi.clearAllMocks());

  it('mutes a member', async () => {
    const i = interaction({ duration: 60 });
    await handleMuteCommand(i as any, client() as any);
    expect(i.editReply).toHaveBeenCalledWith(expect.stringContaining('timed out'));
  });

  it('rejects null target', async () => {
    const i = interaction({ target: null });
    await handleMuteCommand(i as any, client() as any);
    expect(i.editReply).toHaveBeenCalledWith(expect.stringContaining('Could not find'));
  });

  it('rejects bots', async () => {
    const i = interaction({ target: member({ bot: true }) });
    await handleMuteCommand(i as any, client() as any);
    expect(i.editReply).toHaveBeenCalledWith(expect.stringContaining('Cannot mute bots'));
  });

  it('rejects non-moderatable', async () => {
    const i = interaction({ target: member({ moderatable: false }) });
    await handleMuteCommand(i as any, client() as any);
    expect(i.editReply).toHaveBeenCalledWith(expect.stringContaining('Cannot mute this member'));
  });
});

describe('handleKickCommand', () => {
  beforeEach(() => vi.clearAllMocks());

  it('kicks a member', async () => {
    const i = interaction();
    await handleKickCommand(i as any, client() as any);
    expect(i.editReply).toHaveBeenCalled();
  });

  it('rejects null target', async () => {
    const i = interaction({ target: null });
    await handleKickCommand(i as any, client() as any);
    expect(i.editReply).toHaveBeenCalledWith(expect.stringContaining('Could not find'));
  });
});

describe('handleBanCommand', () => {
  beforeEach(() => vi.clearAllMocks());

  it('bans a member', async () => {
    const i = interaction();
    await handleBanCommand(i as any, client() as any);
    expect(i.editReply).toHaveBeenCalled();
  });

  it('rejects null target', async () => {
    const i = interaction({ target: null });
    await handleBanCommand(i as any, client() as any);
    expect(i.editReply).toHaveBeenCalledWith(expect.stringContaining('Could not find'));
  });
});

describe('handlePardonCommand', () => {
  beforeEach(() => vi.clearAllMocks());

  it('pardons an infraction', async () => {
    const i = interaction({ infractionId: 'inf1' });
    await handlePardonCommand(i as any, client() as any);
    expect(i.editReply).toHaveBeenCalled();
  });
});

describe('handleInfractionsCommand', () => {
  beforeEach(() => vi.clearAllMocks());

  it('lists infractions', async () => {
    const i = interaction();
    await handleInfractionsCommand(i as any, client() as any);
    expect(i.editReply).toHaveBeenCalled();
  });

  it('handles active-only filter', async () => {
    const i = interaction({ activeOnly: true });
    await handleInfractionsCommand(i as any, client() as any);
    expect(i.editReply).toHaveBeenCalled();
  });

  it('denies an invoker without ModerateMembers and leaks no history', async () => {
    const i = interaction({ hasPermission: false });
    await handleInfractionsCommand(i as any, client() as any);
    // Ephemeral denial, no embed/history returned.
    expect(i.editReply).toHaveBeenCalledWith(expect.stringMatching(/permission/i));
    const calledWithEmbed = (i.editReply as any).mock.calls.some(
      (c: any[]) => c[0] && typeof c[0] === 'object' && 'embeds' in c[0],
    );
    expect(calledWithEmbed).toBe(false);
    // getMemberInfractions must not run once the gate denies.
    const { getMemberInfractions } = await import('../features/moderation/infraction-service.js');
    expect(getMemberInfractions).not.toHaveBeenCalled();
  });
});

describe('moderation command permission gates', () => {
  beforeEach(() => vi.clearAllMocks());

  it('handleBanCommand denies an invoker without BanMembers', async () => {
    const i = interaction({ hasPermission: false });
    await handleBanCommand(i as any, client() as any);
    expect(i.editReply).toHaveBeenCalledWith(expect.stringMatching(/permission/i));
    expect(i.guild.members.fetch).not.toHaveBeenCalled();
  });

  it('handleWarnCommand denies an invoker without ModerateMembers', async () => {
    const i = interaction({ hasPermission: false });
    await handleWarnCommand(i as any, client() as any);
    expect(i.editReply).toHaveBeenCalledWith(expect.stringMatching(/permission/i));
  });
});
