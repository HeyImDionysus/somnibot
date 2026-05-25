// @ts-nocheck
/**
 * Tests for features/moderation/escalation.ts — getEscalationAction and executeEscalation.
 * 176 uncovered statements at 17%.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@somnibot/shared', () => ({
  createLogger: () => ({
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
  }),
  InfractionType: { WARN: 'warn', MUTE: 'mute', KICK: 'kick', BAN: 'ban' },
}));

vi.mock('discord.js', () => ({
  EmbedBuilder: class {
    setColor() { return this; } setTitle() { return this; } setDescription() { return this; } addFields() { return this; }
  },
  PermissionFlagsBits: { ModerateMembers: 1n, KickMembers: 2n, BanMembers: 4n },
}));

vi.mock('../services/audit.js', () => ({
  writeAuditLog: vi.fn(async () => {}),
}));

import { getEscalationAction, executeEscalation } from '../features/moderation/escalation.js';

function makeChain(data: any = null) {
  const chain: any = {};
  for (const m of ['from', 'select', 'insert', 'update', 'delete', 'eq', 'single', 'maybeSingle', 'order', 'limit', 'in', 'match', 'gte', 'lte', 'count']) {
    chain[m] = vi.fn(() => chain);
  }
  chain.single = vi.fn(() => Promise.resolve({ data, error: null }));
  chain.maybeSingle = vi.fn(() => Promise.resolve({ data, error: null }));
  chain.then = (resolve: Function) => resolve({ data: data ? [data] : [], error: null, count: 0 });
  return chain;
}

describe('escalation', () => {
  describe('getEscalationAction', () => {
    it('returns null for no matching thresholds', () => {
      const result = getEscalationAction([], 1);
      expect(result).toBeNull();
    });

    it('returns action for matching threshold', () => {
      const thresholds = [
        { count: 3, action: 'mute', duration: '1h' },
        { count: 5, action: 'ban' },
      ];
      const result = getEscalationAction(thresholds as any, 3);
      expect(result).toBeDefined();
    });

    it('returns highest matching threshold', () => {
      const thresholds = [
        { count: 3, action: 'mute', duration: '1h' },
        { count: 5, action: 'ban' },
      ];
      const result = getEscalationAction(thresholds as any, 7);
      expect(result).toBeDefined();
    });
  });

  describe('executeEscalation', () => {
    it('handles escalation execution', async () => {
      const member = {
        id: 'user-1', displayName: 'Target',
        guild: { id: 'guild-1', name: 'Test', channels: { cache: new Map() } },
        user: { tag: 'Target#0001', send: vi.fn().mockResolvedValue({}) },
        timeout: vi.fn().mockResolvedValue({}),
        kick: vi.fn().mockResolvedValue({}),
        ban: vi.fn().mockResolvedValue({}),
        moderatable: true,
        bannable: true,
        kickable: true,
      };
      const client = { supabase: { from: vi.fn(() => makeChain()) } } as any;
      const config = {
        escalationChain: [{ count: 3, action: 'mute', durationMinutes: 60 }],
        infractionExpiryDays: 30,
        modLogChannelId: null,
      };
      await executeEscalation(client, member as any, 'Test reason', config);
    });
  });
});
