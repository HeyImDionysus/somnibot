import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  emit: vi.fn(),
  getMemberNumber: vi.fn(async () => 7),
  raiseOwnerAlert: vi.fn(async () => undefined),
}));

vi.mock('@somnibot/shared', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

vi.mock('discord.js', () => ({
  AttachmentBuilder: class {
    constructor(_buffer: Buffer, _options: { readonly name: string }) {}
  },
}));

vi.mock('../services/event-bus.js', () => ({
  eventBus: { emit: mocks.emit },
}));

vi.mock('../services/alert-service.js', () => ({
  raiseOwnerAlert: mocks.raiseOwnerAlert,
}));

vi.mock('../features/welcome/member-service.js', () => ({
  getMemberNumber: mocks.getMemberNumber,
}));

vi.mock('../features/welcome/welcome-card.js', () => ({
  generateWelcomeCard: vi.fn(),
}));

const { executeWelcomeFlow } = await import('../features/welcome/welcome-service.js');

type Send = (payload: unknown) => Promise<{ readonly id: string }>;

type WelcomeFixture = {
  readonly member: Record<string, unknown>;
  readonly options: Record<string, unknown>;
  readonly channelSend: ReturnType<typeof vi.fn<Send>>;
  readonly dmSend: ReturnType<typeof vi.fn<Send>>;
};

function makeWelcomeFixture(options: {
  readonly channelEnabled: boolean;
  readonly dmEnabled: boolean;
  readonly channelSend?: Send;
  readonly dmSend?: Send;
}): WelcomeFixture {
  const channelSend = vi.fn<Send>(options.channelSend ?? (async () => ({ id: 'channel-message-1' })));
  const dmSend = vi.fn<Send>(options.dmSend ?? (async () => ({ id: 'dm-message-1' })));
  const channel = {
    id: 'channel-1',
    isTextBased: () => true,
    send: channelSend,
  };
  const member = {
    id: 'member-1',
    guild: {
      id: 'guild-1',
      name: 'Guild One',
      memberCount: 7,
      iconURL: () => null,
      channels: { cache: new Map([['channel-1', channel]]) },
    },
    user: {
      id: 'member-1',
      tag: 'member#0001',
      username: 'member',
      displayName: 'member',
      displayAvatarURL: () => 'https://cdn.example/member.png',
    },
    displayName: 'member',
    send: dmSend,
    roles: { cache: new Map() },
  };
  const config = {
    welcome_enabled: options.channelEnabled,
    welcome_channel_id: 'channel-1',
    welcome_message: 'Welcome {user}',
    welcome_card_enabled: false,
    welcome_dm_enabled: options.dmEnabled,
    welcome_dm_message: 'Welcome {user.name}',
    welcome_auto_roles: [],
  };

  return {
    member,
    options: { supabase: {}, config },
    channelSend,
    dmSend,
  };
}

async function runWelcomeFlow(fixture: WelcomeFixture): Promise<void> {
  await Reflect.apply(executeWelcomeFlow, undefined, [fixture.member, fixture.options]);
}

describe('executeWelcomeFlow delivery acknowledgment', () => {
  beforeEach(() => {
    mocks.emit.mockClear();
    mocks.getMemberNumber.mockClear();
    mocks.raiseOwnerAlert.mockClear();
  });

  it('records a channel delivery acknowledgment only after Discord accepts the configured channel send', async () => {
    const fixture = makeWelcomeFixture({ channelEnabled: true, dmEnabled: false });

    await runWelcomeFlow(fixture);

    expect(fixture.channelSend).toHaveBeenCalledOnce();
    expect(mocks.emit).toHaveBeenCalledWith('welcome.delivery_succeeded', 'guild-1', {
      memberId: 'member-1',
      channelId: 'channel-1',
      deliveryKind: 'channel',
      occurrenceId: 'member-1:welcome:channel:channel-message-1',
      correlationId: 'welcome:member-1',
    });
  });

  it('does not record success when Discord rejects the configured channel send', async () => {
    const fixture = makeWelcomeFixture({
      channelEnabled: true,
      dmEnabled: false,
      channelSend: async () => Promise.reject(new Error('Discord rejected delivery')),
    });

    await runWelcomeFlow(fixture);

    expect(fixture.channelSend).toHaveBeenCalledOnce();
    expect(mocks.emit).not.toHaveBeenCalledWith(
      'welcome.delivery_succeeded',
      expect.any(String),
      expect.any(Object),
    );
  });

  it('records a DM delivery acknowledgment only after Discord accepts the member DM', async () => {
    const fixture = makeWelcomeFixture({ channelEnabled: false, dmEnabled: true });

    await runWelcomeFlow(fixture);

    expect(fixture.dmSend).toHaveBeenCalledOnce();
    expect(mocks.emit).toHaveBeenCalledWith('welcome.delivery_succeeded', 'guild-1', {
      memberId: 'member-1',
      deliveryKind: 'dm',
      occurrenceId: 'member-1:welcome:dm:dm-message-1',
      correlationId: 'welcome:member-1',
    });
  });

  it('records no delivery acknowledgment when every delivery mode is disabled', async () => {
    const fixture = makeWelcomeFixture({ channelEnabled: false, dmEnabled: false });

    await runWelcomeFlow(fixture);

    expect(fixture.channelSend).not.toHaveBeenCalled();
    expect(fixture.dmSend).not.toHaveBeenCalled();
    expect(mocks.emit).not.toHaveBeenCalled();
  });
});
