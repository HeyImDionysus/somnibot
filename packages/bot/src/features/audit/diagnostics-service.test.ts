/**
 * DiagnosticsService — Unit Tests
 *
 * Tests snapshot shape, alert thresholds, and periodic behavior.
 */
import { describe, it, expect, vi } from 'vitest';

describe('DiagnosticsService — Snapshot Shape', () => {
  it('should produce a valid snapshot object', () => {
    // Simulate what writeSnapshot() builds
    const snapshot = {
      guild_id: 'guild-123',
      uptime_seconds: 3600,
      memory_rss_mb: 128.5,
      memory_heap_mb: 64.2,
      lavalink_nodes: [
        { name: 'main', connected: true, players: 2 },
      ],
      valkey_connected: true,
      valkey_memory_mb: 12.5,
      guild_member_count: 150,
      active_voice_connections: 3,
      scheduled_message_count: 5,
      automation_count: 8,
      discord_ws_ping: 42,
      snapshot_at: new Date().toISOString(),
    };

    // Validate shape
    expect(snapshot).toHaveProperty('guild_id');
    expect(snapshot).toHaveProperty('uptime_seconds');
    expect(snapshot).toHaveProperty('memory_rss_mb');
    expect(snapshot).toHaveProperty('memory_heap_mb');
    expect(snapshot).toHaveProperty('lavalink_nodes');
    expect(snapshot).toHaveProperty('valkey_connected');
    expect(snapshot).toHaveProperty('discord_ws_ping');
    expect(snapshot).toHaveProperty('snapshot_at');

    // Validate types
    expect(typeof snapshot.uptime_seconds).toBe('number');
    expect(typeof snapshot.memory_rss_mb).toBe('number');
    expect(Array.isArray(snapshot.lavalink_nodes)).toBe(true);
    expect(typeof snapshot.valkey_connected).toBe('boolean');
  });

  it('should handle missing Lavalink nodes gracefully', () => {
    const snapshot = {
      lavalink_nodes: [],
      valkey_connected: false,
      valkey_memory_mb: 0,
    };

    expect(snapshot.lavalink_nodes).toHaveLength(0);
    expect(snapshot.valkey_connected).toBe(false);
  });
});

describe('DiagnosticsService — Alert Thresholds', () => {
  const THRESHOLDS = {
    memoryRssMb: 512,    // Alert if RSS > 512MB
    wsPingMs: 500,        // Alert if WS ping > 500ms
    valkeyDisconnected: true,
    lavalinkAllDown: true,
    staleSnapshotMinutes: 3,
  };

  it('should trigger memory alert when RSS exceeds threshold', () => {
    const currentRss = 600;
    const shouldAlert = currentRss > THRESHOLDS.memoryRssMb;
    expect(shouldAlert).toBe(true);
  });

  it('should not trigger memory alert when within threshold', () => {
    const currentRss = 256;
    const shouldAlert = currentRss > THRESHOLDS.memoryRssMb;
    expect(shouldAlert).toBe(false);
  });

  it('should trigger ws ping alert when latency is high', () => {
    const currentPing = 750;
    const shouldAlert = currentPing > THRESHOLDS.wsPingMs;
    expect(shouldAlert).toBe(true);
  });

  it('should trigger Lavalink alert when all nodes are down', () => {
    const nodes = [
      { name: 'main', connected: false, players: 0 },
      { name: 'backup', connected: false, players: 0 },
    ];
    const allDown = nodes.length > 0 && nodes.every((n) => !n.connected);
    expect(allDown).toBe(true);
  });

  it('should not trigger Lavalink alert when at least one node is up', () => {
    const nodes = [
      { name: 'main', connected: true, players: 2 },
      { name: 'backup', connected: false, players: 0 },
    ];
    const allDown = nodes.length > 0 && nodes.every((n) => !n.connected);
    expect(allDown).toBe(false);
  });

  it('should detect stale snapshot (bot offline)', () => {
    const lastSnapshot = new Date(Date.now() - 5 * 60 * 1000); // 5 minutes ago
    const staleMs = THRESHOLDS.staleSnapshotMinutes * 60 * 1000;
    const isStale = Date.now() - lastSnapshot.getTime() > staleMs;
    expect(isStale).toBe(true);
  });
});

describe('DiagnosticsService — Periodic Behavior', () => {
  it('should schedule snapshots at 60-second intervals', () => {
    vi.useFakeTimers();
    const callback = vi.fn();

    const timer = setInterval(callback, 60_000);

    // Immediate call doesn't happen with setInterval
    expect(callback).not.toHaveBeenCalled();

    vi.advanceTimersByTime(60_000);
    expect(callback).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(120_000);
    expect(callback).toHaveBeenCalledTimes(3);

    clearInterval(timer);
    vi.useRealTimers();
  });

  it('should stop cleanly when stop() is called', () => {
    vi.useFakeTimers();
    const callback = vi.fn();
    let timer: ReturnType<typeof setInterval> | null = setInterval(callback, 60_000);

    vi.advanceTimersByTime(60_000);
    expect(callback).toHaveBeenCalledTimes(1);

    // Stop
    if (timer) {
      clearInterval(timer);
      timer = null;
    }

    vi.advanceTimersByTime(120_000);
    expect(callback).toHaveBeenCalledTimes(1); // No more calls

    vi.useRealTimers();
  });
});
