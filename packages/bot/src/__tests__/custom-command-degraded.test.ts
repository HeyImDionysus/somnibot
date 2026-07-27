/**
 * custom-commands/command-engine — honest failure reporting.
 *
 * THE DEFECT THIS PINS: every action ran inside a try/catch that only logged.
 * If the action that was supposed to reply threw, `replied` stayed false, the
 * run fell through to `'✅ Command executed.'`, and it emitted
 * `custom_command.invoked` — telling the member their command worked when
 * nothing had happened, and recording a success in the audit trail.
 *
 * A broken command must say so, and must not be audited as a success.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('discord.js', () => ({
  REST: vi.fn(),
  EmbedBuilder: vi.fn().mockImplementation(function () {
    return {
      data: {} as Record<string, unknown>,
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

vi.mock('@somnibot/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@somnibot/shared')>()),
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('../services/alert-service.js', () => ({
  raiseOwnerAlert: vi.fn().mockResolvedValue({ inserted: true }),
}));

import {
  loadCustomCommands,
  handleCustomCommand,
  clearCommandRegistry,
} from '../features/custom-commands/command-engine.js';
import { eventBus } from '../services/event-bus.js';
import { raiseOwnerAlert } from '../services/alert-service.js';

function makeSupabase(commands: unknown[] = []) {
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'limit']) chain[m] = vi.fn().mockReturnValue(chain);
  chain.then = (res: (v: unknown) => unknown) =>
    Promise.resolve({ data: commands, error: null }).then(res);
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

/**
 * `replyThrows` makes the FIRST interaction.reply reject — a send_message
 * action replies through interaction.reply, so this is a broken reply action
 * (missing permissions, expired token). Later replies resolve, so the engine's
 * own failure notice can still be delivered.
 */
function makeInteraction(opts: { replyThrows?: boolean } = {}) {
  const reply = opts.replyThrows
    ? vi.fn().mockRejectedValueOnce(new Error('Missing Permissions')).mockResolvedValue(undefined)
    : vi.fn().mockResolvedValue(undefined);
  return {
    commandName: 'hello',
    user: { id: 'u1', username: 'TestUser', send: vi.fn().mockResolvedValue(undefined) },
    channelId: 'ch1',
    channel: { send: vi.fn().mockResolvedValue(undefined) },
    guild: { name: 'Test Guild', memberCount: 100 },
    member: { roles: { cache: new Map() } },
    reply,
    followUp: vi.fn().mockResolvedValue(undefined),
  };
}

const makeValkey = () => ({
  get: vi.fn().mockResolvedValue(null),
  set: vi.fn().mockResolvedValue('OK'),
  ttl: vi.fn().mockResolvedValue(30),
});

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

async function load(cmd: unknown) {
  await loadCustomCommands(makeSupabase([cmd]) as never, makeGuild() as never, {} as never);
}

describe('custom command with a failing action', () => {
  let emitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    clearCommandRegistry();
    vi.clearAllMocks();
    emitSpy = vi.spyOn(eventBus, 'emit').mockImplementation(() => {});
  });

  it('does NOT claim the command executed', async () => {
    await load(baseCmd);
    const interaction = makeInteraction({ replyThrows: true });

    await handleCustomCommand(
      interaction as never, makeSupabase() as never, makeValkey() as never, makeGuild() as never,
    );

    const replyArgs = interaction.reply.mock.calls.map((c) => JSON.stringify(c[0]));
    expect(replyArgs.join(' ')).not.toContain('Command executed');
    // It still replies — the member must be told something went wrong.
    expect(interaction.reply).toHaveBeenCalled();
  });

  it('emits custom_command.degraded, never custom_command.invoked', async () => {
    await load(baseCmd);

    await handleCustomCommand(
      makeInteraction({ replyThrows: true }) as never,
      makeSupabase() as never, makeValkey() as never, makeGuild() as never,
    );

    const events = emitSpy.mock.calls.map((c) => c[0]);
    expect(events).toContain('custom_command.degraded');
    expect(events).not.toContain('custom_command.invoked');

    const degraded = emitSpy.mock.calls.find((c) => c[0] === 'custom_command.degraded');
    expect(degraded?.[2]).toMatchObject({
      commandId: 'cmd-1',
      commandName: 'hello',
      failedActions: 1,
      failedTypes: ['send_message'],
    });
  });

  it('raises an owner alert naming the command and the failing action type', async () => {
    await load(baseCmd);

    await handleCustomCommand(
      makeInteraction({ replyThrows: true }) as never,
      makeSupabase() as never, makeValkey() as never, makeGuild() as never,
    );

    expect(raiseOwnerAlert).toHaveBeenCalledTimes(1);
    const [, guildId, input] = vi.mocked(raiseOwnerAlert).mock.calls[0];
    expect(guildId).toBe('g1');
    expect(input).toMatchObject({ alertType: 'custom_command_failing', severity: 'warning' });
    expect(input.message).toContain('/hello');
    expect(input.message).toContain('send_message');
  });

  it('reports a PARTIAL failure without overwriting the reply that succeeded', async () => {
    // First action replies fine; the second (a DM-less role grant) throws.
    await load({
      ...baseCmd,
      actions: [
        { type: 'send_message', message: 'Hello!' },
        { type: 'give_role', roleId: 'role-1' },
      ],
    });
    const interaction = makeInteraction();
    // The member resolves, but adding the role throws (missing permissions).
    const guild = makeGuild();
    guild.members.fetch = vi.fn().mockResolvedValue({
      roles: { add: vi.fn().mockRejectedValue(new Error('Missing Permissions')) },
    });

    await handleCustomCommand(
      interaction as never, makeSupabase() as never, makeValkey() as never, guild as never,
    );

    // The successful reply stands; the failure arrives as a follow-up.
    expect(interaction.followUp).toHaveBeenCalled();
    const events = emitSpy.mock.calls.map((c) => c[0]);
    expect(events).toContain('custom_command.degraded');
    expect(events).not.toContain('custom_command.invoked');
  });

  it('still reports success when every action works', async () => {
    await load(baseCmd);

    await handleCustomCommand(
      makeInteraction() as never, makeSupabase() as never, makeValkey() as never, makeGuild() as never,
    );

    const events = emitSpy.mock.calls.map((c) => c[0]);
    expect(events).toContain('custom_command.invoked');
    expect(events).not.toContain('custom_command.degraded');
    expect(raiseOwnerAlert).not.toHaveBeenCalled();
  });
});
