/**
 * PlatformEventBus Tests — V53 Phase 5 (Finding 5.3)
 *
 * Tests the event bus emit/listen contract and typed events.
 * Uses the singleton eventBus since the class is not directly exported.
 *
 * V5 Audit §10.P3a — Updated for async dispatch via setImmediate().
 * After each emit() we flush the setImmediate queue before asserting.
 */
import { describe, it, expect, vi } from 'vitest';
import { eventBus } from '../services/event-bus.js';

/** Flush all pending setImmediate callbacks */
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('PlatformEventBus', () => {
  it('emits events to listeners', async () => {
    const handler = vi.fn();
    eventBus.on('member.joined', handler);

    eventBus.emit('member.joined', 'g456', { discordId: 'u123', guildId: 'g456' } as any);
    await flush();

    expect(handler).toHaveBeenCalledTimes(1);
    const event = handler.mock.calls[0]![0];
    expect(event.type).toBe('member.joined');
    expect(event.data.discordId).toBe('u123');
    expect(event.guildId).toBe('g456');

    eventBus.off('member.joined', handler);
  });

  it('delivers to multiple listeners', async () => {
    const h1 = vi.fn();
    const h2 = vi.fn();
    eventBus.on('level.up', h1);
    eventBus.on('level.up', h2);

    eventBus.emit('level.up', 'g1', { discordId: 'u1', newLevel: 5, guildId: 'g1' } as any);
    await flush();

    expect(h1).toHaveBeenCalledTimes(1);
    expect(h2).toHaveBeenCalledTimes(1);

    eventBus.off('level.up', h1);
    eventBus.off('level.up', h2);
  });

  it('does not deliver events to wrong type listeners', async () => {
    const handler = vi.fn();
    eventBus.on('member.joined', handler);

    eventBus.emit('member.left', 'g1', { discordId: 'u1', guildId: 'g1' } as any);
    await flush();

    expect(handler).not.toHaveBeenCalled();

    eventBus.off('member.joined', handler);
  });

  it('off removes listener', async () => {
    const handler = vi.fn();
    eventBus.on('ticket.opened', handler);
    eventBus.off('ticket.opened', handler);

    eventBus.emit('ticket.opened', 'g1', {
      ticketId: 't1', ticketNumber: 1, channelId: 'c1',
      userDiscordId: 'u1', panelId: 'p1',
    });
    await flush();

    expect(handler).not.toHaveBeenCalled();
  });

  it('event has timestamp', async () => {
    const handler = vi.fn();
    eventBus.on('member.banned', handler);

    const before = Date.now();
    eventBus.emit('member.banned', 'g1', { discordId: 'u1', guildId: 'g1' } as any);
    await flush();
    const after = Date.now();

    const event = handler.mock.calls[0]![0];
    expect(event.timestamp).toBeGreaterThanOrEqual(before);
    expect(event.timestamp).toBeLessThanOrEqual(after);

    eventBus.off('member.banned', handler);
  });

  it('event has guildId', async () => {
    const handler = vi.fn();
    eventBus.on('member.verified', handler);

    eventBus.emit('member.verified', 'guild-999', { discordId: 'u1', guildId: 'guild-999' } as any);
    await flush();

    const event = handler.mock.calls[0]![0];
    expect(event.guildId).toBe('guild-999');

    eventBus.off('member.verified', handler);
  });

  it('onAny catches all event types', async () => {
    const handler = vi.fn();
    eventBus.onAny(handler);

    eventBus.emit('member.joined', 'g1', { discordId: 'u1', guildId: 'g1' } as any);
    await flush();
    eventBus.emit('member.left', 'g1', { discordId: 'u2', guildId: 'g1' } as any);
    await flush();

    expect(handler).toHaveBeenCalledTimes(2);
    expect(handler.mock.calls[0]![0].type).toBe('member.joined');
    expect(handler.mock.calls[1]![0].type).toBe('member.left');

    // Clean up — onAny listens on '*'
    eventBus.off('*' as any, handler as any);
  });

  it('still dispatches a backpressure-exempt audit listener at MAX_IN_FLIGHT', () => {
    const auditHandler = vi.fn();
    const normalHandler = vi.fn();
    const internals = eventBus as unknown as { inFlight: number };
    const previousInFlight = internals.inFlight;

    try {
      eventBus.onAny(auditHandler, { backpressureExempt: true });
      eventBus.onAny(normalHandler);
      internals.inFlight = 500;

      eventBus.emit('automod.enforced', 'g1', {
        messageId: 'm1',
        channelId: 'c1',
        memberId: 'u1',
        rule: 'No spam',
        ruleType: 'spam',
        violation: 'burst',
        action: 'delete',
      });

      expect(auditHandler).toHaveBeenCalledOnce();
      expect(normalHandler).not.toHaveBeenCalled();
    } finally {
      internals.inFlight = previousInFlight;
      eventBus.off('*' as any, auditHandler as any);
      eventBus.off('*' as any, normalHandler as any);
    }
  });

  it('offAny removes the exact backpressure-exempt listener', () => {
    const auditHandler = vi.fn();
    eventBus.onAny(auditHandler, { backpressureExempt: true });

    eventBus.offAny(auditHandler);
    eventBus.emit('member.joined', 'g1', {
      discordId: 'u1',
      guildId: 'g1',
    } as any);

    expect(auditHandler).not.toHaveBeenCalled();
  });

  it('manually removing listener after first call emulates once', async () => {
    const handler = vi.fn();
    const wrapper = (...args: unknown[]) => {
      handler(...args);
      eventBus.off('purchase.completed', wrapper as any);
    };
    eventBus.on('purchase.completed', wrapper as any);

    eventBus.emit('purchase.completed', 'g1', { discordId: 'u1', productId: 'p1' } as any);
    await flush();
    eventBus.emit('purchase.completed', 'g1', { discordId: 'u2', productId: 'p2' } as any);
    await flush();

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('isolates listener errors without crashing other listeners', async () => {
    const good = vi.fn();
    const bad = vi.fn(() => { throw new Error('boom'); });

    eventBus.on('member.joined', bad as any);
    eventBus.on('member.joined', good);

    eventBus.emit('member.joined', 'g1', { discordId: 'u1', guildId: 'g1' } as any);
    await flush();

    // The good listener still fires even though bad threw
    expect(good).toHaveBeenCalledTimes(1);
    expect(bad).toHaveBeenCalledTimes(1);

    eventBus.off('member.joined', bad as any);
    eventBus.off('member.joined', good);
  });

  it('waits for async listeners to complete', async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const calls: string[] = [];
    const handler = vi.fn(async () => {
      calls.push('started');
      await pending;
      calls.push('finished');
    });
    eventBus.on('purchase.completed', handler);

    try {
      const emitted = eventBus.emitAndWait(
        'purchase.completed',
        'g1',
        { discordId: 'u1', productId: 'p1' } as any,
      );

      expect(calls).toEqual(['started']);
      let settled = false;
      void emitted.then(() => {
        settled = true;
      });
      await Promise.resolve();
      expect(settled).toBe(false);

      release();
      await emitted;
      expect(calls).toEqual(['started', 'finished']);
    } finally {
      release();
      eventBus.off('purchase.completed', handler);
    }
  });

  it('waits for every typed and wildcard listener before rejecting', async () => {
    const calls: string[] = [];
    const first = vi.fn(() => {
      calls.push('typed failure');
      throw new Error('typed listener failed');
    });
    const second = vi.fn(async () => {
      await Promise.resolve();
      calls.push('typed success');
    });
    const wildcard = vi.fn(() => {
      calls.push('wildcard failure');
      throw new Error('wildcard listener failed');
    });

    eventBus.on('purchase.completed', first);
    eventBus.on('purchase.completed', second);
    eventBus.onAny(wildcard);

    try {
      await expect(eventBus.emitAndWait(
        'purchase.completed',
        'g1',
        { discordId: 'u1', productId: 'p1' } as any,
      )).rejects.toThrow('2 listeners failed for purchase.completed');

      expect(first).toHaveBeenCalledTimes(1);
      expect(second).toHaveBeenCalledTimes(1);
      expect(wildcard).toHaveBeenCalledTimes(1);
      expect(calls).toEqual([
        'typed failure',
        'wildcard failure',
        'typed success',
      ]);
    } finally {
      eventBus.off('purchase.completed', first);
      eventBus.off('purchase.completed', second);
      eventBus.off('*' as any, wildcard as any);
    }
  });

  it('reserves a listener snapshot without starting it until the single-use handle dispatches', async () => {
    const first = vi.fn(async () => {});
    const addedAfterPreparation = vi.fn(async () => {});
    eventBus.on('purchase.completed', first);

    try {
      const prepared = eventBus.prepareEmitAndWait(
        'purchase.completed',
        'g1',
        { discordId: 'u1', productId: 'p1' } as any,
      );
      eventBus.on('purchase.completed', addedAfterPreparation);

      expect(first).not.toHaveBeenCalled();
      expect(addedAfterPreparation).not.toHaveBeenCalled();

      await prepared.dispatch();

      expect(first).toHaveBeenCalledTimes(1);
      expect(addedAfterPreparation).not.toHaveBeenCalled();
      await expect(prepared.dispatch()).rejects.toThrow('already consumed');
      prepared.cancel();
      prepared.cancel();
    } finally {
      eventBus.off('purchase.completed', first);
      eventBus.off('purchase.completed', addedAfterPreparation);
    }
  });

  it('cancels a prepared snapshot idempotently without starting any listener', async () => {
    const handler = vi.fn(async () => {});
    eventBus.on('purchase.completed', handler);

    try {
      const prepared = eventBus.prepareEmitAndWait(
        'purchase.completed',
        'g1',
        { discordId: 'u1', productId: 'p1' } as any,
      );
      prepared.cancel();
      prepared.cancel();

      expect(handler).not.toHaveBeenCalled();
      await expect(prepared.dispatch()).rejects.toThrow('cancelled');
    } finally {
      eventBus.off('purchase.completed', handler);
    }
  });

  it('settles every sync and async failure and consumes the prepared handle', async () => {
    const calls: string[] = [];
    const syncFailure = vi.fn(() => {
      calls.push('sync');
      throw new Error('sync failed');
    });
    const asyncFailure = vi.fn(async () => {
      await Promise.resolve();
      calls.push('async');
      throw new Error('async failed');
    });
    eventBus.on('purchase.completed', syncFailure);
    eventBus.on('purchase.completed', asyncFailure);

    try {
      const prepared = eventBus.prepareEmitAndWait(
        'purchase.completed',
        'g1',
        { discordId: 'u1', productId: 'p1' } as any,
      );
      await expect(prepared.dispatch()).rejects.toThrow(
        '2 listeners failed for purchase.completed',
      );
      expect(calls).toEqual(['sync', 'async']);
      await expect(prepared.dispatch()).rejects.toThrow('already consumed');

      // The failed dispatch released its reservation; a later snapshot can
      // still be prepared and cancelled without leaking capacity.
      const later = eventBus.prepareEmitAndWait(
        'purchase.completed',
        'g1',
        { discordId: 'u2', productId: 'p2' } as any,
      );
      later.cancel();
    } finally {
      eventBus.off('purchase.completed', syncFailure);
      eventBus.off('purchase.completed', asyncFailure);
    }
  });

  it('rejects before dispatch when awaited listeners exceed remaining capacity', async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fillerHandler = vi.fn(() => pending);
    const rejectedHandler = vi.fn(async () => {});
    for (let i = 0; i < 79; i++) {
      eventBus.on('member.joined', fillerHandler);
    }
    for (let i = 0; i < 27; i++) {
      eventBus.on('purchase.completed', rejectedHandler);
    }

    try {
      for (let i = 0; i < 6; i++) {
        eventBus.emit('member.joined', 'g1', {
          discordId: `u${i}`,
          guildId: 'g1',
        } as any);
      }

      let rejection: unknown;
      try {
        eventBus.prepareEmitAndWait('purchase.completed', 'g1', {
          discordId: 'overflow',
          productId: 'p1',
        } as any);
      } catch (error) {
        rejection = error;
      }
      expect(rejection).toMatchObject({
        name: 'EventBusDispatchNotStartedError',
        dispatchState: 'not_started',
        reason: 'backpressure',
        message: expect.stringContaining('Backpressure'),
      });
      expect(rejectedHandler).not.toHaveBeenCalled();

      // 474 active fillers + 26 reserved listeners is exactly the limit.
      // Reaching it proves the rejected preparation leaked no reservation.
      eventBus.off('purchase.completed', rejectedHandler);
      const atCapacity = eventBus.prepareEmitAndWait(
        'purchase.completed',
        'g1',
        { discordId: 'fits', productId: 'p1' } as any,
      );
      atCapacity.cancel();
      expect(rejectedHandler).not.toHaveBeenCalled();
    } finally {
      release();
      for (let i = 0; i < 79; i++) {
        eventBus.off('member.joined', fillerHandler);
      }
      for (let i = 0; i < 27; i++) {
        eventBus.off('purchase.completed', rejectedHandler);
      }
      await flush();
    }
  });

  it('reserves an ordinary typed and wildcard snapshot without overshooting shared capacity', async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const filler = vi.fn(() => pending);
    const typed = vi.fn(async () => {});
    const wildcard = vi.fn(async () => {});
    for (let i = 0; i < 83; i++) {
      eventBus.on('member.joined', filler);
    }
    eventBus.on('purchase.completed', typed);
    eventBus.on('purchase.completed', typed);

    try {
      // Six complete snapshots reserve 498 slots.
      for (let i = 0; i < 6; i++) {
        eventBus.emit('member.joined', 'g1', {
          discordId: `filler-${i}`,
          guildId: 'g1',
        } as any);
      }
      eventBus.onAny(wildcard);

      // The next ordinary snapshot needs all three typed+wildcard slots, so
      // it is dropped as a whole rather than partially scheduling to 501.
      eventBus.emit('purchase.completed', 'g1', {
        discordId: 'overflow',
        productId: 'p1',
      } as any);
      await flush();
      expect(typed).not.toHaveBeenCalled();
      expect(wildcard).not.toHaveBeenCalled();

      // Dropping the ordinary snapshot leaked no counter space: after one
      // typed listener is removed, typed+wildcard exactly reaches 500.
      eventBus.off('purchase.completed', typed);
      const atCapacity = eventBus.prepareEmitAndWait(
        'purchase.completed',
        'g1',
        { discordId: 'fits', productId: 'p1' } as any,
      );
      atCapacity.cancel();
    } finally {
      release();
      for (let i = 0; i < 83; i++) {
        eventBus.off('member.joined', filler);
      }
      eventBus.off('purchase.completed', typed);
      eventBus.off('*' as any, wildcard as any);
      await flush();
    }
  });
});
