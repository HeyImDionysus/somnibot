/**
 * /warn — an unreadable moderation config must not silently disable escalation.
 *
 * THE DEFECT THIS PINS: the config read discarded its `error`. A failed read
 * left `config` null, which fell through to `escalation_chain: []` — so a
 * database blip quietly turned escalation OFF. The warning was still recorded
 * and acknowledged, no timeout/kick/ban fired, and nothing anywhere said why.
 *
 * Escalation is the part of a warning with teeth. "Cannot read the settings"
 * and "no escalation is configured" are completely different states, and the
 * old code rendered them identically.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@somnibot/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@somnibot/shared')>()),
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const {
  mockCreateInfraction,
  mockRaiseOwnerAlert,
  mockResolveOwnerAlertWithStatus,
  mockWriteAuditLog,
} = vi.hoisted(() => ({
  mockCreateInfraction: vi.fn(),
  mockRaiseOwnerAlert: vi.fn(),
  mockResolveOwnerAlertWithStatus: vi.fn(),
  mockWriteAuditLog: vi.fn(),
}));
vi.mock('../features/moderation/infraction-service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../features/moderation/infraction-service.js')>()),
  createInfraction: mockCreateInfraction,
}));
vi.mock('../services/alert-service.js', () => ({
  raiseOwnerAlert: mockRaiseOwnerAlert,
  resolveOwnerAlertWithStatus: mockResolveOwnerAlertWithStatus,
}));
vi.mock('../services/audit.js', () => ({
  writeAuditLog: mockWriteAuditLog,
}));

import { handleWarnCommand } from '../features/moderation/commands.js';

/**
 * Supabase stub whose guild_config read can be made to fail. Everything else
 * resolves empty, which is enough for the paths under test.
 */
function makeSupa(opts: { configError?: { message: string } | null } = {}) {
  const chain = (table: string) => {
    const c: Record<string, unknown> = {};
    for (const m of ['from', 'select', 'insert', 'update', 'delete', 'eq', 'order',
      'limit', 'in', 'match', 'gte', 'lte', 'neq', 'or']) c[m] = vi.fn(() => c);
    c.single = vi.fn(async () => ({ data: null, error: null }));
    c.maybeSingle = vi.fn(async () => (
      table === 'guild_config' && opts.configError
        ? { data: null, error: opts.configError }
        : { data: table === 'guild_config' ? { escalation_chain: [], infraction_expiry_days: 30 } : null, error: null }
    ));
    c.then = (resolve: (v: unknown) => unknown) => resolve({ data: [], error: null, count: 0 });
    return c;
  };
  return {
    from: vi.fn((t: string) => chain(t)),
    rpc: vi.fn(async () => ({ data: null, error: null })),
  };
}

function makeClient(supabase: unknown) {
  return {
    supabase,
    eventBus: { emit: vi.fn() },
    channels: { cache: new Map() },
  };
}

function makeInteraction() {
  return {
    id: 'interaction-1',
    guildId: 'guild-1',
    // The command re-verifies live permissions server-side; without this the
    // handler never reaches the config read and the tests pass vacuously.
    memberPermissions: { has: () => true },
    user: { id: 'mod-1', username: 'Mod', tag: 'Mod#0001', displayAvatarURL: () => 'url' },
    member: { id: 'mod-1', permissions: { has: () => true }, roles: { highest: { position: 10 } } },
    guild: {
      id: 'guild-1',
      name: 'Test',
      members: {
        // The handler fetches BOTH the invoker and the target and compares
        // role positions; returning one object for both makes the moderator
        // fail to outrank the member and short-circuits the test.
        fetch: vi.fn(async (id: string) => (id === 'mod-1'
          ? { id: 'mod-1', roles: { highest: { position: 10 } } }
          : {
              id: 'target-1',
              displayName: 'Target',
              user: { tag: 'Target#0001', bot: false, send: vi.fn().mockResolvedValue({}) },
              roles: { highest: { position: 1 } },
              manageable: true,
              moderatable: true,
              timeout: vi.fn().mockResolvedValue({}),
            })),
      },
    },
    options: {
      getUser: vi.fn(() => ({ id: 'target-1', username: 'Target', bot: false })),
      getString: vi.fn(() => 'Test reason'),
      getInteger: vi.fn(() => null),
      getMember: vi.fn(() => ({
        id: 'target-1',
        displayName: 'Target',
        user: { tag: 'Target#0001', bot: false },
        roles: { highest: { position: 1 } },
        manageable: true,
      })),
    },
    reply: vi.fn().mockResolvedValue({}),
    editReply: vi.fn().mockResolvedValue({}),
    deferReply: vi.fn().mockResolvedValue({}),
    followUp: vi.fn().mockResolvedValue({}),
    channel: { send: vi.fn().mockResolvedValue({}) },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockCreateInfraction.mockResolvedValue({
    infraction: { id: 'inf-1' },
    replayed: false,
  });
  mockRaiseOwnerAlert.mockResolvedValue({ inserted: false, delivered: false });
  mockResolveOwnerAlertWithStatus.mockResolvedValue({ resolvedCount: 0, succeeded: true });
  mockWriteAuditLog.mockResolvedValue(undefined);
});

describe('/warn with an unreadable moderation config', () => {
  it('records no warning at all', async () => {
    const supabase = makeSupa({ configError: { message: 'connection reset' } });
    const interaction = makeInteraction();

    await handleWarnCommand(interaction as never, makeClient(supabase) as never);

    // Recording the infraction while escalation silently cannot run would
    // leave the member warned and the punishment quietly skipped.
    expect(mockCreateInfraction).not.toHaveBeenCalled();
  });

  it('tells the moderator nothing was applied, rather than reporting success', async () => {
    const supabase = makeSupa({ configError: { message: 'connection reset' } });
    const interaction = makeInteraction();

    await handleWarnCommand(interaction as never, makeClient(supabase) as never);

    const replies = interaction.editReply.mock.calls.map((c) => String(c[0]));
    expect(replies.join(' ')).toContain('Nothing was applied');
    // And never the success wording.
    expect(replies.join(' ')).not.toMatch(/has been warned|Warning issued/i);
  });

  it('emits no moderation events for a warning that did not happen', async () => {
    const supabase = makeSupa({ configError: { message: 'connection reset' } });
    const client = makeClient(supabase);

    await handleWarnCommand(makeInteraction() as never, client as never);

    expect(client.eventBus.emit).not.toHaveBeenCalled();
  });

  it('records one durable degradation row for a repeated unreadable-config episode', async () => {
    mockRaiseOwnerAlert
      .mockResolvedValueOnce({ inserted: true, delivered: false })
      .mockResolvedValueOnce({ inserted: false, insertErrorCode: '23505', delivered: false });

    await handleWarnCommand(
      makeInteraction() as never,
      makeClient(makeSupa({ configError: { message: 'connection reset' } })) as never,
    );
    await handleWarnCommand(
      makeInteraction() as never,
      makeClient(makeSupa({ configError: { message: 'connection reset' } })) as never,
    );

    expect(mockRaiseOwnerAlert).toHaveBeenCalledTimes(2);
    expect(mockWriteAuditLog).toHaveBeenCalledTimes(1);
    expect(mockWriteAuditLog).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'moderation.config_degraded',
        occurrenceKey: expect.stringContaining('config-degraded'),
        success: false,
      }),
    );
  });

  it('preserves the truthful outage reply when owner-alert persistence fails', async () => {
    mockRaiseOwnerAlert.mockRejectedValueOnce(new Error('alert store unavailable'));
    const interaction = makeInteraction();

    await expect(
      handleWarnCommand(
        interaction as never,
        makeClient(makeSupa({ configError: { message: 'connection reset' } })) as never,
      ),
    ).resolves.toBeUndefined();

    expect(mockCreateInfraction).not.toHaveBeenCalled();
    expect(interaction.editReply).toHaveBeenCalledWith(expect.stringContaining('Nothing was applied'));
  });

  it('preserves the truthful outage reply when degradation-audit persistence fails', async () => {
    mockRaiseOwnerAlert.mockResolvedValueOnce({ inserted: true, delivered: false });
    mockWriteAuditLog.mockRejectedValueOnce(new Error('audit store unavailable'));
    const interaction = makeInteraction();

    await expect(
      handleWarnCommand(
        interaction as never,
        makeClient(makeSupa({ configError: { message: 'connection reset' } })) as never,
      ),
    ).resolves.toBeUndefined();

    expect(mockCreateInfraction).not.toHaveBeenCalled();
    expect(interaction.editReply).toHaveBeenCalledWith(expect.stringContaining('Nothing was applied'));
  });

  it('records one recovery row after the durable config alert resolves', async () => {
    mockRaiseOwnerAlert.mockResolvedValueOnce({ inserted: true, delivered: false });
    mockResolveOwnerAlertWithStatus
      .mockResolvedValueOnce({ resolvedCount: 1, succeeded: true })
      .mockResolvedValueOnce({ resolvedCount: 0, succeeded: true });

    await handleWarnCommand(
      makeInteraction() as never,
      makeClient(makeSupa({ configError: { message: 'connection reset' } })) as never,
    );
    await handleWarnCommand(makeInteraction() as never, makeClient(makeSupa()) as never);
    await handleWarnCommand(makeInteraction() as never, makeClient(makeSupa()) as never);

    expect(mockCreateInfraction).toHaveBeenCalledTimes(2);
    expect(mockWriteAuditLog).toHaveBeenCalledTimes(2);
    expect(mockWriteAuditLog).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'moderation.config_recovered',
        occurrenceKey: expect.stringContaining('config-recovered'),
        success: true,
      }),
    );
  });

  it('does not settle config recovery until a fresh infraction persists', async () => {
    mockRaiseOwnerAlert.mockResolvedValueOnce({ inserted: true, delivered: false });
    mockCreateInfraction.mockResolvedValue(null);

    await handleWarnCommand(
      makeInteraction() as never,
      makeClient(makeSupa({ configError: { message: 'connection reset' } })) as never,
    );
    await handleWarnCommand(makeInteraction() as never, makeClient(makeSupa()) as never);

    expect(mockResolveOwnerAlertWithStatus).not.toHaveBeenCalled();
    expect(mockWriteAuditLog).toHaveBeenCalledTimes(1);
  });

  it('does not block a fresh warning when recovery audit persistence fails', async () => {
    mockResolveOwnerAlertWithStatus.mockResolvedValueOnce({ resolvedCount: 1, succeeded: true });
    mockWriteAuditLog.mockRejectedValueOnce(new Error('audit store unavailable'));
    const interaction = makeInteraction();

    await expect(handleWarnCommand(interaction as never, makeClient(makeSupa()) as never))
      .resolves.toBeUndefined();

    expect(mockCreateInfraction).toHaveBeenCalledTimes(1);
    expect(interaction.editReply).toHaveBeenCalledWith(expect.stringContaining('warned'));
  });

  it('still warns normally when the config reads cleanly', async () => {
    const supabase = makeSupa();
    const interaction = makeInteraction();

    await handleWarnCommand(interaction as never, makeClient(supabase) as never);

    // A genuinely empty escalation chain is a legitimate configuration and
    // must keep working.
    expect(mockCreateInfraction).toHaveBeenCalledTimes(1);
  });
});
