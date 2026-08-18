import { describe, expect, it, vi } from 'vitest';
import { initializeWhenDiscordReady } from '../services/discord-ready.js';

describe('initializeWhenDiscordReady', () => {
  it('initializes immediately when Discord became ready before login resolved', async () => {
    const initialize = vi.fn(async () => undefined);
    const once = vi.fn();

    initializeWhenDiscordReady(
      { isReady: () => true, once },
      initialize,
      vi.fn(),
    );

    await vi.waitFor(() => expect(initialize).toHaveBeenCalledOnce());
    expect(once).not.toHaveBeenCalled();
  });

  it('waits for the ready event when Discord is not ready yet', async () => {
    const initialize = vi.fn(async () => undefined);
    let readyListener: (() => void) | undefined;

    initializeWhenDiscordReady(
      {
        isReady: () => false,
        once: vi.fn((_event, listener) => {
          readyListener = listener;
        }),
      },
      initialize,
      vi.fn(),
    );

    expect(initialize).not.toHaveBeenCalled();
    readyListener?.();
    await vi.waitFor(() => expect(initialize).toHaveBeenCalledOnce());
  });
});
