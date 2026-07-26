/**
 * goodbye-service — coverage tests
 *
 * Tests executeGoodbyeFlow with REAL imports.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@somnibot/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@somnibot/shared')>()),
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// Mock welcome-variables (imported by goodbye-service)
vi.mock('../features/welcome/welcome-variables.js', () => ({
  buildWelcomeVariables: vi.fn().mockReturnValue({
    'user.name': 'TestUser',
    'server.name': 'TestServer',
    duration: '',
  }),
  formatDuration: vi.fn().mockReturnValue('2 days'),
  interpolateMessage: vi.fn().mockImplementation((msg: string) => msg.replace('{user.name}', 'TestUser')),
}));

import { executeGoodbyeFlow } from '../features/welcome/goodbye-service.js';

function makeChannel() {
  return {
    isTextBased: vi.fn().mockReturnValue(true),
    send: vi.fn().mockResolvedValue(undefined),
  };
}

function makeMember(overrides: any = {}) {
  const channel = makeChannel();
  return {
    id: 'user1',
    user: { tag: 'TestUser#0001' },
    joinedAt: new Date('2026-01-01'),
    guild: {
      channels: {
        cache: new Map([['ch1', channel]]),
      },
    },
    _channel: channel,
    ...overrides,
  };
}

function makeConfig(overrides: any = {}) {
  return {
    goodbye_enabled: true,
    goodbye_channel_id: 'ch1',
    goodbye_message: '{user.name} left. They were with us for {duration}. 👋',
    ...overrides,
  };
}

describe('executeGoodbyeFlow', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('sends goodbye message to configured channel', async () => {
    const member = makeMember();
    const config = makeConfig();
    await executeGoodbyeFlow(member as any, config as any);
    expect(member._channel.send).toHaveBeenCalled();
  });

  it('does nothing when goodbye is disabled', async () => {
    const member = makeMember();
    const config = makeConfig({ goodbye_enabled: false });
    await executeGoodbyeFlow(member as any, config as any);
    expect(member._channel.send).not.toHaveBeenCalled();
  });

  it('does nothing when no goodbye channel configured', async () => {
    const member = makeMember();
    const config = makeConfig({ goodbye_channel_id: null });
    await executeGoodbyeFlow(member as any, config as any);
    expect(member._channel.send).not.toHaveBeenCalled();
  });

  it('handles channel not found', async () => {
    const member = makeMember();
    member.guild.channels.cache.clear();
    const config = makeConfig({ goodbye_channel_id: 'nonexistent' });
    await executeGoodbyeFlow(member as any, config as any);
    // Should not throw
  });

  it('handles non-text channel', async () => {
    const channel = makeChannel();
    channel.isTextBased.mockReturnValue(false);
    const member = makeMember();
    member.guild.channels.cache.set('ch1', channel);
    const config = makeConfig();
    await executeGoodbyeFlow(member as any, config as any);
    expect(channel.send).not.toHaveBeenCalled();
  });

  it('uses default message when none configured', async () => {
    const member = makeMember();
    const config = makeConfig({ goodbye_message: null });
    await executeGoodbyeFlow(member as any, config as any);
    expect(member._channel.send).toHaveBeenCalled();
  });

  it('handles member without joinedAt', async () => {
    const member = makeMember({ joinedAt: null });
    const config = makeConfig();
    await executeGoodbyeFlow(member as any, config as any);
    expect(member._channel.send).toHaveBeenCalled();
  });

  it('handles send error gracefully', async () => {
    const member = makeMember();
    member._channel.send.mockRejectedValue(new Error('perms'));
    const config = makeConfig();
    await executeGoodbyeFlow(member as any, config as any);
    // Should not throw
  });
});
