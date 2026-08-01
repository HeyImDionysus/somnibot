/**
 * Tests for features/automations/automation-engine.ts — rule-based
 * automation that triggers actions on Discord events.
 * 259 uncovered statements.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@somnibot/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@somnibot/shared')>()),
  createLogger: () => ({
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
  }),
}));

vi.mock('discord.js', () => ({
  EmbedBuilder: class {
    // Real EmbedBuilder always exposes `data` (branded embeds read
    // data.footer to append attribution without clobbering it).
    data: Record<string, unknown> = {};
    setColor() { return this; } setTitle() { return this; }
    setDescription() { return this; } addFields() { return this; }
  },
  Collection: class extends Map {},
}));

vi.mock('../features/automations/automation-loader.js', () => ({
  AutomationLoader: class {
    load = vi.fn(async () => {});
    subscribe = vi.fn();
    unsubscribe = vi.fn();
    getForTrigger = vi.fn(() => []);
    getAll = vi.fn(() => []);
  },
}));
vi.mock('../features/automations/rate-limiter.js', () => ({
  AutomationRateLimiter: class {
    allowFire = vi.fn(async () => true);
    allowCustom = vi.fn(async () => true);
    isRateLimited = vi.fn(async () => false);
    recordExecution = vi.fn(async () => {});
  },
}));
vi.mock('../features/automations/execution-logger.js', () => ({
  ExecutionLogger: class {
    log = vi.fn(async () => {});
      markActionsStarted = vi.fn(async () => undefined);
    finalizeStrict = vi.fn(async () => undefined);
    finalizeStaleStartedSweep = vi.fn(async () => 0);
  },
}));
vi.mock('../services/alert-service.js', () => ({
  AlertService: class {
    send = vi.fn();
  },
}));
vi.mock('../features/automations/mass-action-hold.js', () => ({
  MassActionHoldService: class {
    subscribe = vi.fn();
    unsubscribe = vi.fn();
    listHeldNeedingNotice = vi.fn(async () => []);
    listApproved = vi.fn(async () => []);
    failInterruptedExecutions = vi.fn(async () => {});
    threshold = vi.fn(async () => 25);
    claimApproved = vi.fn(async () => null);
  },
}));

import { AutomationEngine } from '../features/automations/automation-engine.js';

function makeGuild() {
  return {
    id: 'guild-1', name: 'Test',
    channels: { cache: new Map() },
    members: { fetch: vi.fn(), cache: new Map() },
  } as any;
}

function makeValkey() {
  return {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue('OK'),
    setex: vi.fn().mockResolvedValue('OK'),
    del: vi.fn().mockResolvedValue(1),
    exists: vi.fn().mockResolvedValue(0),
  } as any;
}

function makeSupa() {
  const chain: any = {};
  for (const m of ['from', 'select', 'insert', 'update', 'delete', 'eq', 'order', 'limit', 'single', 'maybeSingle']) {
    chain[m] = vi.fn(() => chain);
  }
  chain.then = (resolve: Function) => resolve({ data: null, error: null });
  return {
    from: vi.fn(() => chain),
    rpc: vi.fn(async () => ({ data: null, error: null })),
  };
}

describe('AutomationEngine', () => {
  let engine: AutomationEngine;
  let eventBus: any;

  beforeEach(() => {
    vi.clearAllMocks();
    eventBus = { on: vi.fn(), off: vi.fn(), emit: vi.fn(), onAny: vi.fn(), offAny: vi.fn() };
    engine = new AutomationEngine(makeGuild(), makeSupa() as any, makeValkey(), eventBus);
  });

  describe('start', () => {
    it('loads automation rules and subscribes to events', async () => {
      await engine.start();
      // Should register an event handler via onAny
      expect(eventBus.onAny).toHaveBeenCalled();
    });
  });

  describe('setAlertService', () => {
    it('accepts an alert service', () => {
      engine.setAlertService({ send: vi.fn() } as any);
      // Should not throw
      expect(engine).toBeDefined();
    });

    it('has required methods', () => {
      expect(typeof engine.start).toBe('function');
      expect(typeof engine.setAlertService).toBe('function');
    });
  });
});
