/**
 * PlatformEventBus Tests — V53 Phase 5 (Finding 5.3)
 *
 * Tests the event bus emit/listen contract and typed events.
 * Uses the singleton eventBus since the class is not directly exported.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { eventBus } from '../services/event-bus.js';

describe('PlatformEventBus', () => {
  it('emits events to listeners', () => {
    const handler = vi.fn();
    eventBus.on('member.joined', handler);

    eventBus.emit('member.joined', 'g456', { discordId: 'u123', guildId: 'g456' } as any);

    expect(handler).toHaveBeenCalledTimes(1);
    const event = handler.mock.calls[0]![0];
    expect(event.type).toBe('member.joined');
    expect(event.data.discordId).toBe('u123');
    expect(event.guildId).toBe('g456');

    eventBus.off('member.joined', handler);
  });

  it('delivers to multiple listeners', () => {
    const h1 = vi.fn();
    const h2 = vi.fn();
    eventBus.on('level.up', h1);
    eventBus.on('level.up', h2);

    eventBus.emit('level.up', 'g1', { discordId: 'u1', newLevel: 5, guildId: 'g1' } as any);

    expect(h1).toHaveBeenCalledTimes(1);
    expect(h2).toHaveBeenCalledTimes(1);

    eventBus.off('level.up', h1);
    eventBus.off('level.up', h2);
  });

  it('does not deliver events to wrong type listeners', () => {
    const handler = vi.fn();
    eventBus.on('member.joined', handler);

    eventBus.emit('member.left', 'g1', { discordId: 'u1', guildId: 'g1' } as any);

    expect(handler).not.toHaveBeenCalled();

    eventBus.off('member.joined', handler);
  });

  it('off removes listener', () => {
    const handler = vi.fn();
    eventBus.on('ticket.opened', handler);
    eventBus.off('ticket.opened', handler);

    eventBus.emit('ticket.opened', 'g1', {
      ticketId: 't1', ticketNumber: 1, channelId: 'c1',
      userDiscordId: 'u1', panelId: 'p1',
    });

    expect(handler).not.toHaveBeenCalled();
  });

  it('event has timestamp', () => {
    const handler = vi.fn();
    eventBus.on('member.banned', handler);

    const before = Date.now();
    eventBus.emit('member.banned', 'g1', { discordId: 'u1', guildId: 'g1' } as any);
    const after = Date.now();

    const event = handler.mock.calls[0]![0];
    expect(event.timestamp).toBeGreaterThanOrEqual(before);
    expect(event.timestamp).toBeLessThanOrEqual(after);

    eventBus.off('member.banned', handler);
  });

  it('event has guildId', () => {
    const handler = vi.fn();
    eventBus.on('member.verified', handler);

    eventBus.emit('member.verified', 'guild-999', { discordId: 'u1', guildId: 'guild-999' } as any);

    const event = handler.mock.calls[0]![0];
    expect(event.guildId).toBe('guild-999');

    eventBus.off('member.verified', handler);
  });

  it('onAny catches all event types', () => {
    const handler = vi.fn();
    eventBus.onAny(handler);

    eventBus.emit('member.joined', 'g1', { discordId: 'u1', guildId: 'g1' } as any);
    eventBus.emit('member.left', 'g1', { discordId: 'u2', guildId: 'g1' } as any);

    expect(handler).toHaveBeenCalledTimes(2);
    expect(handler.mock.calls[0]![0].type).toBe('member.joined');
    expect(handler.mock.calls[1]![0].type).toBe('member.left');

    // Clean up — onAny listens on '*'
    eventBus.off('*' as any, handler as any);
  });

  it('manually removing listener after first call emulates once', () => {
    const handler = vi.fn();
    const wrapper = (...args: unknown[]) => {
      handler(...args);
      eventBus.off('purchase.completed', wrapper as any);
    };
    eventBus.on('purchase.completed', wrapper as any);

    eventBus.emit('purchase.completed', 'g1', { discordId: 'u1', productId: 'p1' } as any);
    eventBus.emit('purchase.completed', 'g1', { discordId: 'u2', productId: 'p2' } as any);

    expect(handler).toHaveBeenCalledTimes(1);
  });
});
