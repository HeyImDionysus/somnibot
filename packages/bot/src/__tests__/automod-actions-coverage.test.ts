/**
 * automod-actions — coverage tests for executeAutoModAction
 *
 * Tests all action types: delete, warn, mute, kick, ban
 * and edge cases like DM failures, non-deletable messages.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('discord.js', () => ({}));
vi.mock('@somnibot/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@somnibot/shared')>()),
  createLogger: () => ({
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
  }),
}));

const mockCreateInfraction = vi.fn().mockResolvedValue({ infraction: { id: 'inf1' }, replayed: false });
const mockGetActiveWarningCount = vi.fn().mockResolvedValue(2);
const mockCalculateExpiryDate = vi.fn().mockReturnValue('2026-12-31');
vi.mock('../features/moderation/infraction-service.js', () => ({
  createInfraction: (...args: unknown[]) => mockCreateInfraction(...args),
  getActiveWarningCount: (...args: unknown[]) => mockGetActiveWarningCount(...args),
  calculateExpiryDate: (...args: unknown[]) => mockCalculateExpiryDate(...args),
}));

const mockExecuteEscalation = vi.fn().mockResolvedValue(undefined);
vi.mock('../features/moderation/escalation.js', () => ({
  executeEscalation: (...args: unknown[]) => mockExecuteEscalation(...args),
}));

const mockPostModLogEntry = vi.fn().mockResolvedValue(undefined);
vi.mock('../features/moderation/mod-log.js', () => ({
  postModLogEntry: (...args: unknown[]) => mockPostModLogEntry(...args),
}));

const mockWriteAuditLog = vi.fn().mockResolvedValue(undefined);
vi.mock('../services/audit.js', () => ({
  writeAuditLog: (...args: unknown[]) => mockWriteAuditLog(...args),
}));

import { executeAutoModAction } from '../features/moderation/automod-actions.js';

// ── Helpers ───────────────────────────────────────────────

function makeClient() {
  return {
    supabase: { from: vi.fn() },
    eventBus: { emit: vi.fn() },
  };
}

function makeMember(overrides: Record<string, unknown> = {}) {
  return {
    id: 'u1',
    guild: { id: 'g1', name: 'TestGuild' },
    timeout: vi.fn().mockResolvedValue(undefined),
    kick: vi.fn().mockResolvedValue(undefined),
    ban: vi.fn().mockResolvedValue(undefined),
    send: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function makeMessage(memberObj = makeMember()) {
  return {
    id: 'msg1',
    member: memberObj,
    guild: memberObj.guild,
    channel: { id: 'ch1' },
    deletable: true,
    delete: vi.fn().mockResolvedValue(undefined),
  };
}

function makeRule(overrides: Record<string, unknown> = {}) {
  return {
    id: 'rule1',
    name: 'TestRule',
    type: 'word_filter',
    action: 'delete' as string,
    log_to_mod_channel: true,
    mute_duration_minutes: null as number | null,
    ...overrides,
  };
}

const defaultModConfig = {
  escalationChain: [] as any[],
  infractionExpiryDays: 30,
  modLogChannelId: 'mod-ch',
  automodEnabled: true,
  automodMode: 'enforce' as const, // these tests assert enforcement
};

describe('executeAutoModAction', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockCreateInfraction.mockResolvedValue({
      infraction: { id: 'inf1' },
      replayed: false,
    });
    mockGetActiveWarningCount.mockResolvedValue(2);
    mockCalculateExpiryDate.mockReturnValue('2026-12-31');
    mockExecuteEscalation.mockResolvedValue(undefined);
    mockPostModLogEntry.mockResolvedValue(undefined);
    mockWriteAuditLog.mockResolvedValue(undefined);
  });

  it('returns early when no member', async () => {
    const client = makeClient();
    const msg = makeMessage();
    (msg as any).member = null;
    await executeAutoModAction(client as any, msg as any, makeRule() as any, 'bad word', defaultModConfig as any);
    expect(msg.delete).not.toHaveBeenCalled();
  });

  // ── DELETE action ──────────────────────────────────────

  describe('delete action', () => {
    it('deletes message and logs', async () => {
      const client = makeClient();
      const msg = makeMessage();
      const rule = makeRule({ action: 'delete' });
      await executeAutoModAction(client as any, msg as any, rule as any, 'spam', defaultModConfig as any);
      expect(msg.delete).toHaveBeenCalled();
      expect(mockPostModLogEntry).toHaveBeenCalled();
      expect(client.eventBus.emit).toHaveBeenCalledWith('automod.enforced', 'g1', expect.anything());
    });

    it('handles non-deletable message', async () => {
      const client = makeClient();
      const msg = makeMessage();
      msg.deletable = false;
      const rule = makeRule({ action: 'delete' });
      await executeAutoModAction(client as any, msg as any, rule as any, 'spam', defaultModConfig as any);
      expect(msg.delete).not.toHaveBeenCalled();
    });

    it('skips mod log when log_to_mod_channel is false', async () => {
      const client = makeClient();
      const msg = makeMessage();
      const rule = makeRule({ action: 'delete', log_to_mod_channel: false });
      await executeAutoModAction(client as any, msg as any, rule as any, 'spam', defaultModConfig as any);
      expect(mockPostModLogEntry).not.toHaveBeenCalled();
    });

    it('catches delete error gracefully', async () => {
      const client = makeClient();
      const msg = makeMessage();
      msg.delete.mockRejectedValue(new Error('Discord error'));
      const rule = makeRule({ action: 'delete' });
      await executeAutoModAction(client as any, msg as any, rule as any, 'spam', defaultModConfig as any);
      // Should not throw
      expect(client.eventBus.emit).toHaveBeenCalledWith('automod.enforced', 'g1', expect.anything());
    });
  });

  // ── WARN action ────────────────────────────────────────

  describe('warn action', () => {
    it('creates infraction and emits event', async () => {
      const client = makeClient();
      const msg = makeMessage();
      const rule = makeRule({ action: 'warn' });
      await executeAutoModAction(client as any, msg as any, rule as any, 'bad word', defaultModConfig as any);
      expect(mockCreateInfraction).toHaveBeenCalled();
      expect(client.eventBus.emit).toHaveBeenCalledWith(
        'infraction.created',
        'g1',
        expect.objectContaining({ type: 'warn' }),
      );
    });

    it('does not delete message for warn action', async () => {
      const client = makeClient();
      const msg = makeMessage();
      const rule = makeRule({ action: 'warn' });
      await executeAutoModAction(client as any, msg as any, rule as any, 'bad word', defaultModConfig as any);
      // For 'warn', the initial delete is skipped (rule.action === 'warn')
      expect(msg.delete).not.toHaveBeenCalled();
    });

    it('calls executeEscalation', async () => {
      const client = makeClient();
      const msg = makeMessage();
      const rule = makeRule({ action: 'warn' });
      await executeAutoModAction(client as any, msg as any, rule as any, 'bad word', defaultModConfig as any);
      expect(mockExecuteEscalation).toHaveBeenCalled();
    });

    it('includes next escalation info in mod log', async () => {
      const client = makeClient();
      const msg = makeMessage();
      const rule = makeRule({ action: 'warn' });
      const modConfig = {
        ...defaultModConfig,
        escalationChain: [
          { threshold: 3, action: 'mute' as const, durationMinutes: 60, dmMember: true },
          { threshold: 5, action: 'ban' as const, dmMember: true },
        ],
      };
      mockGetActiveWarningCount.mockResolvedValue(2);
      await executeAutoModAction(client as any, msg as any, rule as any, 'bad word', modConfig as any);
      expect(mockPostModLogEntry).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ nextEscalation: expect.stringContaining('Mute') }),
      );
    });

    it('null next escalation when past all thresholds', async () => {
      const client = makeClient();
      const msg = makeMessage();
      const rule = makeRule({ action: 'warn' });
      const modConfig = {
        ...defaultModConfig,
        escalationChain: [{ threshold: 1, action: 'kick' as const, dmMember: true }],
      };
      mockGetActiveWarningCount.mockResolvedValue(10);
      await executeAutoModAction(client as any, msg as any, rule as any, 'bad word', modConfig as any);
      expect(mockPostModLogEntry).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ nextEscalation: null }),
      );
    });

    it('logs audit with infraction details (rail A)', async () => {
      const client = makeClient();
      const msg = makeMessage();
      const rule = makeRule({ action: 'warn' });
      await executeAutoModAction(client as any, msg as any, rule as any, 'bad word', defaultModConfig as any);
      expect(client.eventBus.emit).toHaveBeenCalledWith(
        'automod.enforced',
        'g1',
        expect.objectContaining({ action: 'warn', infractionId: 'inf1' }),
      );
      // The migration removed automod's last direct-rail write.
      expect(mockWriteAuditLog).not.toHaveBeenCalled();
    });
  });

  // ── MUTE action ────────────────────────────────────────

  describe('mute action', () => {
    it('times out member and creates infraction', async () => {
      const client = makeClient();
      const member = makeMember();
      const msg = makeMessage(member);
      const rule = makeRule({ action: 'mute', mute_duration_minutes: 10 });
      await executeAutoModAction(client as any, msg as any, rule as any, 'spam', defaultModConfig as any);
      expect(member.timeout).toHaveBeenCalledWith(600_000, expect.stringContaining('Auto-Mod'));
      expect(mockCreateInfraction).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ type: 'mute', durationMinutes: 10 }),
      );
    });

    it('uses default 5 min when no mute_duration', async () => {
      const client = makeClient();
      const member = makeMember();
      const msg = makeMessage(member);
      const rule = makeRule({ action: 'mute', mute_duration_minutes: null });
      await executeAutoModAction(client as any, msg as any, rule as any, 'spam', defaultModConfig as any);
      expect(member.timeout).toHaveBeenCalledWith(300_000, expect.any(String));
    });

    it('emits member.muted event', async () => {
      const client = makeClient();
      const msg = makeMessage();
      const rule = makeRule({ action: 'mute' });
      await executeAutoModAction(client as any, msg as any, rule as any, 'spam', defaultModConfig as any);
      expect(client.eventBus.emit).toHaveBeenCalledWith(
        'member.muted',
        'g1',
        expect.objectContaining({ discordId: 'u1' }),
      );
    });

    it('catches timeout error', async () => {
      const client = makeClient();
      const member = makeMember({ timeout: vi.fn().mockRejectedValue(new Error('no perms')) });
      const msg = makeMessage(member);
      const rule = makeRule({ action: 'mute' });
      await executeAutoModAction(client as any, msg as any, rule as any, 'spam', defaultModConfig as any);
      expect(client.eventBus.emit).toHaveBeenCalledWith('automod.enforced', 'g1', expect.anything()); // doesn't throw
    });

    it('deletes message before muting', async () => {
      const client = makeClient();
      const msg = makeMessage();
      const rule = makeRule({ action: 'mute' });
      await executeAutoModAction(client as any, msg as any, rule as any, 'spam', defaultModConfig as any);
      expect(msg.delete).toHaveBeenCalled();
    });
  });

  // ── KICK action ────────────────────────────────────────

  describe('kick action', () => {
    it('DMs member, kicks, creates infraction', async () => {
      const client = makeClient();
      const member = makeMember();
      const msg = makeMessage(member);
      const rule = makeRule({ action: 'kick' });
      await executeAutoModAction(client as any, msg as any, rule as any, 'bad', defaultModConfig as any);
      expect(member.send).toHaveBeenCalledWith(expect.stringContaining('kicked'));
      expect(member.kick).toHaveBeenCalled();
      expect(mockCreateInfraction).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ type: 'kick' }),
      );
    });

    it('emits member.kicked event', async () => {
      const client = makeClient();
      const msg = makeMessage();
      const rule = makeRule({ action: 'kick' });
      await executeAutoModAction(client as any, msg as any, rule as any, 'bad', defaultModConfig as any);
      expect(client.eventBus.emit).toHaveBeenCalledWith(
        'member.kicked',
        'g1',
        expect.objectContaining({ discordId: 'u1' }),
      );
    });

    it('handles DM failure gracefully', async () => {
      const client = makeClient();
      const member = makeMember({ send: vi.fn().mockRejectedValue(new Error('DMs off')) });
      const msg = makeMessage(member);
      const rule = makeRule({ action: 'kick' });
      await executeAutoModAction(client as any, msg as any, rule as any, 'bad', defaultModConfig as any);
      expect(member.kick).toHaveBeenCalled(); // still kicks
    });

    it('handles kick failure', async () => {
      const client = makeClient();
      const member = makeMember({ kick: vi.fn().mockRejectedValue(new Error('no perms')) });
      const msg = makeMessage(member);
      const rule = makeRule({ action: 'kick' });
      await executeAutoModAction(client as any, msg as any, rule as any, 'bad', defaultModConfig as any);
      expect(client.eventBus.emit).toHaveBeenCalledWith('automod.enforced', 'g1', expect.anything()); // doesn't throw
    });
  });

  // ── BAN action ─────────────────────────────────────────

  describe('ban action', () => {
    it('DMs member, bans, creates infraction', async () => {
      const client = makeClient();
      const member = makeMember();
      const msg = makeMessage(member);
      const rule = makeRule({ action: 'ban' });
      await executeAutoModAction(client as any, msg as any, rule as any, 'bad', defaultModConfig as any);
      expect(member.send).toHaveBeenCalledWith(expect.stringContaining('banned'));
      expect(member.ban).toHaveBeenCalledWith(expect.objectContaining({ reason: expect.any(String) }));
      expect(mockCreateInfraction).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ type: 'ban' }),
      );
    });

    it('emits member.banned event', async () => {
      const client = makeClient();
      const msg = makeMessage();
      const rule = makeRule({ action: 'ban' });
      await executeAutoModAction(client as any, msg as any, rule as any, 'bad', defaultModConfig as any);
      expect(client.eventBus.emit).toHaveBeenCalledWith(
        'member.banned',
        'g1',
        expect.objectContaining({ discordId: 'u1' }),
      );
    });

    it('handles DM failure gracefully for ban', async () => {
      const client = makeClient();
      const member = makeMember({ send: vi.fn().mockRejectedValue(new Error('blocked')) });
      const msg = makeMessage(member);
      const rule = makeRule({ action: 'ban' });
      await executeAutoModAction(client as any, msg as any, rule as any, 'bad', defaultModConfig as any);
      expect(member.ban).toHaveBeenCalled();
    });

    it('handles ban failure', async () => {
      const client = makeClient();
      const member = makeMember({ ban: vi.fn().mockRejectedValue(new Error('no perms')) });
      const msg = makeMessage(member);
      const rule = makeRule({ action: 'ban' });
      await executeAutoModAction(client as any, msg as any, rule as any, 'bad', defaultModConfig as any);
      expect(client.eventBus.emit).toHaveBeenCalledWith('automod.enforced', 'g1', expect.anything());
    });

    it('deletes message before banning', async () => {
      const client = makeClient();
      const msg = makeMessage();
      const rule = makeRule({ action: 'ban' });
      await executeAutoModAction(client as any, msg as any, rule as any, 'bad', defaultModConfig as any);
      expect(msg.delete).toHaveBeenCalled();
    });
  });
});
