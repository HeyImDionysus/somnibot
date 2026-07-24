/**
 * custom-commands/command-engine — audit emit tests
 *
 * Asserts the append-only audit lane: a successful invocation emits
 * `custom_command.invoked` and every permission/channel denial emits
 * `custom_command.denied` (with the specific reason) on the platform event bus,
 * which AuditService maps to an audit_logs row.
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
  clearCommandRegistry,
} from '../features/custom-commands/command-engine.js';
import { eventBus } from '../services/event-bus.js';

function makeSupabase(commands: any[] = []) {
  const chain: any = {};
  for (const m of ['select', 'eq', 'limit']) chain[m] = vi.fn().mockReturnValue(chain);
  chain.then = (res: any) => Promise.resolve({ data: commands, error: null }).then(res);
  return { from: vi.fn().mockReturnValue(chain) };
}

function makeGuild() {
  return {
    id: 'g1',
    name: 'Test Guild',
    memberCount: 100,
    channels: { cache: new Map() },
    members: { fetch: vi.fn().mockResolvedValue(null) },
  };
}

function makeInteraction() {
  return {
    commandName: 'hello',
    user: { id: 'u1', username: 'TestUser', send: vi.fn().mockResolvedValue(undefined) },
    channelId: 'ch1',
    channel: { send: vi.fn().mockResolvedValue(undefined) },
    guild: { name: 'Test Guild', memberCount: 100 },
    member: { roles: { cache: new Map([['role1', { id: 'role1' }]]) } },
    reply: vi.fn().mockResolvedValue(undefined),
    followUp: vi.fn().mockResolvedValue(undefined),
  };
}

function makeValkey() {
  const store = new Map<string, string>();
  return {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue('OK'),
    ttl: vi.fn().mockResolvedValue(30),
    _store: store,
  };
}

const baseCmd = {
  id: 'cmd-1',
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
  actions: [{ type: 'send_message', message: 'Hello!' }],
};

async function load(cmd: any) {
  const supabase = makeSupabase([cmd]);
  await loadCustomCommands(supabase as any, makeGuild() as any, {} as any);
}

describe('command-engine audit emits', () => {
  let emitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    clearCommandRegistry();
    vi.clearAllMocks();
    emitSpy = vi.spyOn(eventBus, 'emit').mockImplementation(() => {});
  });

  it('emits custom_command.invoked on a successful invocation', async () => {
    await load(baseCmd);
    const interaction = makeInteraction();
    await handleCustomCommand(interaction as any, {} as any, makeValkey() as any, makeGuild() as any);

    expect(emitSpy).toHaveBeenCalledWith(
      'custom_command.invoked',
      'g1',
      expect.objectContaining({ commandId: 'cmd-1', commandName: 'hello', userId: 'u1', channelId: 'ch1' }),
    );
  });

  it('emits custom_command.denied (missing_allowed_role) when the member lacks an allowed role', async () => {
    await load({ ...baseCmd, allowed_roles: ['admin-role'] });
    const interaction = makeInteraction();
    await handleCustomCommand(interaction as any, {} as any, makeValkey() as any, makeGuild() as any);

    expect(emitSpy).toHaveBeenCalledWith(
      'custom_command.denied',
      'g1',
      expect.objectContaining({ commandId: 'cmd-1', reason: 'missing_allowed_role', userId: 'u1' }),
    );
    expect(emitSpy).not.toHaveBeenCalledWith('custom_command.invoked', expect.anything(), expect.anything());
  });

  it('emits custom_command.denied (denied_role) when the member holds a denied role', async () => {
    await load({ ...baseCmd, denied_roles: ['role1'] });
    const interaction = makeInteraction();
    await handleCustomCommand(interaction as any, {} as any, makeValkey() as any, makeGuild() as any);

    expect(emitSpy).toHaveBeenCalledWith(
      'custom_command.denied',
      'g1',
      expect.objectContaining({ reason: 'denied_role' }),
    );
  });

  it('emits custom_command.denied (channel_denied) in a denied channel', async () => {
    await load({ ...baseCmd, denied_channels: ['ch1'] });
    const interaction = makeInteraction();
    await handleCustomCommand(interaction as any, {} as any, makeValkey() as any, makeGuild() as any);

    expect(emitSpy).toHaveBeenCalledWith(
      'custom_command.denied',
      'g1',
      expect.objectContaining({ reason: 'channel_denied' }),
    );
  });

  it('emits custom_command.denied (channel_not_allowed) outside the allowed channels', async () => {
    await load({ ...baseCmd, allowed_channels: ['other-ch'] });
    const interaction = makeInteraction();
    await handleCustomCommand(interaction as any, {} as any, makeValkey() as any, makeGuild() as any);

    expect(emitSpy).toHaveBeenCalledWith(
      'custom_command.denied',
      'g1',
      expect.objectContaining({ reason: 'channel_not_allowed' }),
    );
  });
});
