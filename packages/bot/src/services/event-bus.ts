import { EventEmitter } from 'node:events';
import type { PlatformEventMap, PlatformEventType, PlatformEvent } from '@somnibot/shared';

/**
 * Platform Event Bus — the central nervous system of SomniBot.
 *
 * Features emit events → automations listen → actions affect other features.
 * No feature needs direct knowledge of any other feature.
 *
 * Usage:
 *   eventBus.emit('member.verified', guildId, { discordId, username });
 *   eventBus.on('member.verified', async (event) => { ... });
 */
class PlatformEventBus {
  private emitter = new EventEmitter();

  constructor() {
    // Allow many listeners — automations, logging, sync, etc.
    this.emitter.setMaxListeners(100);
  }

  /**
   * Emit a typed platform event.
   */
  emit<T extends PlatformEventType>(
    type: T,
    guildId: string,
    data: PlatformEventMap[T],
  ): void {
    const event: PlatformEvent<T, PlatformEventMap[T]> = {
      type,
      guildId,
      timestamp: Date.now(),
      data,
    };

    console.log(`[EventBus] ${type} in guild ${guildId}`);
    this.emitter.emit(type, event);
    // Also emit to a catch-all listener
    this.emitter.emit('*', event);
  }

  /**
   * Listen for a specific event type.
   */
  on<T extends PlatformEventType>(
    type: T,
    handler: (event: PlatformEvent<T, PlatformEventMap[T]>) => void | Promise<void>,
  ): void {
    this.emitter.on(type, handler as (...args: unknown[]) => void);
  }

  /**
   * Listen for all events.
   */
  onAny(
    handler: (event: PlatformEvent) => void | Promise<void>,
  ): void {
    this.emitter.on('*', handler as (...args: unknown[]) => void);
  }

  /**
   * Remove a listener.
   */
  off<T extends PlatformEventType>(
    type: T,
    handler: (event: PlatformEvent<T, PlatformEventMap[T]>) => void | Promise<void>,
  ): void {
    this.emitter.off(type, handler as (...args: unknown[]) => void);
  }
}

/** Singleton event bus instance */
export const eventBus = new PlatformEventBus();
