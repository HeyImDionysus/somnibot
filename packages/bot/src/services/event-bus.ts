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
  private backpressureExemptAnyListeners = new WeakSet<
    (event: PlatformEvent) => void | Promise<void>
  >();
  // V11 Audit M-5: Backpressure — track in-flight async handlers and
  // drop non-exempt listeners when the queue exceeds MAX_IN_FLIGHT to prevent
  // OOM under sustained event bursts (e.g. raid join floods).
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

    // Audit ingestion is deliberately synchronous at this boundary: its
    // listener only enqueues work into AuditService's finite,
    // occurrence-deduped buffer. Dispatch it before the general backpressure
    // gate so audit evidence is not silently discarded at MAX_IN_FLIGHT.
    const anyListeners = this.emitter.rawListeners('*') as Array<
      (e: PlatformEvent) => void | Promise<void>
    >;
    for (const listener of anyListeners) {
      if (!this.backpressureExemptAnyListeners.has(listener)) continue;
      try {
        void Promise.resolve(listener(event as PlatformEvent)).catch((err: unknown) => {
          log.error('Listener error on backpressure-exempt *:', err);
        });
      } catch (err) {
        log.error('Listener error on backpressure-exempt *:', err);
      }
    }

    // V11 Audit M-5: Drop non-exempt listeners when too many handlers are in flight.
    if (this.inFlight >= PlatformEventBus.MAX_IN_FLIGHT) {
      log.warn(`Backpressure: dropping non-exempt listeners for ${type} — ${this.inFlight} handlers in flight`);
      return;
    }

    const fireAsync = (eventName: string | symbol) => {
      const listeners = this.emitter.rawListeners(eventName) as Array<
        (e: PlatformEvent) => void | Promise<void>
      >;
      for (const listener of listeners) {
        if (eventName === '*' && this.backpressureExemptAnyListeners.has(listener)) continue;
        this.inFlight++;
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
    };

    fireAsync(type);
    fireAsync('*');
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
    options: { backpressureExempt?: boolean } = {},
  ): void {
    this.emitter.on('*', handler as (...args: unknown[]) => void);
    if (options.backpressureExempt) {
      this.backpressureExemptAnyListeners.add(handler);
    }
  }

  /**
   * Remove an all-events listener.
   *
   * Keep the WeakSet in lockstep with EventEmitter: otherwise a stopped
   * AuditService can stay reachable through `*` and be invoked again after
   * the guild is re-initialized.
   */
  offAny(handler: (event: PlatformEvent) => void | Promise<void>): void {
    this.emitter.off('*', handler as (...args: unknown[]) => void);
    this.backpressureExemptAnyListeners.delete(handler);
  }

  /**
   * Remove a listener.
   */
  off<T extends PlatformEventType>(
    type: T,
    handler: (event: PlatformEvent<T, PlatformEventMap[T]>) => void | Promise<void>,
  ): void {
    this.emitter.off(type, handler as (...args: unknown[]) => void);
    this.backpressureExemptAnyListeners.delete(handler as (event: PlatformEvent) => void | Promise<void>);
  }
}

export type { PlatformEventBus };

/** Singleton event bus instance */
export const eventBus = new PlatformEventBus();
