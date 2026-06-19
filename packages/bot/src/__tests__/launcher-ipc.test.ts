import { Collection } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';
import { buildLauncherIpcMessage, sendLauncherIpcMessage } from '../services/launcher-ipc.js';

function clientWithGuilds(count: number) {
  return {
    guilds: {
      cache: new Collection(Array.from({ length: count }, (_, index) => [`g${index}`, { id: `g${index}` }])),
    },
  };
}

describe('launcher IPC', () => {
  it('builds ready and heartbeat messages with guild count', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_783_000_000_000);

    expect(buildLauncherIpcMessage('ready', clientWithGuilds(2) as never)).toEqual({
      type: 'ready',
      timestamp: 1_783_000_000_000,
      guildCount: 2,
    });
  });

  it('sends IPC when the bot is forked by the launcher', () => {
    const send = vi.fn(() => true);

    const sent = sendLauncherIpcMessage('heartbeat', clientWithGuilds(1) as never, {
      connected: true,
      send,
    });

    expect(sent).toBe(true);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'heartbeat',
      guildCount: 1,
    }));
  });

  it('does nothing when no IPC channel exists', () => {
    const sent = sendLauncherIpcMessage('ready', clientWithGuilds(1) as never, {
      connected: false,
    });

    expect(sent).toBe(false);
  });
});
