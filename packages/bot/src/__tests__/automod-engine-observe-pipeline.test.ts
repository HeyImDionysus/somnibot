/**
 * AutoMod Engine — observe mode must not suppress the message pipeline
 * (P2 batch C9).
 *
 * processMessage returns what the action layer reports: true only when a
 * violation was actually ENFORCED. Observe-mode matches return false so
 * events/handler.ts keeps running automations, XP, achievements, economy and
 * quest tracking. The idempotency fence mirrors the same contract on gateway
 * replays: it still dedupes the action layer, but only suppresses the
 * pipeline in enforce mode.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@somnibot/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@somnibot/shared')>()),
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

// NOTE: specifier resolves to the module the engine actually imports.
vi.mock('../features/moderation/automod-actions.js', () => ({
  executeAutoModAction: vi.fn(
    async (_client: unknown, _msg: unknown, _rule: unknown, _violation: unknown, cfg: { automodMode: string }) =>
      cfg.automodMode === 'enforce',
  ),
}));

import { processMessage } from '../features/moderation/automod-engine.js';
import { executeAutoModAction } from '../features/moderation/automod-actions.js';
import { MockCollection } from './helpers/discord-mocks.js';

function mockValkey(overrides: Record<string, any> = {}) {
  return {
    get: vi.fn(async () => null),
    set: vi.fn(async () => 'OK'),
    setex: vi.fn(async () => 'OK'),
    del: vi.fn(async () => 1),
    incr: vi.fn(async () => 1),
    expire: vi.fn(async () => 1),
    scan: vi.fn(async () => ['0', []]),
    ...overrides,
  } as any;
}

function supaChain(data: any[] = []) {
  const c: any = {};
  const methods = ['select', 'eq', 'neq', 'gte', 'lt', 'lte', 'limit', 'order', 'in', 'head'];
  for (const m of methods) c[m] = vi.fn((..._: any[]) => c);
  c.then = (resolve: any) => resolve({ data, error: null });
  return c;
}

function makeRule(overrides: Record<string, any> = {}): any {
  return {
    id: 'rule1',
    name: 'Test Rule',
    type: 'word_filter',
    enabled: true,
    action: 'delete',
    config: { words: ['badword'], matchMode: 'exact', caseSensitive: false },
    exempt_channels: [],
    exempt_roles: [],
    log_to_mod_channel: false,
    mute_duration_minutes: null,
    ...overrides,
  };
}

function makeMessage(content: string, overrides: Record<string, any> = {}): any {
  return {
    content,
    guild: { id: 'g1' },
    member: {
      id: 'u1',
      roles: { cache: new MockCollection() },
      permissions: { has: vi.fn(() => false) },
    },
    author: { id: 'u1', bot: false },
    channel: { id: 'ch1' },
    id: 'msg1',
    deletable: true,
    delete: vi.fn(async () => {}),
    mentions: { users: new MockCollection(), roles: new MockCollection() },
    ...overrides,
  };
}

function makeClient(rules: any[] = [], valkeyOverrides: Record<string, any> = {}): any {
  return {
    supabase: { from: vi.fn(() => supaChain(rules)) },
    valkey: mockValkey(valkeyOverrides),
    eventBus: { emit: vi.fn() },
    fetchInvite: vi.fn(async () => ({ guild: { id: 'g1' } })),
  };
}

const baseConfig = {
  escalationChain: [],
  infractionExpiryDays: 30,
  modLogChannelId: null,
  automodEnabled: true,
};
const observeConfig = { ...baseConfig, automodMode: 'observe' as const };
const enforceConfig = { ...baseConfig, automodMode: 'enforce' as const };

beforeEach(() => {
  vi.clearAllMocks();
});

describe('processMessage — observe mode keeps the pipeline alive', () => {
  it('an observe-mode match runs the action layer but returns false', async () => {
    const client = makeClient([makeRule()]);
    const msg = makeMessage('badword');
    const enforced = await processMessage(client, msg, observeConfig);
    expect(enforced).toBe(false); // handler must NOT early-return
    expect(executeAutoModAction).toHaveBeenCalledTimes(1);
  });

  it('an enforce-mode match returns true (pipeline suppressed)', async () => {
    const client = makeClient([makeRule()]);
    const msg = makeMessage('badword');
    const enforced = await processMessage(client, msg, enforceConfig);
    expect(enforced).toBe(true);
    expect(executeAutoModAction).toHaveBeenCalledTimes(1);
  });

  it('a clean message returns false without touching the action layer', async () => {
    const client = makeClient([makeRule()]);
    const msg = makeMessage('perfectly fine message');
    expect(await processMessage(client, msg, observeConfig)).toBe(false);
    expect(executeAutoModAction).not.toHaveBeenCalled();
  });
});

describe('processMessage — idempotency fence mirrors the mode', () => {
  it('an observe-mode replay dedupes the action layer but still returns false', async () => {
    const setMock = vi.fn().mockResolvedValueOnce('OK').mockResolvedValueOnce(null);
    const client = makeClient([makeRule()], { set: setMock });
    const msg = makeMessage('badword');

    const first = await processMessage(client, msg, observeConfig);
    const second = await processMessage(client, msg, observeConfig);

    expect(first).toBe(false);
    expect(second).toBe(false); // replay must not eat the pipeline either
    // The observe log entry fired exactly once across the two deliveries.
    expect(executeAutoModAction).toHaveBeenCalledTimes(1);
  });

  it('an enforce-mode replay stays suppressed (returns true) without re-enforcing', async () => {
    const setMock = vi.fn().mockResolvedValueOnce('OK').mockResolvedValueOnce(null);
    const client = makeClient([makeRule()], { set: setMock });
    const msg = makeMessage('badword');

    const first = await processMessage(client, msg, enforceConfig);
    const second = await processMessage(client, msg, enforceConfig);

    expect(first).toBe(true);
    expect(second).toBe(true); // handled — but not enforced a second time
    expect(executeAutoModAction).toHaveBeenCalledTimes(1);
  });
});
