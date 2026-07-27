/**
 * AutoMod Actions — enforcement return contract (P2 batch C9).
 *
 * executeAutoModAction now reports whether it actually ENFORCED the violation.
 * Observe-mode matches (and enforce-mode branches where nothing landed) return
 * false so events/handler.ts keeps running the rest of the message pipeline
 * (automations, XP, achievements, economy, quests) — observing must never
 * silently eat member activity.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@somnibot/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@somnibot/shared')>()),
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('../features/moderation/infraction-service.js', () => ({
  createInfraction: vi.fn(async () => ({ infraction: { id: 'inf1' }, replayed: false })),
  getActiveWarningCount: vi.fn(async () => 2),
  calculateExpiryDate: vi.fn(() => '2026-12-31T00:00:00Z'),
}));

vi.mock('../features/moderation/escalation.js', () => ({
  executeEscalation: vi.fn(async () => {}),
}));

vi.mock('../features/moderation/mod-log.js', () => ({
  postModLogEntry: vi.fn(async () => {}),
}));

import { executeAutoModAction } from '../features/moderation/automod-actions.js';
import { createInfraction } from '../features/moderation/infraction-service.js';
import { executeEscalation } from '../features/moderation/escalation.js';

function makeRule(overrides: Record<string, any> = {}): any {
  return {
    id: 'rule1',
    name: 'Test Rule',
    type: 'word_filter',
    action: 'delete',
    log_to_mod_channel: false,
    mute_duration_minutes: null,
    ...overrides,
  };
}

function makeMessage(overrides: Record<string, any> = {}): any {
  return {
    id: 'msg1',
    content: 'bad content',
    guild: { id: 'g1', name: 'TestGuild' },
    member: {
      id: 'u1',
      guild: { name: 'TestGuild' },
      send: vi.fn(async () => {}),
      timeout: vi.fn(async () => {}),
      kick: vi.fn(async () => {}),
      ban: vi.fn(async () => {}),
    },
    channel: { id: 'ch1' },
    author: { id: 'u1', bot: false },
    deletable: true,
    delete: vi.fn(async () => {}),
    ...overrides,
  };
}

function makeClient(): any {
  return {
    supabase: { from: vi.fn(() => ({ insert: vi.fn(() => ({ select: vi.fn(() => ({ single: vi.fn(async () => ({ data: { id: 'inf1' }, error: null })) })) })) })) },
    eventBus: { emit: vi.fn() },
  };
}

const modConfig = {
  escalationChain: [],
  infractionExpiryDays: 30,
  modLogChannelId: 'mod-ch',
  automodEnabled: true,
  automodMode: 'enforce' as const,
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('executeAutoModAction — return contract', () => {
  it('observe mode returns false (nothing enforced) even for a ban rule', async () => {
    const observeConfig = { ...modConfig, automodMode: 'observe' as const };
    const msg = makeMessage();
    const enforced = await executeAutoModAction(makeClient(), msg, makeRule({ action: 'ban' }), 'violation', observeConfig);
    expect(enforced).toBe(false);
    expect(msg.delete).not.toHaveBeenCalled();
    expect(msg.member.ban).not.toHaveBeenCalled();
  });

  it('enforce mode delete returns true', async () => {
    const msg = makeMessage();
    const enforced = await executeAutoModAction(makeClient(), msg, makeRule({ action: 'delete' }), 'violation', modConfig);
    expect(enforced).toBe(true);
    expect(msg.delete).toHaveBeenCalledTimes(1);
  });

  it('enforce mode mute returns true', async () => {
    const msg = makeMessage();
    const enforced = await executeAutoModAction(makeClient(), msg, makeRule({ action: 'mute', mute_duration_minutes: 10 }), 'violation', modConfig);
    expect(enforced).toBe(true);
    expect(msg.member.timeout).toHaveBeenCalledTimes(1);
  });

  it('enforce mode warn returns true when the infraction persists', async () => {
    const msg = makeMessage();
    const enforced = await executeAutoModAction(makeClient(), msg, makeRule({ action: 'warn' }), 'violation', modConfig);
    expect(enforced).toBe(true);
  });

  it('warn whose infraction failed to persist returns false and skips escalation', async () => {
    vi.mocked(createInfraction).mockResolvedValueOnce(null as any);
    const msg = makeMessage();
    const enforced = await executeAutoModAction(makeClient(), msg, makeRule({ action: 'warn' }), 'violation', modConfig);
    // Nothing landed ('warn' never deletes, and no infraction row exists) —
    // the message pipeline must keep running.
    expect(enforced).toBe(false);
    expect(executeEscalation).not.toHaveBeenCalled();
  });

  it('returns false when the member is missing', async () => {
    const msg = makeMessage({ member: null });
    const enforced = await executeAutoModAction(makeClient(), msg, makeRule(), 'violation', modConfig);
    expect(enforced).toBe(false);
  });
});
