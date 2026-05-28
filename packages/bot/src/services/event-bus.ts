import { EventEmitter } from 'node:events';
import type { PlatformEventMap, PlatformEventType, PlatformEvent } from '@somnibot/shared';
import { createLogger } from '@somnibot/shared';

const log = createLogger('EventBus');

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
   *
   * V5 Audit §10.P3a — Listeners are dispatched asynchronously via
   * setImmediate() so a slow analytics/logging handler cannot block
   * the critical path (e.g. command response). Each listener is
   * error-isolated so one failing handler cannot crash others.
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

    log.info(`${type} in guild ${guildId}`);

    const fireAsync = (eventName: string | symbol) => {
      const listeners = this.emitter.rawListeners(eventName) as Array<
        (e: PlatformEvent) => void | Promise<void>
      >;
      for (const listener of listeners) {
        setImmediate(async () => {
          try {
            await listener(event as PlatformEvent);
          } catch (err) {
            log.error(`Listener error on ${String(eventName)}:`, err);
          }
        });
      }
    };

    fireAsync(type);
    fireAsync('*');
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

export type { PlatformEventBus };

/** Singleton event bus instance */
export const eventBus = new PlatformEventBus();
