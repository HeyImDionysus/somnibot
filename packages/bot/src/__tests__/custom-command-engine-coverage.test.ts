/**
 * custom-commands/command-engine — coverage tests
 *
 * Tests loadCustomCommands, handleCustomCommand, isCustomCommand,
 * clearCommandRegistry with REAL imports.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('discord.js', () => ({
  REST: vi.fn(),
  EmbedBuilder: vi.fn().mockImplementation(function () {
    return {
      setTitle: vi.fn().mockReturnThis(),
      setDescription: vi.fn().mockReturnThis(),
      setColor: vi.fn().mockReturnThis(),
      setImage: vi.fn().mockReturnThis(),
      setThumbnail: vi.fn().mockReturnThis(),
      setFooter: vi.fn().mockReturnThis(),
      addFields: vi.fn().mockReturnThis(),
    };
  }),
}));

vi.mock('@somnibot/shared', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import {
  loadCustomCommands,
  handleCustomCommand,
  isCustomCommand,
  clearCommandRegistry,
} from '../features/custom-commands/command-engine.js';

function chainBuilder(resolveValue: any = { data: null, error: null }) {
  const chain: any = {};
  for (const m of ['select', 'eq', 'limit']) {
    chain[m] = vi.fn().mockReturnValue(chain);
  }
  chain.then = (res: any, rej?: any) => Promise.resolve(resolveValue).then(res, rej);
  return chain;
}

function makeSupabase(commands: any[] = []) {
  return {
    from: vi.fn().mockReturnValue(chainBuilder({ data: commands, error: null })),
  };
}

function makeGuild(channels: Record<string, any> = {}) {
  return {
    id: 'g1',
    name: 'Test Guild',
    memberCount: 100,
    channels: { cache: new Map(Object.entries(channels)) },
    members: {
      fetch: vi.fn().mockResolvedValue({
        roles: { add: vi.fn().mockResolvedValue(undefined), remove: vi.fn().mockResolvedValue(undefined) },
      }),
    },
  };
}

function makeInteraction(commandName: string, overrides: any = {}) {
  return {
    commandName,
    user: {
      id: 'u1',
      username: 'TestUser',
      send: vi.fn().mockResolvedValue(undefined),
    },
    channelId: 'ch1',
    channel: { send: vi.fn().mockResolvedValue(undefined) },
    guild: { name: 'Test Guild', memberCount: 100 },
    member: {
      roles: { cache: new Map([['role1', { id: 'role1' }]]) },
    },
    reply: vi.fn().mockResolvedValue(undefined),
    followUp: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function makeValkey() {
  const store = new Map<string, string>();
  return {
    get: vi.fn().mockImplementation((k: string) => Promise.resolve(store.get(k) ?? null)),
    // Honors the atomic SET NX form used by the cooldown claim: when 'NX' is
    // passed and the key already exists, the write is refused (returns null),
    // otherwise it sets and returns 'OK'.
    set: vi.fn().mockImplementation((k: string, v: string, ...args: any[]) => {
      const nx = args.includes('NX');
      if (nx && store.has(k)) return Promise.resolve(null);
      store.set(k, v);
      return Promise.resolve('OK');
    }),
    ttl: vi.fn().mockResolvedValue(30),
    _store: store,
  };
}

const sampleCmd = {
  name: 'hello',
  description: 'Say hello',
  enabled: true,
  guild_id: 'g1',
  ephemeral: false,
  allowed_roles: [],
  denied_roles: [],
  allowed_channels: [],
  denied_channels: [],
  cooldown_seconds: 0,
  actions: [{ type: 'send_message', message: 'Hello {user.name}!' }],
};

describe('loadCustomCommands', () => {
  beforeEach(() => { clearCommandRegistry(); vi.clearAllMocks(); });

  it('loads commands into registry', async () => {
    const supabase = makeSupabase([sampleCmd]);
    const guild = makeGuild();
    const bodies = await loadCustomCommands(supabase as any, guild as any, {} as any);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]!.name).toBe('hello');
    expect(isCustomCommand('hello')).toBe(true);
  });

  it('returns empty when no commands', async () => {
    const supabase = makeSupabase([]);
    const guild = makeGuild();
    const bodies = await loadCustomCommands(supabase as any, guild as any, {} as any);
    expect(bodies).toHaveLength(0);
  });

  it('clears previous registry on reload', async () => {
    const supabase = makeSupabase([sampleCmd]);
    const guild = makeGuild();
    await loadCustomCommands(supabase as any, guild as any, {} as any);
    expect(isCustomCommand('hello')).toBe(true);

    const supabase2 = makeSupabase([]);
    await loadCustomCommands(supabase2 as any, guild as any, {} as any);
    expect(isCustomCommand('hello')).toBe(false);
  });
});

describe('handleCustomCommand', () => {
  beforeEach(async () => {
    clearCommandRegistry();
    vi.clearAllMocks();
  });

  it('returns false for unknown command', async () => {
    const interaction = makeInteraction('unknown');
    const valkey = makeValkey();
    const result = await handleCustomCommand(interaction as any, {} as any, valkey as any, makeGuild() as any);
    expect(result).toBe(false);
  });

  it('executes send_message action', async () => {
    const supabase = makeSupabase([sampleCmd]);
    const guild = makeGuild();
    await loadCustomCommands(supabase as any, guild as any, {} as any);

    const interaction = makeInteraction('hello');
    const valkey = makeValkey();
    const result = await handleCustomCommand(interaction as any, supabase as any, valkey as any, guild as any);
    expect(result).toBe(true);
    expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({
      content: 'Hello TestUser!',
    }));
  });

  it('blocks user without allowed role', async () => {
    const cmd = { ...sampleCmd, allowed_roles: ['admin-role'] };
    const supabase = makeSupabase([cmd]);
    const guild = makeGuild();
    await loadCustomCommands(supabase as any, guild as any, {} as any);

    const interaction = makeInteraction('hello');
    const valkey = makeValkey();
    const result = await handleCustomCommand(interaction as any, supabase as any, valkey as any, guild as any);
    expect(result).toBe(true);
    // The denial template names the command and guild (branded copy), not a
    // generic string.
    expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({
      content: expect.stringContaining('/hello'),
    }));
    expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({
      content: expect.stringContaining('Test Guild'),
    }));
  });

  it('blocks user with denied role', async () => {
    const cmd = { ...sampleCmd, denied_roles: ['role1'] };
    const supabase = makeSupabase([cmd]);
    const guild = makeGuild();
    await loadCustomCommands(supabase as any, guild as any, {} as any);

    const interaction = makeInteraction('hello');
    const valkey = makeValkey();
    const result = await handleCustomCommand(interaction as any, supabase as any, valkey as any, guild as any);
    expect(result).toBe(true);
    expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({
      content: expect.stringContaining('permission'),
    }));
    // Denied-role reply also renders the branded command name.
    expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({
      content: expect.stringContaining('/hello'),
    }));
  });

  it('blocks user in denied channel', async () => {
    const cmd = { ...sampleCmd, denied_channels: ['ch1'] };
    const supabase = makeSupabase([cmd]);
    const guild = makeGuild();
    await loadCustomCommands(supabase as any, guild as any, {} as any);

    const interaction = makeInteraction('hello');
    const valkey = makeValkey();
    const result = await handleCustomCommand(interaction as any, supabase as any, valkey as any, guild as any);
    expect(result).toBe(true);
    expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({
      content: expect.stringContaining("can't be used"),
    }));
  });

  it('blocks user outside allowed channels', async () => {
    const cmd = { ...sampleCmd, allowed_channels: ['other-ch'] };
    const supabase = makeSupabase([cmd]);
    const guild = makeGuild();
    await loadCustomCommands(supabase as any, guild as any, {} as any);

    const interaction = makeInteraction('hello');
    const valkey = makeValkey();
    const result = await handleCustomCommand(interaction as any, supabase as any, valkey as any, guild as any);
    expect(result).toBe(true);
    expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({
      content: expect.stringContaining("can't be used"),
    }));
  });

  it('enforces cooldown', async () => {
    const cmd = { ...sampleCmd, cooldown_seconds: 60 };
    const supabase = makeSupabase([cmd]);
    const guild = makeGuild();
    await loadCustomCommands(supabase as any, guild as any, {} as any);

    const valkey = makeValkey();
    const int1 = makeInteraction('hello');
    await handleCustomCommand(int1 as any, supabase as any, valkey as any, guild as any);

    // Second call should be on cooldown, with the branded command name.
    const int2 = makeInteraction('hello');
    await handleCustomCommand(int2 as any, supabase as any, valkey as any, guild as any);
    expect(int2.reply).toHaveBeenCalledWith(expect.objectContaining({
      content: expect.stringContaining('cooldown'),
    }));
    expect(int2.reply).toHaveBeenCalledWith(expect.objectContaining({
      content: expect.stringContaining('/hello'),
    }));
  });

  it('enforces cooldown atomically under concurrent invocations', async () => {
    const cmd = { ...sampleCmd, cooldown_seconds: 60 };
    const supabase = makeSupabase([cmd]);
    const guild = makeGuild();
    await loadCustomCommands(supabase as any, guild as any, {} as any);

    // A valkey whose SET NX succeeds exactly once then refuses, modelling two
    // truly-simultaneous claims racing on the same cooldown key.
    let claims = 0;
    const valkey = {
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn().mockImplementation((_k: string, _v: string, ..._args: any[]) => {
        claims += 1;
        return Promise.resolve(claims === 1 ? 'OK' : null);
      }),
      ttl: vi.fn().mockResolvedValue(42),
    };

    const int1 = makeInteraction('hello');
    const int2 = makeInteraction('hello');
    await Promise.all([
      handleCustomCommand(int1 as any, supabase as any, valkey as any, guild as any),
      handleCustomCommand(int2 as any, supabase as any, valkey as any, guild as any),
    ]);

    // Exactly one interaction executed the action; the other got the cooldown notice.
    const executed = [int1, int2].filter((i) =>
      (i.reply as any).mock.calls.some((c: any[]) => c[0]?.content === 'Hello TestUser!'),
    );
    const cooledDown = [int1, int2].filter((i) =>
      (i.reply as any).mock.calls.some((c: any[]) => String(c[0]?.content).includes('cooldown')),
    );
    expect(executed).toHaveLength(1);
    expect(cooledDown).toHaveLength(1);
  });

  it('executes send_embed action', async () => {
    const cmd = {
      ...sampleCmd,
      actions: [{
        type: 'send_embed',
        embedConfig: {
          title: 'Title {server}',
          description: 'Desc {user}',
          color: 0xFF0000,
          image_url: 'https://img.png',
          thumbnail_url: 'https://thumb.png',
          footer_text: 'Footer {server}',
          fields: [{ name: 'F1 {user.name}', value: 'V1 {memberCount}', inline: true }],
        },
      }],
    };
    const supabase = makeSupabase([cmd]);
    const guild = makeGuild();
    await loadCustomCommands(supabase as any, guild as any, {} as any);

    const interaction = makeInteraction('hello');
    const valkey = makeValkey();
    await handleCustomCommand(interaction as any, supabase as any, valkey as any, guild as any);
    expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({
      embeds: expect.any(Array),
    }));
  });

  it('executes give_role action', async () => {
    const cmd = { ...sampleCmd, actions: [{ type: 'give_role', roleId: 'r1' }] };
    const supabase = makeSupabase([cmd]);
    const guild = makeGuild();
    await loadCustomCommands(supabase as any, guild as any, {} as any);

    const interaction = makeInteraction('hello');
    const valkey = makeValkey();
    await handleCustomCommand(interaction as any, supabase as any, valkey as any, guild as any);
    expect(guild.members.fetch).toHaveBeenCalled();
  });

  it('executes remove_role action', async () => {
    const cmd = { ...sampleCmd, actions: [{ type: 'remove_role', roleId: 'r1' }] };
    const supabase = makeSupabase([cmd]);
    const guild = makeGuild();
    await loadCustomCommands(supabase as any, guild as any, {} as any);

    const interaction = makeInteraction('hello');
    const valkey = makeValkey();
    await handleCustomCommand(interaction as any, supabase as any, valkey as any, guild as any);
    expect(guild.members.fetch).toHaveBeenCalled();
  });

  it('executes send_dm action', async () => {
    const cmd = { ...sampleCmd, actions: [{ type: 'send_dm', message: 'DM {user.name}!' }] };
    const supabase = makeSupabase([cmd]);
    const guild = makeGuild();
    await loadCustomCommands(supabase as any, guild as any, {} as any);

    const interaction = makeInteraction('hello');
    const valkey = makeValkey();
    await handleCustomCommand(interaction as any, supabase as any, valkey as any, guild as any);
    expect(interaction.user.send).toHaveBeenCalledWith(expect.objectContaining({
      content: 'DM TestUser!',
    }));
  });

  it('handles command with no actions', async () => {
    const cmd = { ...sampleCmd, actions: [] };
    const supabase = makeSupabase([cmd]);
    const guild = makeGuild();
    await loadCustomCommands(supabase as any, guild as any, {} as any);

    const interaction = makeInteraction('hello');
    const valkey = makeValkey();
    await handleCustomCommand(interaction as any, supabase as any, valkey as any, guild as any);
    expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({
      content: 'This command has no actions configured.',
    }));
  });

  it('handles multiple actions (message then embed)', async () => {
    const cmd = {
      ...sampleCmd,
      actions: [
        { type: 'send_message', message: 'First' },
        { type: 'send_embed', embedConfig: { title: 'Second' } },
      ],
    };
    const supabase = makeSupabase([cmd]);
    const guild = makeGuild();
    await loadCustomCommands(supabase as any, guild as any, {} as any);

    const interaction = makeInteraction('hello');
    const valkey = makeValkey();
    await handleCustomCommand(interaction as any, supabase as any, valkey as any, guild as any);
    expect(interaction.reply).toHaveBeenCalled();
    expect(interaction.followUp).toHaveBeenCalled();
  });
});

describe('clearCommandRegistry', () => {
  it('clears all commands', async () => {
    const supabase = makeSupabase([sampleCmd]);
    const guild = makeGuild();
    await loadCustomCommands(supabase as any, guild as any, {} as any);
    expect(isCustomCommand('hello')).toBe(true);
    clearCommandRegistry();
    expect(isCustomCommand('hello')).toBe(false);
  });
});
