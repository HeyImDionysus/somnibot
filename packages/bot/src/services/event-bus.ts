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
export interface PreparedEventDispatch {
  dispatch(): Promise<void>;
  cancel(): void;
}

export class EventBusDispatchNotStartedError extends Error {
  readonly dispatchState = 'not_started' as const;
  readonly reason = 'backpressure' as const;

  constructor(message: string) {
    super(message);
    this.name = 'EventBusDispatchNotStartedError';
  }
}

export class PlatformEventBus {
  private emitter = new EventEmitter();
  // V11 Audit M-5: Backpressure — track in-flight async handlers and
  // drop events when the queue exceeds MAX_IN_FLIGHT to prevent OOM
  // under sustained event bursts (e.g. raid join floods).
  private inFlight = 0;
  private static readonly MAX_IN_FLIGHT = 500;

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

    const typedListeners = this.emitter.rawListeners(type) as Array<
      (e: PlatformEvent) => void | Promise<void>
    >;
    const wildcardListeners = this.emitter.rawListeners('*') as Array<
      (e: PlatformEvent) => void | Promise<void>
    >;
    const listeners = [
      ...typedListeners.map((listener) => ({ eventName: type, listener })),
      ...wildcardListeners.map((listener) => ({ eventName: '*', listener })),
    ];

    // Reserve the whole typed + wildcard snapshot atomically. Ordinary
    // fire-and-forget traffic shares capacity with prepared commerce events,
    // so it must never overshoot the counter one callback at a time.
    if (this.inFlight + listeners.length > PlatformEventBus.MAX_IN_FLIGHT) {
      log.warn(
        `Backpressure: dropping ${type} — ${this.inFlight} handlers in flight, `
        + `${listeners.length} requested`,
      );
      return;
    }
    this.inFlight += listeners.length;

    for (const { eventName, listener } of listeners) {
      setImmediate(async () => {
        try {
          await listener(event as PlatformEvent);
        } catch (err) {
          log.error(`Listener error on ${String(eventName)}:`, err);
        } finally {
          this.inFlight--;
        }
      });
    }
  }

  /**
   * Emit a typed platform event and wait for every current listener.
   *
   * Intended for commerce and other critical paths where the caller must know
   * whether all side effects completed. Unlike emit(), listener failures are
   * propagated after every typed and wildcard listener has settled.
   */
  async emitAndWait<T extends PlatformEventType>(
    type: T,
    guildId: string,
    data: PlatformEventMap[T],
  ): Promise<void> {
    return this.prepareEmitAndWait(type, guildId, data).dispatch();
  }

  /**
   * Reserve one immutable listener snapshot without starting it.
   *
   * Commerce uses this before committing a database transition. Capacity
   * exhaustion is therefore known to be pre-dispatch, while every failure
   * after dispatch begins remains conservatively uncertain.
   */
  prepareEmitAndWait<T extends PlatformEventType>(
    type: T,
    guildId: string,
    data: PlatformEventMap[T],
  ): PreparedEventDispatch {
    const event: PlatformEvent<T, PlatformEventMap[T]> = {
      type,
      guildId,
      timestamp: Date.now(),
      data,
    };
    const typedListeners = this.emitter.rawListeners(type) as Array<
      (e: PlatformEvent) => void | Promise<void>
    >;
    const wildcardListeners = this.emitter.rawListeners('*') as Array<
      (e: PlatformEvent) => void | Promise<void>
    >;
    const listeners = [...typedListeners, ...wildcardListeners];
    const listenerCount = listeners.length;

    log.info(`${type} in guild ${guildId}`);

    if (this.inFlight + listenerCount > PlatformEventBus.MAX_IN_FLIGHT) {
      const message = `Backpressure: rejecting ${type} — ${this.inFlight} handlers in flight, ${listenerCount} requested`;
      log.warn(message);
      throw new EventBusDispatchNotStartedError(message);
    }

    // Reserve the entire snapshot before any listener can start or another
    // awaited emission can observe stale capacity.
    this.inFlight += listenerCount;
    let state: 'prepared' | 'dispatching' | 'settled' | 'cancelled' = 'prepared';
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      this.inFlight -= listenerCount;
    };

    return {
      dispatch: async () => {
        if (state === 'cancelled') {
          throw new Error(`Prepared event dispatch for ${type} was cancelled`);
        }
        if (state !== 'prepared') {
          throw new Error(`Prepared event dispatch for ${type} was already consumed`);
        }
        // Mark the handle consumed before invoking the first listener. Even a
        // synchronous throw is now an uncertain post-dispatch outcome.
        state = 'dispatching';
        try {
          const results = await Promise.allSettled(
            listeners.map(async (listener) => listener(event as PlatformEvent)),
          );
          const failures = results.filter(
            (result): result is PromiseRejectedResult => result.status === 'rejected',
          );

          if (failures.length > 0) {
            throw new AggregateError(
              failures.map((failure) => failure.reason),
              `${failures.length} listeners failed for ${type}`,
            );
          }
        } finally {
          state = 'settled';
          release();
        }
      },
      cancel: () => {
        if (state !== 'prepared') return;
        state = 'cancelled';
        release();
      }
    };
  }

  /**
   * Listen for a specific event type.
   *
   * V5 Audit §6.2: Warns when listener count exceeds 80 (soft limit)
   * so we catch potential leaks before hitting the hard cap of 100.
   */
  on<T extends PlatformEventType>(
    type: T,
    handler: (event: PlatformEvent<T, PlatformEventMap[T]>) => void | Promise<void>,
  ): void {
    this.emitter.on(type, handler as (...args: unknown[]) => void);
    const count = this.emitter.listenerCount(type);
    if (count >= 80) {
      log.warn(`High listener count on "${type}": ${count}/100 — possible leak`);
    }
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
