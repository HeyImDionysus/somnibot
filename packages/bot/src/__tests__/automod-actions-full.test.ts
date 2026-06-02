/**
 * AutoMod Actions — Full tests for executeAutoModAction
 *
 * Tests every action type: delete, warn, mute, kick, ban.
 * Verifies message deletion, infraction creation, event emission,
 * mod log posting, audit logging, escalation chain, and DM notifications.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@somnibot/shared', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('../features/moderation/infraction-service.js', () => ({
  createInfraction: vi.fn(async () => ({ id: 'inf1' })),
  getActiveWarningCount: vi.fn(async () => 2),
  calculateExpiryDate: vi.fn(() => '2026-12-31T00:00:00Z'),
}));

vi.mock('../features/moderation/escalation.js', () => ({
  executeEscalation: vi.fn(async () => {}),
}));

vi.mock('../features/moderation/mod-log.js', () => ({
  postModLogEntry: vi.fn(async () => {}),
}));

vi.mock('../services/audit.js', () => ({
  writeAuditLog: vi.fn(async () => {}),
}));

import { executeAutoModAction } from '../features/moderation/automod-actions.js';
import { createInfraction, getActiveWarningCount } from '../features/moderation/infraction-service.js';
import { executeEscalation } from '../features/moderation/escalation.js';
import { postModLogEntry } from '../features/moderation/mod-log.js';
import { writeAuditLog } from '../services/audit.js';

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
  escalationChain: [
    { threshold: 1, action: 'warn' as const, dmMember: false },
    { threshold: 3, action: 'mute' as const, durationMinutes: 60, dmMember: true },
    { threshold: 5, action: 'kick' as const, dmMember: true },
  ],
  infractionExpiryDays: 30,
  modLogChannelId: 'mod-ch',
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('executeAutoModAction — delete action', () => {
  it('deletes the message', async () => {
    const msg = makeMessage();
    const client = makeClient();
    await executeAutoModAction(client, msg, makeRule({ action: 'delete' }), 'violation', modConfig);
    expect(msg.delete).toHaveBeenCalled();
  });

  it('posts mod log when log_to_mod_channel is true', async () => {
    const msg = makeMessage();
    const client = makeClient();
    const rule = makeRule({ action: 'delete', log_to_mod_channel: true });
    await executeAutoModAction(client, msg, rule, 'violation', modConfig);
    expect(postModLogEntry).toHaveBeenCalledWith(client, expect.objectContaining({ action: 'delete' }));
  });

  it('writes audit log', async () => {
    const msg = makeMessage();
    const client = makeClient();
    await executeAutoModAction(client, msg, makeRule({ action: 'delete' }), 'violation', modConfig);
    expect(writeAuditLog).toHaveBeenCalledWith(client.supabase, expect.objectContaining({
      action: 'automod.delete',
    }));
  });

  it('handles non-deletable message gracefully', async () => {
    const msg = makeMessage({ deletable: false, delete: vi.fn() });
    const client = makeClient();
    await executeAutoModAction(client, msg, makeRule({ action: 'delete' }), 'violation', modConfig);
    expect(msg.delete).not.toHaveBeenCalled();
  });

  it('returns early if message has no member', async () => {
    const msg = makeMessage({ member: null });
    const client = makeClient();
    await executeAutoModAction(client, msg, makeRule({ action: 'delete' }), 'violation', modConfig);
    expect(writeAuditLog).not.toHaveBeenCalled();
  });
});

describe('executeAutoModAction — warn action', () => {
  it('creates infraction and emits event', async () => {
    const msg = makeMessage();
    const client = makeClient();
    await executeAutoModAction(client, msg, makeRule({ action: 'warn' }), 'violation', modConfig);
    expect(createInfraction).toHaveBeenCalledWith(client.supabase, expect.objectContaining({
      type: 'warn',
      moderatorId: 'system',
    }));
    expect(client.eventBus.emit).toHaveBeenCalledWith('infraction.created', 'g1', expect.objectContaining({
      type: 'warn',
    }));
  });

  it('does not delete message for warn action', async () => {
    const msg = makeMessage();
    const client = makeClient();
    await executeAutoModAction(client, msg, makeRule({ action: 'warn' }), 'violation', modConfig);
    expect(msg.delete).not.toHaveBeenCalled();
  });

  it('calls executeEscalation', async () => {
    const msg = makeMessage();
    const client = makeClient();
    await executeAutoModAction(client, msg, makeRule({ action: 'warn' }), 'violation', modConfig);
    expect(executeEscalation).toHaveBeenCalledWith(client, msg.member, expect.any(String), modConfig);
  });

  it('posts mod log with escalation info when log_to_mod_channel is true', async () => {
    const msg = makeMessage();
    const client = makeClient();
    const rule = makeRule({ action: 'warn', log_to_mod_channel: true });
    await executeAutoModAction(client, msg, rule, 'violation', modConfig);
    expect(postModLogEntry).toHaveBeenCalledWith(client, expect.objectContaining({
      action: 'warn',
      activeWarnings: 2,
    }));
  });
});

describe('executeAutoModAction — mute action', () => {
  it('timeouts member and creates infraction', async () => {
    const msg = makeMessage();
    const client = makeClient();
    const rule = makeRule({ action: 'mute', mute_duration_minutes: 10 });
    await executeAutoModAction(client, msg, rule, 'violation', modConfig);
    expect(msg.member.timeout).toHaveBeenCalledWith(10 * 60 * 1000, expect.any(String));
    expect(createInfraction).toHaveBeenCalledWith(client.supabase, expect.objectContaining({
      type: 'mute',
      durationMinutes: 10,
    }));
  });

  it('deletes the message first', async () => {
    const msg = makeMessage();
    const client = makeClient();
    await executeAutoModAction(client, msg, makeRule({ action: 'mute' }), 'violation', modConfig);
    expect(msg.delete).toHaveBeenCalled();
  });

  it('uses default 5min mute when mute_duration_minutes is null', async () => {
    const msg = makeMessage();
    const client = makeClient();
    const rule = makeRule({ action: 'mute', mute_duration_minutes: null });
    await executeAutoModAction(client, msg, rule, 'violation', modConfig);
    expect(msg.member.timeout).toHaveBeenCalledWith(5 * 60 * 1000, expect.any(String));
  });

  it('emits member.muted event', async () => {
    const msg = makeMessage();
    const client = makeClient();
    await executeAutoModAction(client, msg, makeRule({ action: 'mute' }), 'violation', modConfig);
    expect(client.eventBus.emit).toHaveBeenCalledWith('member.muted', 'g1', expect.objectContaining({
      discordId: 'u1',
    }));
  });
});

describe('executeAutoModAction — kick action', () => {
  it('DMs, kicks, creates infraction', async () => {
    const msg = makeMessage();
    const client = makeClient();
    await executeAutoModAction(client, msg, makeRule({ action: 'kick' }), 'violation', modConfig);
    expect(msg.member.send).toHaveBeenCalledWith(expect.stringContaining('kicked'));
    expect(msg.member.kick).toHaveBeenCalled();
    expect(createInfraction).toHaveBeenCalledWith(client.supabase, expect.objectContaining({ type: 'kick' }));
  });

  it('handles DM failure gracefully', async () => {
    const msg = makeMessage();
    msg.member.send = vi.fn(async () => { throw new Error('DMs closed'); });
    const client = makeClient();
    await expect(
      executeAutoModAction(client, msg, makeRule({ action: 'kick' }), 'violation', modConfig),
    ).resolves.not.toThrow();
    expect(msg.member.kick).toHaveBeenCalled();
  });

  it('emits member.kicked event', async () => {
    const msg = makeMessage();
    const client = makeClient();
    await executeAutoModAction(client, msg, makeRule({ action: 'kick' }), 'violation', modConfig);
    expect(client.eventBus.emit).toHaveBeenCalledWith('member.kicked', 'g1', expect.objectContaining({
      discordId: 'u1',
    }));
  });
});

describe('executeAutoModAction — ban action', () => {
  it('DMs, bans, creates infraction', async () => {
    const msg = makeMessage();
    const client = makeClient();
    await executeAutoModAction(client, msg, makeRule({ action: 'ban' }), 'violation', modConfig);
    expect(msg.member.send).toHaveBeenCalledWith(expect.stringContaining('banned'));
    expect(msg.member.ban).toHaveBeenCalledWith(expect.objectContaining({ reason: expect.any(String) }));
    expect(createInfraction).toHaveBeenCalledWith(client.supabase, expect.objectContaining({ type: 'ban' }));
  });

  it('emits member.banned event', async () => {
    const msg = makeMessage();
    const client = makeClient();
    await executeAutoModAction(client, msg, makeRule({ action: 'ban' }), 'violation', modConfig);
    expect(client.eventBus.emit).toHaveBeenCalledWith('member.banned', 'g1', expect.objectContaining({
      discordId: 'u1',
    }));
  });

  it('handles ban failure gracefully', async () => {
    const msg = makeMessage();
    msg.member.ban = vi.fn(async () => { throw new Error('Missing perms'); });
    const client = makeClient();
    await expect(
      executeAutoModAction(client, msg, makeRule({ action: 'ban' }), 'violation', modConfig),
    ).resolves.not.toThrow();
  });

  it('posts mod log when configured', async () => {
    const msg = makeMessage();
    const client = makeClient();
    const rule = makeRule({ action: 'ban', log_to_mod_channel: true });
    await executeAutoModAction(client, msg, rule, 'violation', modConfig);
    expect(postModLogEntry).toHaveBeenCalledWith(client, expect.objectContaining({ action: 'ban' }));
  });
});
