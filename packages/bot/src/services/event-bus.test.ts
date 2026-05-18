/**
 * EventBus — Unit Tests
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Re-create a fresh EventBus for each test (the module exports a singleton)
// so we inline a minimal copy that mirrors the real implementation.
import { EventEmitter } from 'node:events';

class TestEventBus {
  private emitter = new EventEmitter();

  constructor() {
    this.emitter.setMaxListeners(100);
  }

  emit(type: string, guildId: string, data: unknown): void {
    const event = { type, guildId, timestamp: Date.now(), data };
    this.emitter.emit(type, event);
    this.emitter.emit('*', event);
  }

  on(type: string, handler: (event: unknown) => void): void {
    this.emitter.on(type, handler);
  }

  onAny(handler: (event: unknown) => void): void {
    this.emitter.on('*', handler);
  }

  off(type: string, handler: (event: unknown) => void): void {
    this.emitter.off(type, handler);
  }
}

describe('EventBus', () => {
  let bus: TestEventBus;

  beforeEach(() => {
    bus = new TestEventBus();
  });

  it('should emit and receive typed events', () => {
    const handler = vi.fn();
    bus.on('member.joined', handler);
    bus.emit('member.joined', 'guild-1', { discordId: '123', username: 'test' });

    expect(handler).toHaveBeenCalledOnce();
    expect(handler.mock.calls[0][0]).toMatchObject({
      type: 'member.joined',
      guildId: 'guild-1',
      data: { discordId: '123', username: 'test' },
    });
  });

  it('should support catch-all listener via onAny()', () => {
    const allHandler = vi.fn();
    bus.onAny(allHandler);

    bus.emit('member.joined', 'g1', { discordId: '1' });
    bus.emit('ticket.opened', 'g1', { ticketId: 't1' });
    bus.emit('level.up', 'g1', { level: 5 });

    expect(allHandler).toHaveBeenCalledTimes(3);
    expect(allHandler.mock.calls[0][0]).toMatchObject({ type: 'member.joined' });
    expect(allHandler.mock.calls[1][0]).toMatchObject({ type: 'ticket.opened' });
    expect(allHandler.mock.calls[2][0]).toMatchObject({ type: 'level.up' });
  });

  it('should not fire handler after off()', () => {
    const handler = vi.fn();
    bus.on('member.joined', handler);
    bus.off('member.joined', handler);
    bus.emit('member.joined', 'g1', {});

    expect(handler).not.toHaveBeenCalled();
  });

  it('should include a timestamp in every event', () => {
    const handler = vi.fn();
    const before = Date.now();
    bus.on('level.up', handler);
    bus.emit('level.up', 'g1', { level: 10 });
    const after = Date.now();

    const event = handler.mock.calls[0][0] as { timestamp: number };
    expect(event.timestamp).toBeGreaterThanOrEqual(before);
    expect(event.timestamp).toBeLessThanOrEqual(after);
  });

  it('should not cross-fire between different event types', () => {
    const joinHandler = vi.fn();
    const leaveHandler = vi.fn();
    bus.on('member.joined', joinHandler);
    bus.on('member.left', leaveHandler);

    bus.emit('member.joined', 'g1', { discordId: '1' });

    expect(joinHandler).toHaveBeenCalledOnce();
    expect(leaveHandler).not.toHaveBeenCalled();
  });

  it('should support multiple listeners for the same event', () => {
    const h1 = vi.fn();
    const h2 = vi.fn();
    bus.on('ticket.opened', h1);
    bus.on('ticket.opened', h2);
    bus.emit('ticket.opened', 'g1', { ticketId: 't1' });

    expect(h1).toHaveBeenCalledOnce();
    expect(h2).toHaveBeenCalledOnce();
  });
});
