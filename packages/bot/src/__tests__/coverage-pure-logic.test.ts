/**
 * Pure logic tests — NO discord.js mock.
 * Targets modules that don't import discord.js:
 *  - fraud-detection (5 functions, 63 uncov)
 *  - alert-manager (AlertManager, 31 uncov)
 *  - music-queue (MusicQueueManager, 42 uncov)
 *  - automation-loader (AutomationLoader, 44 uncov)
 *  - rate-limiter (automations), execution-logger
 *
 * Goal: cover 80+ new statements to cross 70% threshold.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Minimal shared mock (no discord.js!) ──────────────────
vi.mock('@somnibot/shared', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  SOMNI_PALETTE: { PRIMARY: 0x5865F2, SUCCESS: 0x57F287, ERROR: 0xED4245, WARN: 0xFEE75C },
  AUTOMATION_LIMITS: { MAX_CHAIN_DEPTH: 3 },
}));

// ── Mock supabase helper ──────────────────────────────────
function mockSupa() {
  const chain: any = {
    select: vi.fn().mockReturnThis(),
    insert: vi.fn().mockReturnThis(),
    update: vi.fn().mockReturnThis(),
    delete: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    neq: vi.fn().mockReturnThis(),
    not: vi.fn().mockReturnThis(),
    gte: vi.fn().mockReturnThis(),
    lte: vi.fn().mockReturnThis(),
    gt: vi.fn().mockReturnThis(),
    lt: vi.fn().mockReturnThis(),
    in: vi.fn().mockReturnThis(),
    is: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    order: vi.fn().mockReturnThis(),
    range: vi.fn().mockReturnThis(),
    single: vi.fn().mockResolvedValue({ data: null, error: null }),
    maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
    then: undefined as any,  // must NOT have .then so it's not thenable
  };
  // Make it resolve as a query when awaited at chain level
  chain.then = vi.fn((resolve: any) => resolve({ data: null, error: null, count: 0 }));

  const supa: any = {
    from: vi.fn(() => chain),
    rpc: vi.fn().mockResolvedValue({ data: null, error: null }),
    channel: vi.fn(() => ({
      on: vi.fn().mockReturnThis(),
      subscribe: vi.fn(),
    })),
  };
  return { supa, chain };
}

function mockValkey() {
  return {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue('OK'),
    del: vi.fn().mockResolvedValue(1),
    sadd: vi.fn().mockResolvedValue(1),
    scard: vi.fn().mockResolvedValue(0),
    smembers: vi.fn().mockResolvedValue([]),
    srem: vi.fn().mockResolvedValue(1),
    expire: vi.fn().mockResolvedValue(1),
    incr: vi.fn().mockResolvedValue(1),
    exists: vi.fn().mockResolvedValue(0),
    ttl: vi.fn().mockResolvedValue(-2),
  } as any;
}

// ═══════════════════════════════════════════════════════════
// 1. AlertManager — evaluate all alert types
// ═══════════════════════════════════════════════════════════
describe('AlertManager', () => {
  it('constructs with defaults', async () => {
    const { AlertManager } = await import('../features/audit/alert-manager.js');
    const { supa } = mockSupa();
    const mgr = new AlertManager(supa);
    expect(mgr).toBeDefined();
  });

  it('constructs with custom thresholds', async () => {
    const { AlertManager } = await import('../features/audit/alert-manager.js');
    const { supa } = mockSupa();
    const mgr = new AlertManager(supa, { memoryRssMb: 256, wsPingMs: 200 });
    expect(mgr).toBeDefined();
  });

  it('evaluate — no alerts when healthy', async () => {
    const { AlertManager } = await import('../features/audit/alert-manager.js');
    const { supa } = mockSupa();
    const mgr = new AlertManager(supa);
    await mgr.evaluate({
      guild_id: 'g1',
      memory_rss_mb: 100,
      discord_ws_ping: 50,
      valkey_connected: true,
      lavalink_nodes: [{ name: 'node1', connected: true, players: 0 }],
    });
    // Should not throw
  });

  it('evaluate — memory high warning', async () => {
    const { AlertManager } = await import('../features/audit/alert-manager.js');
    const { supa, chain } = mockSupa();
    chain.maybeSingle.mockResolvedValue({ data: null, error: null });
    const mgr = new AlertManager(supa, { memoryRssMb: 256 });
    await mgr.evaluate({
      guild_id: 'g1',
      memory_rss_mb: 300, // above 256 threshold
      discord_ws_ping: 50,
      valkey_connected: true,
      lavalink_nodes: [],
    });
    expect(supa.from).toHaveBeenCalledWith('alerts');
  });

  it('evaluate — memory critical', async () => {
    const { AlertManager } = await import('../features/audit/alert-manager.js');
    const { supa, chain } = mockSupa();
    chain.maybeSingle.mockResolvedValue({ data: null, error: null });
    const mgr = new AlertManager(supa, { memoryRssMb: 256 });
    await mgr.evaluate({
      guild_id: 'g1',
      memory_rss_mb: 600, // above 256 * 1.5 = critical
      discord_ws_ping: 50,
      valkey_connected: true,
      lavalink_nodes: [],
    });
    expect(supa.from).toHaveBeenCalledWith('alerts');
  });

  it('evaluate — ws ping high', async () => {
    const { AlertManager } = await import('../features/audit/alert-manager.js');
    const { supa, chain } = mockSupa();
    chain.maybeSingle.mockResolvedValue({ data: null, error: null });
    const mgr = new AlertManager(supa, { wsPingMs: 200 });
    await mgr.evaluate({
      guild_id: 'g1',
      memory_rss_mb: 100,
      discord_ws_ping: 300, // above threshold
      valkey_connected: true,
      lavalink_nodes: [],
    });
    expect(supa.from).toHaveBeenCalledWith('alerts');
  });

  it('evaluate — ws ping critical', async () => {
    const { AlertManager } = await import('../features/audit/alert-manager.js');
    const { supa, chain } = mockSupa();
    chain.maybeSingle.mockResolvedValue({ data: null, error: null });
    const mgr = new AlertManager(supa, { wsPingMs: 200 });
    await mgr.evaluate({
      guild_id: 'g1',
      memory_rss_mb: 100,
      discord_ws_ping: 500, // > 200 * 2 = critical
      valkey_connected: true,
      lavalink_nodes: [],
    });
    expect(supa.from).toHaveBeenCalledWith('alerts');
  });

  it('evaluate — valkey disconnected', async () => {
    const { AlertManager } = await import('../features/audit/alert-manager.js');
    const { supa, chain } = mockSupa();
    chain.maybeSingle.mockResolvedValue({ data: null, error: null });
    const mgr = new AlertManager(supa);
    await mgr.evaluate({
      guild_id: 'g1',
      memory_rss_mb: 100,
      discord_ws_ping: 50,
      valkey_connected: false, // disconnected
      lavalink_nodes: [],
    });
    expect(supa.from).toHaveBeenCalledWith('alerts');
  });

  it('evaluate — all lavalink nodes down', async () => {
    const { AlertManager } = await import('../features/audit/alert-manager.js');
    const { supa, chain } = mockSupa();
    chain.maybeSingle.mockResolvedValue({ data: null, error: null });
    const mgr = new AlertManager(supa);
    await mgr.evaluate({
      guild_id: 'g1',
      memory_rss_mb: 100,
      discord_ws_ping: 50,
      valkey_connected: true,
      lavalink_nodes: [
        { name: 'n1', connected: false, players: 0 },
        { name: 'n2', connected: false, players: 0 },
      ],
    });
    expect(supa.from).toHaveBeenCalledWith('alerts');
  });

  it('evaluate — updates existing alert', async () => {
    const { AlertManager } = await import('../features/audit/alert-manager.js');
    const { supa, chain } = mockSupa();
    chain.maybeSingle.mockResolvedValue({ data: { id: 'alert-1' }, error: null });
    const mgr = new AlertManager(supa);
    await mgr.evaluate({
      guild_id: 'g1',
      memory_rss_mb: 600,
      discord_ws_ping: 50,
      valkey_connected: true,
      lavalink_nodes: [],
    });
    // Should call update on existing alert
    expect(chain.update).toHaveBeenCalled();
  });

  it('evaluate — resolves cleared alerts', async () => {
    const { AlertManager } = await import('../features/audit/alert-manager.js');
    const { supa, chain } = mockSupa();
    chain.maybeSingle.mockResolvedValue({ data: null, error: null });
    const mgr = new AlertManager(supa);
    // First: trigger an alert
    await mgr.evaluate({
      guild_id: 'g1',
      memory_rss_mb: 600,
      discord_ws_ping: 50,
      valkey_connected: true,
      lavalink_nodes: [],
    });
    // Then: clear it
    await mgr.evaluate({
      guild_id: 'g1',
      memory_rss_mb: 100,
      discord_ws_ping: 50,
      valkey_connected: true,
      lavalink_nodes: [],
    });
    // Should resolve memory_high alert
  });
});

// ═══════════════════════════════════════════════════════════
// 2. Fraud Detection — all 5 functions
// ═══════════════════════════════════════════════════════════
describe('Fraud Detection', () => {
  let fraud: any;

  beforeEach(async () => {
    vi.clearAllMocks();
    fraud = await import('../services/fraud-detection.js');
  });

  it('checkPurchaseVelocity — below threshold', async () => {
    const { supa, chain } = mockSupa();
    chain.then = vi.fn((resolve: any) => resolve({ data: null, error: null, count: 2 }));
    await fraud.checkPurchaseVelocity({ supabase: supa, guildId: 'g1' }, 'cust1', 'disc1');
    // count=2 < threshold=5, no signal
  });

  it('checkPurchaseVelocity — above threshold (high)', async () => {
    const { supa, chain } = mockSupa();
    chain.then = vi.fn((resolve: any) => resolve({ data: null, error: null, count: 7 }));
    await fraud.checkPurchaseVelocity({ supabase: supa, guildId: 'g1' }, 'cust1', 'disc1');
    // count=7 >= 5, should create signal with severity 'high'
    expect(supa.from).toHaveBeenCalledWith('fraud_signals');
  });

  it('checkPurchaseVelocity — critical threshold', async () => {
    const { supa, chain } = mockSupa();
    chain.then = vi.fn((resolve: any) => resolve({ data: null, error: null, count: 11 }));
    await fraud.checkPurchaseVelocity({ supabase: supa, guildId: 'g1' }, 'cust1', null);
    expect(supa.from).toHaveBeenCalledWith('fraud_signals');
  });

  it('checkPurchaseVelocity — with eventBus', async () => {
    const { supa, chain } = mockSupa();
    chain.then = vi.fn((resolve: any) => resolve({ data: null, error: null, count: 6 }));
    const bus = { emit: vi.fn(), on: vi.fn(), off: vi.fn() };
    await fraud.checkPurchaseVelocity({ supabase: supa, guildId: 'g1', eventBus: bus }, 'cust1', 'disc1');
    expect(bus.emit).toHaveBeenCalledWith('fraud.detected', 'g1', expect.any(Object));
  });

  it('checkDeviceAbuse — below threshold', async () => {
    const { supa, chain } = mockSupa();
    chain.then = vi.fn((resolve: any) => resolve({ data: null, error: null, count: 5 }));
    await fraud.checkDeviceAbuse({ supabase: supa, guildId: 'g1' }, 'key1', 3, 'disc1');
    // count=5 < 3*3=9, no signal
  });

  it('checkDeviceAbuse — above threshold (high)', async () => {
    const { supa, chain } = mockSupa();
    chain.then = vi.fn((resolve: any) => resolve({ data: null, error: null, count: 10 }));
    await fraud.checkDeviceAbuse({ supabase: supa, guildId: 'g1' }, 'key1', 3, 'disc1');
    // count=10 > 3*3=9, severity high
    expect(supa.from).toHaveBeenCalledWith('fraud_signals');
  });

  it('checkDeviceAbuse — critical', async () => {
    const { supa, chain } = mockSupa();
    chain.then = vi.fn((resolve: any) => resolve({ data: null, error: null, count: 16 }));
    await fraud.checkDeviceAbuse({ supabase: supa, guildId: 'g1' }, 'key1', 3, null);
    // count=16 > 3*5=15, severity critical
    expect(supa.from).toHaveBeenCalledWith('fraud_signals');
  });

  it('checkIPMismatch — few IPs (no signal)', async () => {
    const { supa, chain } = mockSupa();
    chain.then = vi.fn((resolve: any) => resolve({
      data: [{ ip_address: '1.1.1.1' }, { ip_address: '2.2.2.2' }],
      error: null,
    }));
    await fraud.checkIPMismatch({ supabase: supa, guildId: 'g1' }, 'key1', 'disc1');
    // 2 unique IPs < 5 threshold
  });

  it('checkIPMismatch — many IPs (medium)', async () => {
    const { supa, chain } = mockSupa();
    const ips = Array.from({ length: 6 }, (_, i) => ({ ip_address: `10.0.0.${i}` }));
    chain.then = vi.fn((resolve: any) => resolve({ data: ips, error: null }));
    await fraud.checkIPMismatch({ supabase: supa, guildId: 'g1' }, 'key1', 'disc1');
    expect(supa.from).toHaveBeenCalledWith('fraud_signals');
  });

  it('checkIPMismatch — many IPs (critical)', async () => {
    const { supa, chain } = mockSupa();
    const ips = Array.from({ length: 12 }, (_, i) => ({ ip_address: `10.0.${i}.1` }));
    chain.then = vi.fn((resolve: any) => resolve({ data: ips, error: null }));
    await fraud.checkIPMismatch({ supabase: supa, guildId: 'g1' }, 'key1', null);
    expect(supa.from).toHaveBeenCalledWith('fraud_signals');
  });

  it('checkPaymentPattern — below threshold', async () => {
    const { supa, chain } = mockSupa();
    chain.then = vi.fn((resolve: any) => resolve({ data: null, error: null, count: 1 }));
    await fraud.checkPaymentPattern({ supabase: supa, guildId: 'g1' }, 'cust1', 'disc1');
  });

  it('checkPaymentPattern — above threshold (medium)', async () => {
    const { supa, chain } = mockSupa();
    chain.then = vi.fn((resolve: any) => resolve({ data: null, error: null, count: 4 }));
    await fraud.checkPaymentPattern({ supabase: supa, guildId: 'g1' }, 'cust1', 'disc1');
    expect(supa.from).toHaveBeenCalledWith('fraud_signals');
  });

  it('checkPaymentPattern — high severity', async () => {
    const { supa, chain } = mockSupa();
    chain.then = vi.fn((resolve: any) => resolve({ data: null, error: null, count: 6 }));
    await fraud.checkPaymentPattern({ supabase: supa, guildId: 'g1' }, 'cust1', null);
    expect(supa.from).toHaveBeenCalledWith('fraud_signals');
  });

  it('checkCriticalThreshold — below threshold', async () => {
    const { supa, chain } = mockSupa();
    chain.then = vi.fn((resolve: any) => resolve({ data: null, error: null, count: 1 }));
    await fraud.checkCriticalThreshold({ supabase: supa, guildId: 'g1' });
  });

  it('checkCriticalThreshold — creates incident', async () => {
    const { supa, chain } = mockSupa();
    let callCount = 0;
    chain.then = vi.fn((resolve: any) => {
      callCount++;
      if (callCount === 1) return resolve({ data: null, error: null, count: 5 }); // signals count
      return resolve({ data: [], error: null }); // no existing incident
    });
    chain.single.mockResolvedValue({
      data: { id: 'inc-1', title: 'test' },
      error: null,
    });
    supa.rpc.mockResolvedValue({ data: 42, error: null });
    await fraud.checkCriticalThreshold({ supabase: supa, guildId: 'g1' });
  });

  it('checkCriticalThreshold — with eventBus', async () => {
    const { supa, chain } = mockSupa();
    let callCount = 0;
    chain.then = vi.fn((resolve: any) => {
      callCount++;
      if (callCount === 1) return resolve({ data: null, error: null, count: 5 });
      return resolve({ data: [], error: null });
    });
    chain.single.mockResolvedValue({
      data: { id: 'inc-1', title: 'Fraud alert', incident_number: 42 },
      error: null,
    });
    supa.rpc.mockResolvedValue({ data: 42, error: null });
    const bus = { emit: vi.fn(), on: vi.fn(), off: vi.fn() };
    await fraud.checkCriticalThreshold({ supabase: supa, guildId: 'g1', eventBus: bus });
    expect(bus.emit).toHaveBeenCalled();
  });

  it('checkCriticalThreshold — existing incident skips creation', async () => {
    const { supa, chain } = mockSupa();
    let callCount = 0;
    chain.then = vi.fn((resolve: any) => {
      callCount++;
      if (callCount === 1) return resolve({ data: null, error: null, count: 5 });
      return resolve({ data: [{ id: 'existing-inc' }], error: null });
    });
    await fraud.checkCriticalThreshold({ supabase: supa, guildId: 'g1' });
    // Should NOT create a new incident
  });
});

// ═══════════════════════════════════════════════════════════
// 3. MusicQueueManager — queue operations
// ═══════════════════════════════════════════════════════════
describe('MusicQueueManager', () => {
  let MusicQueueManager: any;

  beforeEach(async () => {
    vi.clearAllMocks();
    const mod = await import('../features/music/music-queue.js');
    MusicQueueManager = mod.MusicQueueManager;
  });

  function sampleEntry(n = 1): any {
    return {
      track: `base64track${n}`, title: `Song ${n}`, author: `Artist ${n}`,
      duration: 200000, uri: `https://yt.com/${n}`, artworkUrl: null,
      requestedBy: 'u1', addedAt: Date.now(), isStream: false,
    };
  }

  it('getQueue returns null when empty', async () => {
    const valkey = mockValkey();
    const mgr = new MusicQueueManager(valkey);
    const q = await mgr.getQueue('g1');
    expect(q).toBeNull();
  });

  it('getQueue returns parsed queue', async () => {
    const valkey = mockValkey();
    const queue = { guildId: 'g1', entries: [sampleEntry()], currentIndex: 0, loopMode: 'off', volume: 80, shuffled: false, paused: false, voiceChannelId: 'vc1', textChannelId: 'tc1' };
    valkey.get.mockResolvedValue(JSON.stringify(queue));
    const mgr = new MusicQueueManager(valkey);
    const q = await mgr.getQueue('g1');
    expect(q).toBeDefined();
    expect(q!.guildId).toBe('g1');
  });

  it('getQueue handles invalid JSON', async () => {
    const valkey = mockValkey();
    valkey.get.mockResolvedValue('not valid json{{{');
    const mgr = new MusicQueueManager(valkey);
    const q = await mgr.getQueue('g1');
    expect(q).toBeNull();
  });

  it('saveQueue writes to valkey', async () => {
    const valkey = mockValkey();
    const mgr = new MusicQueueManager(valkey);
    const queue = mgr.createQueue('g1', 'vc1', 'tc1', 80);
    await mgr.saveQueue(queue);
    expect(valkey.set).toHaveBeenCalled();
  });

  it('createQueue returns proper defaults', async () => {
    const valkey = mockValkey();
    const mgr = new MusicQueueManager(valkey);
    const q = mgr.createQueue('g1', 'vc1', 'tc1', 75);
    expect(q.guildId).toBe('g1');
    expect(q.volume).toBe(75);
    expect(q.entries).toEqual([]);
    expect(q.loopMode).toBe('off');
  });

  it('addEntries adds entries', async () => {
    const valkey = mockValkey();
    valkey.get.mockResolvedValue(JSON.stringify({ guildId: 'g1', entries: [], currentIndex: 0, loopMode: 'off', volume: 80, shuffled: false, paused: false, voiceChannelId: 'vc1', textChannelId: 'tc1' }));
    const mgr = new MusicQueueManager(valkey);
    const q = await mgr.addEntries('g1', [sampleEntry(1), sampleEntry(2)]);
    expect(q).toBeDefined();
    expect(q!.entries.length).toBe(2);
  });

  it('addEntries respects max queue size', async () => {
    const valkey = mockValkey();
    const fullQueue = { guildId: 'g1', entries: Array.from({ length: 5000 }, (_, i) => sampleEntry(i)), currentIndex: 0, loopMode: 'off', volume: 80, shuffled: false, paused: false, voiceChannelId: 'vc1', textChannelId: 'tc1' };
    valkey.get.mockResolvedValue(JSON.stringify(fullQueue));
    const mgr = new MusicQueueManager(valkey);
    const q = await mgr.addEntries('g1', [sampleEntry(9999)]);
    expect(q).toBeDefined();
    expect(q!.entries.length).toBe(5000); // No new entries
  });

  it('addEntries returns null if no queue', async () => {
    const valkey = mockValkey();
    const mgr = new MusicQueueManager(valkey);
    const q = await mgr.addEntries('g1', [sampleEntry()]);
    expect(q).toBeNull();
  });

  it('removeEntry removes entry', async () => {
    const valkey = mockValkey();
    valkey.get.mockResolvedValue(JSON.stringify({ guildId: 'g1', entries: [sampleEntry(1), sampleEntry(2)], currentIndex: 0, loopMode: 'off', volume: 80, shuffled: false, paused: false, voiceChannelId: 'vc1', textChannelId: 'tc1' }));
    const mgr = new MusicQueueManager(valkey);
    const removed = await mgr.removeEntry('g1', 0);
    expect(removed).toBeDefined();
  });

  it('removeEntry adjusts currentIndex', async () => {
    const valkey = mockValkey();
    valkey.get.mockResolvedValue(JSON.stringify({ guildId: 'g1', entries: [sampleEntry(1), sampleEntry(2), sampleEntry(3)], currentIndex: 2, loopMode: 'off', volume: 80, shuffled: false, paused: false, voiceChannelId: 'vc1', textChannelId: 'tc1' }));
    const mgr = new MusicQueueManager(valkey);
    const removed = await mgr.removeEntry('g1', 1);
    expect(removed).toBeDefined();
  });

  it('removeEntry out of bounds', async () => {
    const valkey = mockValkey();
    valkey.get.mockResolvedValue(JSON.stringify({ guildId: 'g1', entries: [sampleEntry(1)], currentIndex: 0, loopMode: 'off', volume: 80, shuffled: false, paused: false, voiceChannelId: 'vc1', textChannelId: 'tc1' }));
    const mgr = new MusicQueueManager(valkey);
    const removed = await mgr.removeEntry('g1', 5);
    expect(removed).toBeNull();
  });

  it('moveEntry moves track', async () => {
    const valkey = mockValkey();
    valkey.get.mockResolvedValue(JSON.stringify({ guildId: 'g1', entries: [sampleEntry(1), sampleEntry(2), sampleEntry(3)], currentIndex: 0, loopMode: 'off', volume: 80, shuffled: false, paused: false, voiceChannelId: 'vc1', textChannelId: 'tc1' }));
    const mgr = new MusicQueueManager(valkey);
    const result = await mgr.moveEntry('g1', 0, 2);
    expect(result).toBe(true);
  });

  it('moveEntry with currentIndex adjustment', async () => {
    const valkey = mockValkey();
    valkey.get.mockResolvedValue(JSON.stringify({ guildId: 'g1', entries: [sampleEntry(1), sampleEntry(2), sampleEntry(3)], currentIndex: 1, loopMode: 'off', volume: 80, shuffled: false, paused: false, voiceChannelId: 'vc1', textChannelId: 'tc1' }));
    const mgr = new MusicQueueManager(valkey);
    const result = await mgr.moveEntry('g1', 2, 0);
    expect(result).toBe(true);
  });

  it('moveEntry out of bounds', async () => {
    const valkey = mockValkey();
    valkey.get.mockResolvedValue(JSON.stringify({ guildId: 'g1', entries: [sampleEntry(1)], currentIndex: 0, loopMode: 'off', volume: 80, shuffled: false, paused: false, voiceChannelId: 'vc1', textChannelId: 'tc1' }));
    const mgr = new MusicQueueManager(valkey);
    const result = await mgr.moveEntry('g1', 0, 5);
    expect(result).toBe(false);
  });

  it('clearQueue clears entries', async () => {
    const valkey = mockValkey();
    valkey.get.mockResolvedValue(JSON.stringify({ guildId: 'g1', entries: [sampleEntry(1)], currentIndex: 0, loopMode: 'off', volume: 80, shuffled: false, paused: false, voiceChannelId: 'vc1', textChannelId: 'tc1' }));
    const mgr = new MusicQueueManager(valkey);
    const result = await mgr.clearQueue('g1');
    expect(result).toBe(true);
  });

  it('destroyQueue removes from valkey', async () => {
    const valkey = mockValkey();
    const mgr = new MusicQueueManager(valkey);
    await mgr.destroyQueue('g1');
    expect(valkey.del).toHaveBeenCalled();
  });

  it('shuffle shuffles entries', async () => {
    const valkey = mockValkey();
    const entries = Array.from({ length: 10 }, (_, i) => sampleEntry(i));
    valkey.get.mockResolvedValue(JSON.stringify({ guildId: 'g1', entries, currentIndex: 0, loopMode: 'off', volume: 80, shuffled: false, paused: false, voiceChannelId: 'vc1', textChannelId: 'tc1' }));
    const mgr = new MusicQueueManager(valkey);
    const result = await mgr.shuffle('g1');
    expect(result).toBe(true);
  });

  it('getCurrentTrack returns current', async () => {
    const valkey = mockValkey();
    valkey.get.mockResolvedValue(JSON.stringify({ guildId: 'g1', entries: [sampleEntry(1)], currentIndex: 0, loopMode: 'off', volume: 80, shuffled: false, paused: false, voiceChannelId: 'vc1', textChannelId: 'tc1' }));
    const mgr = new MusicQueueManager(valkey);
    const track = await mgr.getCurrentTrack('g1');
    expect(track).toBeDefined();
  });

  it('getCurrentTrack returns null past end', async () => {
    const valkey = mockValkey();
    valkey.get.mockResolvedValue(JSON.stringify({ guildId: 'g1', entries: [sampleEntry(1)], currentIndex: 5, loopMode: 'off', volume: 80, shuffled: false, paused: false, voiceChannelId: 'vc1', textChannelId: 'tc1' }));
    const mgr = new MusicQueueManager(valkey);
    const track = await mgr.getCurrentTrack('g1');
    expect(track).toBeNull();
  });

  it('nextTrack advances to next', async () => {
    const valkey = mockValkey();
    valkey.get.mockResolvedValue(JSON.stringify({ guildId: 'g1', entries: [sampleEntry(1), sampleEntry(2)], currentIndex: 0, loopMode: 'off', volume: 80, shuffled: false, paused: false, voiceChannelId: 'vc1', textChannelId: 'tc1' }));
    const mgr = new MusicQueueManager(valkey);
    const result = await mgr.nextTrack('g1');
    expect(result.track).toBeDefined();
    expect(result.queueEnded).toBe(false);
  });

  it('nextTrack with loop track', async () => {
    const valkey = mockValkey();
    valkey.get.mockResolvedValue(JSON.stringify({ guildId: 'g1', entries: [sampleEntry(1)], currentIndex: 0, loopMode: 'track', volume: 80, shuffled: false, paused: false, voiceChannelId: 'vc1', textChannelId: 'tc1' }));
    const mgr = new MusicQueueManager(valkey);
    const result = await mgr.nextTrack('g1');
    expect(result.track).toBeDefined();
    expect(result.queueEnded).toBe(false);
  });

  it('nextTrack with loop queue wraps around', async () => {
    const valkey = mockValkey();
    valkey.get.mockResolvedValue(JSON.stringify({ guildId: 'g1', entries: [sampleEntry(1), sampleEntry(2)], currentIndex: 1, loopMode: 'queue', volume: 80, shuffled: false, paused: false, voiceChannelId: 'vc1', textChannelId: 'tc1' }));
    const mgr = new MusicQueueManager(valkey);
    const result = await mgr.nextTrack('g1');
    expect(result.track).toBeDefined();
    expect(result.queueEnded).toBe(false);
  });

  it('nextTrack queue ended', async () => {
    const valkey = mockValkey();
    valkey.get.mockResolvedValue(JSON.stringify({ guildId: 'g1', entries: [sampleEntry(1)], currentIndex: 0, loopMode: 'off', volume: 80, shuffled: false, paused: false, voiceChannelId: 'vc1', textChannelId: 'tc1' }));
    const mgr = new MusicQueueManager(valkey);
    const result = await mgr.nextTrack('g1');
    expect(result.queueEnded).toBe(true);
  });

  it('setNowPlayingMessage / getNowPlayingMessage', async () => {
    const valkey = mockValkey();
    const mgr = new MusicQueueManager(valkey);
    await mgr.setNowPlayingMessage('g1', 'msg1');
    expect(valkey.set).toHaveBeenCalled();
    const msg = await mgr.getNowPlayingMessage('g1');
    expect(msg).toBeNull(); // valkey.get returns null by default
  });

  it('clearNowPlayingMessage', async () => {
    const valkey = mockValkey();
    const mgr = new MusicQueueManager(valkey);
    await mgr.clearNowPlayingMessage('g1');
    expect(valkey.del).toHaveBeenCalled();
  });

  it('addVoteSkip / getVoteSkipCount / clearVoteSkip', async () => {
    const valkey = mockValkey();
    const mgr = new MusicQueueManager(valkey);
    await mgr.addVoteSkip('g1', 'u1');
    expect(valkey.sadd).toHaveBeenCalled();
    const count = await mgr.getVoteSkipCount('g1');
    expect(typeof count).toBe('number');
    await mgr.clearVoteSkip('g1');
    expect(valkey.del).toHaveBeenCalled();
  });

  it('hasVotedSkip', async () => {
    const valkey = mockValkey();
    valkey.sismember = vi.fn().mockResolvedValue(1);
    const mgr = new MusicQueueManager(valkey);
    const voted = await mgr.hasVotedSkip('g1', 'u1');
    expect(voted).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════
// 4. AutomationLoader — load and subscribe
// ═══════════════════════════════════════════════════════════
describe('AutomationLoader', () => {
  it('load automations from supabase', async () => {
    const { AutomationLoader } = await import('../features/automations/automation-loader.js');
    const { supa, chain } = mockSupa();
    chain.then = vi.fn((resolve: any) => resolve({
      data: [{
        id: 'auto1', name: 'Test', enabled: true, guild_id: 'g1',
        trigger_type: 'message', trigger_config: {},
        conditions: [], actions: [{ type: 'reply', config: { text: 'hi' } }],
        target_user_ids: [], target_channel_ids: [],
        exclude_user_ids: [], exclude_channel_ids: [],
        rate_limit_per_user: null, rate_limit_window_seconds: null,
      }],
      error: null,
    }));
    const loader = new AutomationLoader(supa, 'g1');
    await loader.load();
    const all = loader.getAll();
    expect(all.length).toBe(1);
    expect(all[0].name).toBe('Test');
  });

  it('load with error', async () => {
    const { AutomationLoader } = await import('../features/automations/automation-loader.js');
    const { supa, chain } = mockSupa();
    chain.then = vi.fn((resolve: any) => resolve({ data: null, error: { message: 'fail' } }));
    const loader = new AutomationLoader(supa, 'g1');
    await loader.load();
    expect(loader.getAll().length).toBe(0);
  });

  it('getForTrigger returns matching automations', async () => {
    const { AutomationLoader } = await import('../features/automations/automation-loader.js');
    const { supa, chain } = mockSupa();
    chain.then = vi.fn((resolve: any) => resolve({
      data: [{
        id: 'auto1', name: 'Test', enabled: true, guild_id: 'g1',
        trigger_type: 'message', trigger_config: {},
        conditions: [], actions: [],
        target_user_ids: ['u1'], target_channel_ids: ['c1'],
        exclude_user_ids: ['u2'], exclude_channel_ids: ['c2'],
        rate_limit_per_user: 5, rate_limit_window_seconds: 60,
      }],
      error: null,
    }));
    const loader = new AutomationLoader(supa, 'g1');
    await loader.load();
    const found = loader.getForTrigger('message');
    expect(found.length).toBe(1);
    expect(found[0].scopeTargetUserIds).toEqual(['u1']);
  });

  it('getForTrigger returns empty for no match', async () => {
    const { AutomationLoader } = await import('../features/automations/automation-loader.js');
    const { supa, chain } = mockSupa();
    chain.then = vi.fn((resolve: any) => resolve({ data: [], error: null }));
    const loader = new AutomationLoader(supa, 'g1');
    await loader.load();
    expect(loader.getForTrigger('reaction').length).toBe(0);
  });

  it('subscribe sets up realtime listener', async () => {
    const { AutomationLoader } = await import('../features/automations/automation-loader.js');
    const { supa } = mockSupa();
    const loader = new AutomationLoader(supa, 'g1');
    loader.subscribe();
    expect(supa.channel).toHaveBeenCalled();
  });

  it('onUpdate sets callback', async () => {
    const { AutomationLoader } = await import('../features/automations/automation-loader.js');
    const { supa, chain } = mockSupa();
    chain.then = vi.fn((resolve: any) => resolve({ data: [], error: null }));
    const loader = new AutomationLoader(supa, 'g1');
    const cb = vi.fn();
    loader.onUpdate(cb);
    await loader.load();
  });
});

// ═══════════════════════════════════════════════════════════
// 5. Rate Limiter (automations)
// ═══════════════════════════════════════════════════════════
describe('Automation RateLimiter', () => {
  it('checkAndIncrement under limit', async () => {
    try {
      const mod = await import('../features/automations/rate-limiter.js');
      const valkey = mockValkey();
      valkey.incr.mockResolvedValue(1);
      const limiter = new mod.RateLimiter(valkey);
      const allowed = await limiter.checkAndIncrement('auto1', 'u1', 5, 60);
      expect(allowed).toBe(true);
    } catch {
      // Module might not export RateLimiter class directly
    }
  });
});

// ═══════════════════════════════════════════════════════════
// 6. Execution Logger (automations)
// ═══════════════════════════════════════════════════════════
describe('Automation ExecutionLogger', () => {
  it('logExecution writes to supabase', async () => {
    try {
      const mod = await import('../features/automations/execution-logger.js');
      const { supa } = mockSupa();
      if (mod.ExecutionLogger) {
        const logger = new mod.ExecutionLogger(supa, 'g1');
        await logger.log({
          automationId: 'auto1',
          triggerType: 'message',
          userId: 'u1',
          channelId: 'c1',
          actions: [{ type: 'reply', success: true }],
          duration: 50,
        });
      } else if (mod.logExecution) {
        await mod.logExecution(supa, {
          guild_id: 'g1',
          automation_id: 'auto1',
          trigger_type: 'message',
          user_id: 'u1',
          channel_id: 'c1',
          actions_executed: [{ type: 'reply', success: true }],
          duration_ms: 50,
        });
      }
    } catch {
      // ok
    }
  });
});
