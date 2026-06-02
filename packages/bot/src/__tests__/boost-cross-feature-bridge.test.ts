/**
 * Tests for services/cross-feature-bridge.ts — wires feature events
 * together (economy transactions trigger quest progress, level-ups
 * trigger achievement checks, etc.)
 * 248 uncovered statements.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@somnibot/shared', () => ({
  createLogger: () => ({
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
  }),
}));

vi.mock('discord.js', () => ({
  Collection: class extends Map {},
  EmbedBuilder: class {
    setColor() { return this; } setTitle() { return this; }
    setDescription() { return this; } addFields() { return this; }
  },
}));

vi.mock('../services/audit.js', () => ({
  writeAuditLog: vi.fn(async () => {}),
}));

// Mock all features the bridge wires together
vi.mock('../features/economy/index.js', () => ({}));
vi.mock('../features/levels/index.js', () => ({}));
vi.mock('../features/quests/index.js', () => ({}));
vi.mock('../features/achievements/index.js', () => ({}));
vi.mock('../features/pets/index.js', () => ({}));
vi.mock('../features/adventures/index.js', () => ({}));
vi.mock('../features/commerce/index.js', () => ({}));

import { CrossFeatureBridge } from '../services/cross-feature-bridge.js';

function makeGuild() {
  return {
    id: 'guild-1', name: 'Test',
    channels: {
      cache: new Map([['ch-1', { id: 'ch-1', send: vi.fn().mockResolvedValue({}) }]]),
    },
    members: {
      fetch: vi.fn().mockResolvedValue({
        id: 'user-1', displayName: 'Tester',
        roles: { add: vi.fn(), remove: vi.fn(), cache: new Map() },
        user: { send: vi.fn() },
      }),
    },
  } as any;
}

function makeSupa() {
  const chain: any = {};
  for (const m of ['from', 'select', 'insert', 'update', 'delete', 'upsert', 'eq', 'order', 'limit', 'single', 'maybeSingle', 'in', 'gt', 'gte']) {
    chain[m] = vi.fn(() => chain);
  }
  chain.then = (resolve: Function) => resolve({ data: null, error: null });
  chain.single = vi.fn(() => Promise.resolve({ data: null, error: null }));
  return {
    from: vi.fn(() => chain),
    rpc: vi.fn(async () => ({ data: null, error: null })),
  };
}

function makeValkey() {
  return {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue('OK'),
    setex: vi.fn().mockResolvedValue('OK'),
    del: vi.fn().mockResolvedValue(1),
    incr: vi.fn().mockResolvedValue(1),
    expire: vi.fn().mockResolvedValue(1),
  } as any;
}

describe('CrossFeatureBridge', () => {
  let bridge: CrossFeatureBridge;
  let eventBus: any;

  beforeEach(() => {
    vi.clearAllMocks();
    eventBus = {
      on: vi.fn(),
      off: vi.fn(),
      emit: vi.fn(),
    };
    bridge = new CrossFeatureBridge(makeGuild(), makeSupa() as any, eventBus, makeValkey());
  });

  it('registers event listeners on start()', () => {
    bridge.start();
    expect(eventBus.on).toHaveBeenCalled();
    expect(eventBus.on.mock.calls.length).toBeGreaterThan(0);
  });

  it('unregisters event listeners on stop()', () => {
    bridge.start();
    bridge.stop();
    expect(eventBus.off).toHaveBeenCalled();
  });

  it('can start and stop multiple times without errors', () => {
    bridge.start();
    bridge.stop();
    bridge.start();
    bridge.stop();
      expect(bridge).toBeDefined(); // start/stop lifecycle completed
  });
});
