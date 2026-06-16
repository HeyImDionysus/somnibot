/**
 * temp-channels/commands — coverage tests
 *
 * Tests buildTempChannelCommands and handleTempChannelCommand.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('discord.js', () => ({
  SlashCommandBuilder: vi.fn().mockImplementation(function () {
    return {
      setName: vi.fn().mockReturnThis(),
      setDescription: vi.fn().mockReturnThis(),
      addSubcommand: vi.fn().mockImplementation(function (this: any, cb: any) {
        cb({
          setName: vi.fn().mockReturnThis(),
          setDescription: vi.fn().mockReturnThis(),
          addIntegerOption: vi.fn().mockImplementation(function (this: any, cb2: any) {
            cb2({ setName: vi.fn().mockReturnThis(), setDescription: vi.fn().mockReturnThis(), setRequired: vi.fn().mockReturnThis(), setMinValue: vi.fn().mockReturnThis(), setMaxValue: vi.fn().mockReturnThis() });
            return this;
          }),
          addStringOption: vi.fn().mockImplementation(function (this: any, cb2: any) {
            cb2({ setName: vi.fn().mockReturnThis(), setDescription: vi.fn().mockReturnThis(), setRequired: vi.fn().mockReturnThis(), setMaxLength: vi.fn().mockReturnThis() });
            return this;
          }),
          addUserOption: vi.fn().mockImplementation(function (this: any, cb2: any) {
            cb2({ setName: vi.fn().mockReturnThis(), setDescription: vi.fn().mockReturnThis(), setRequired: vi.fn().mockReturnThis() });
            return this;
          }),
        });
        return this;
      }),
    };
  }),
  PermissionFlagsBits: {},
  ChannelType: {},
}));

vi.mock('@somnibot/shared', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { buildTempChannelCommands, handleTempChannelCommand } from '../features/temp-channels/commands.js';

function makeManager(overrides: any = {}) {
  return {
    isTempChannel: vi.fn().mockReturnValue(true),
    getChannelOwner: vi.fn().mockReturnValue('u1'),
    getHubForChannel: vi.fn().mockReturnValue({ moderator_roles: [] }),
    transferOwnership: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function makeInteraction(sub: string, options: Record<string, any> = {}) {
  return {
    options: {
      getSubcommand: () => sub,
      getInteger: vi.fn().mockImplementation((name: string) => options[name]),
      getString: vi.fn().mockImplementation((name: string) => options[name]),
      getUser: vi.fn().mockImplementation((name: string) => options[name] ?? { id: 'target-user' }),
    },
    member: { id: 'u1' },
    user: { id: 'u1' },
    guild: {
      id: 'g1',
      members: {
        cache: new Map([
          ['u1', {
            voice: { channelId: 'vc1' },
            roles: { cache: new Map() },
          }],
        ]),
      },
      channels: {
        cache: new Map([
          ['vc1', {
            id: 'vc1',
            permissionOverwrites: {
              edit: vi.fn().mockResolvedValue(undefined),
              create: vi.fn().mockResolvedValue(undefined),
            },
            setUserLimit: vi.fn().mockResolvedValue(undefined),
            setName: vi.fn().mockResolvedValue(undefined),
            members: new Map(),
          }],
        ]),
      },
    },
    reply: vi.fn().mockResolvedValue(undefined),
    replied: false,
    deferred: false,
  };
}

describe('buildTempChannelCommands', () => {
  it('builds the voice command', () => {
    const cmd = buildTempChannelCommands();
    expect(cmd).toBeDefined();
  });
});

describe('handleTempChannelCommand', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('returns error when not in a server', async () => {
    const interaction = makeInteraction('lock');
    interaction.member = null as any;
    await handleTempChannelCommand(interaction as any, makeManager() as any);
    expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({
      content: expect.stringContaining('only be used in a server'),
    }));
  });

  it('returns error when not in a temp channel', async () => {
    const manager = makeManager({ isTempChannel: vi.fn().mockReturnValue(false) });
    const interaction = makeInteraction('lock');
    await handleTempChannelCommand(interaction as any, manager as any);
    expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({
      content: expect.stringContaining('temporary voice channel'),
    }));
  });

  it('returns error when not owner and not mod', async () => {
    const manager = makeManager({ getChannelOwner: vi.fn().mockReturnValue('other-user') });
    const interaction = makeInteraction('lock');
    await handleTempChannelCommand(interaction as any, manager as any);
    expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({
      content: expect.stringContaining('owner or moderators'),
    }));
  });

  it('handles lock subcommand', async () => {
    const interaction = makeInteraction('lock');
    await handleTempChannelCommand(interaction as any, makeManager() as any);
    expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({
      content: expect.stringContaining('locked'),
    }));
  });

  it('handles unlock subcommand', async () => {
    const interaction = makeInteraction('unlock');
    await handleTempChannelCommand(interaction as any, makeManager() as any);
    expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({
      content: expect.stringContaining('unlocked'),
    }));
  });

  it('handles limit subcommand', async () => {
    const interaction = makeInteraction('limit', { count: 10 });
    await handleTempChannelCommand(interaction as any, makeManager() as any);
    expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({
      content: expect.stringContaining('10'),
    }));
  });

  it('handles limit 0 (remove limit)', async () => {
    const interaction = makeInteraction('limit', { count: 0 });
    await handleTempChannelCommand(interaction as any, makeManager() as any);
    expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({
      content: expect.stringContaining('removed'),
    }));
  });

  it('handles name subcommand', async () => {
    const interaction = makeInteraction('name', { name: 'My Channel' });
    await handleTempChannelCommand(interaction as any, makeManager() as any);
    expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({
      content: expect.stringContaining('My Channel'),
    }));
  });

  it('handles permit subcommand', async () => {
    const interaction = makeInteraction('permit', { user: { id: 'target-user' } });
    await handleTempChannelCommand(interaction as any, makeManager() as any);
    expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({
      content: expect.stringContaining('can now join'),
    }));
  });

  it('handles deny subcommand', async () => {
    const interaction = makeInteraction('deny', { user: { id: 'target-user' } });
    await handleTempChannelCommand(interaction as any, makeManager() as any);
    expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({
      content: expect.stringContaining('no longer join'),
    }));
  });

  it('handles ban subcommand (kicks and denies)', async () => {
    const vc = makeInteraction('ban').guild.channels.cache.get('vc1')!;
    (vc as any).members.set('target-user', { voice: { disconnect: vi.fn().mockResolvedValue(undefined) } });
    const interaction = makeInteraction('ban', { user: { id: 'target-user' } });
    // Patch channel to have the member
    interaction.guild.channels.cache.set('vc1', vc);
    await handleTempChannelCommand(interaction as any, makeManager() as any);
    expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({
      content: expect.stringContaining('banned'),
    }));
  });

  it('handles claim subcommand when owner left', async () => {
    const manager = makeManager({ getChannelOwner: vi.fn().mockReturnValue('old-owner') });
    const interaction = makeInteraction('claim');
    // Owner not in channel members
    await handleTempChannelCommand(interaction as any, manager as any);
    expect(manager.transferOwnership).toHaveBeenCalledWith('vc1', 'u1');
    expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({
      content: expect.stringContaining('owner'),
    }));
  });

  it('rejects claim when owner is still present', async () => {
    const interaction = makeInteraction('claim');
    const vc = interaction.guild.channels.cache.get('vc1')!;
    (vc as any).members.set('u1', {}); // Current user
    (vc as any).members.set('old-owner', {}); // Owner still present
    const manager = makeManager({ getChannelOwner: vi.fn().mockReturnValue('old-owner') });
    // Make vc.members.has return true for ownerId
    await handleTempChannelCommand(interaction as any, manager as any);
    expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({
      content: expect.stringContaining('still in the channel'),
    }));
  });

  it('handles error in command execution', async () => {
    const interaction = makeInteraction('lock');
    const vc = interaction.guild.channels.cache.get('vc1')!;
    (vc as any).permissionOverwrites.edit.mockRejectedValue(new Error('boom'));
    await handleTempChannelCommand(interaction as any, makeManager() as any);
    expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({
      content: expect.stringContaining('error occurred'),
    }));
  });
});
