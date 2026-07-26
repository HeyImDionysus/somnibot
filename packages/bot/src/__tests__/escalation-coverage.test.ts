/**
 * escalation — coverage tests
 *
 * Tests getEscalationAction and executeEscalation with REAL imports.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@somnibot/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@somnibot/shared')>()),
  createLogger: () => ({
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
  }),
  DEFAULT_ESCALATION_CHAIN: [
    { threshold: 3, action: 'mute', durationMinutes: 60, dmMember: true },
    { threshold: 5, action: 'kick', durationMinutes: undefined, dmMember: true },
    { threshold: 6, action: 'ban', durationMinutes: undefined, dmMember: true },
  ],
}));

const mockCreateInfraction = vi.fn().mockResolvedValue(undefined);
const mockGetActiveWarningCount = vi.fn().mockResolvedValue(0);
const mockGetActiveInfractionCount = vi.fn().mockResolvedValue(0);
const mockCalculateExpiryDate = vi.fn().mockReturnValue('2026-12-31T00:00:00Z');
vi.mock('../features/moderation/infraction-service.js', () => ({
  createInfraction: (...args: unknown[]) => mockCreateInfraction(...args),
  getActiveWarningCount: (...args: unknown[]) => mockGetActiveWarningCount(...args),
  getActiveInfractionCount: (...args: unknown[]) => mockGetActiveInfractionCount(...args),
  calculateExpiryDate: (...args: unknown[]) => mockCalculateExpiryDate(...args),
}));

const mockPostModLogEntry = vi.fn().mockResolvedValue(undefined);
vi.mock('../features/moderation/mod-log.js', () => ({
  postModLogEntry: (...args: unknown[]) => mockPostModLogEntry(...args),
}));

const mockWriteAuditLog = vi.fn().mockResolvedValue(undefined);
vi.mock('../../services/audit.js', () => ({
  writeAuditLog: (...args: unknown[]) => mockWriteAuditLog(...args),
}));
// Also mock with correct path
vi.mock('../services/audit.js', () => ({
  writeAuditLog: (...args: unknown[]) => mockWriteAuditLog(...args),
}));

import { getEscalationAction, executeEscalation } from '../features/moderation/escalation.js';

// ── Helpers ───────────────────────────────────────────────

function makeMember() {
  return {
    id: 'u1',
    user: { tag: 'TestUser#1234' },
    guild: { id: 'g1', name: 'TestGuild' },
    timeout: vi.fn().mockResolvedValue(undefined),
    kick: vi.fn().mockResolvedValue(undefined),
    ban: vi.fn().mockResolvedValue(undefined),
    send: vi.fn().mockResolvedValue(undefined),
  };
}

function makeClient() {
  return {
    supabase: {
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        update: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        maybeSingle: vi.fn().mockResolvedValue({ data: null }),
        then: (res: Function) => Promise.resolve({ data: null }).then(res as any),
      }),
    },
    user: { id: 'bot1' },
    eventBus: { emit: vi.fn() },
  };
}

const CHAIN = [
  { threshold: 1, action: 'warn' as const, durationMinutes: undefined, dmMember: false },
  { threshold: 3, action: 'mute' as const, durationMinutes: 60, dmMember: true },
  { threshold: 4, action: 'mute' as const, durationMinutes: 1440, dmMember: true },
  { threshold: 5, action: 'kick' as const, durationMinutes: undefined, dmMember: true },
  { threshold: 6, action: 'ban' as const, durationMinutes: undefined, dmMember: true },
];

describe('getEscalationAction', () => {
  it('returns null for empty chain', () => {
    expect(getEscalationAction([], 5)).toBeNull();
  });

  it('returns null when below all thresholds', () => {
    expect(getEscalationAction(CHAIN, 0)).toBeNull();
  });

  it('returns warn for 1 warning', () => {
    const result = getEscalationAction(CHAIN, 1);
    expect(result?.action).toBe('warn');
  });

  it('returns mute for 3 warnings', () => {
    const result = getEscalationAction(CHAIN, 3);
    expect(result?.action).toBe('mute');
    expect(result?.durationMinutes).toBe(60);
  });

  it('returns 24h mute for 4 warnings', () => {
    const result = getEscalationAction(CHAIN, 4);
    expect(result?.action).toBe('mute');
    expect(result?.durationMinutes).toBe(1440);
  });

  it('returns kick for 5 warnings', () => {
    const result = getEscalationAction(CHAIN, 5);
    expect(result?.action).toBe('kick');
  });

  it('returns ban for 6+ warnings', () => {
    const result = getEscalationAction(CHAIN, 10);
    expect(result?.action).toBe('ban');
  });
});

describe('executeEscalation', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('returns null when action is warn', async () => {
    mockGetActiveInfractionCount.mockResolvedValueOnce(1);
    const client = makeClient();
    const member = makeMember();

    const result = await executeEscalation(client as any, member as any, 'spam', {
      escalationChain: CHAIN,
      infractionExpiryDays: 30,
      modLogChannelId: 'log1',
    });

    expect(result).toBeNull();
  });

  it('returns null when below all thresholds', async () => {
    mockGetActiveInfractionCount.mockResolvedValueOnce(0);
    const client = makeClient();
    const member = makeMember();

    const result = await executeEscalation(client as any, member as any, 'spam', {
      escalationChain: CHAIN,
      infractionExpiryDays: 30,
      modLogChannelId: null,
    });

    expect(result).toBeNull();
  });

  it('executes mute for 3 active warnings', async () => {
    mockGetActiveInfractionCount.mockResolvedValueOnce(3);
    const client = makeClient();
    const member = makeMember();

    const result = await executeEscalation(client as any, member as any, 'repeated spam', {
      escalationChain: CHAIN,
      infractionExpiryDays: 30,
      modLogChannelId: 'log1',
    });

    expect(result).toEqual({ action: 'mute', durationMinutes: 60 });
    expect(member.timeout).toHaveBeenCalledWith(3600000, expect.stringContaining('Escalation'));
    expect(member.send).toHaveBeenCalled(); // DM
    expect(mockCreateInfraction).toHaveBeenCalled();
    expect(client.eventBus.emit).toHaveBeenCalledWith('member.muted', 'g1', expect.any(Object));
    expect(mockPostModLogEntry).toHaveBeenCalled();
  });

  it('executes kick for 5 active warnings', async () => {
    mockGetActiveInfractionCount.mockResolvedValueOnce(5);
    const client = makeClient();
    const member = makeMember();

    const result = await executeEscalation(client as any, member as any, 'too many', {
      escalationChain: CHAIN,
      infractionExpiryDays: 30,
      modLogChannelId: 'log1',
    });

    expect(result).toEqual({ action: 'kick' });
    expect(member.send).toHaveBeenCalled(); // DM before kick
    expect(member.kick).toHaveBeenCalled();
    expect(mockCreateInfraction).toHaveBeenCalled();
    expect(client.eventBus.emit).toHaveBeenCalledWith('member.kicked', 'g1', expect.any(Object));
  });

  it('executes ban for 6+ active warnings', async () => {
    mockGetActiveInfractionCount.mockResolvedValueOnce(6);
    const client = makeClient();
    const member = makeMember();

    const result = await executeEscalation(client as any, member as any, 'severe', {
      escalationChain: CHAIN,
      infractionExpiryDays: 30,
      modLogChannelId: 'log1',
    });

    expect(result).toEqual({ action: 'ban' });
    expect(member.send).toHaveBeenCalled(); // DM before ban
    expect(member.ban).toHaveBeenCalledWith(expect.objectContaining({ reason: expect.stringContaining('Escalation') }));
    expect(mockCreateInfraction).toHaveBeenCalled();
    expect(client.eventBus.emit).toHaveBeenCalledWith('member.banned', 'g1', expect.any(Object));
  });

  it('uses default chain when empty', async () => {
    mockGetActiveInfractionCount.mockResolvedValueOnce(3);
    const client = makeClient();
    const member = makeMember();

    const result = await executeEscalation(client as any, member as any, 'test', {
      escalationChain: [],
      infractionExpiryDays: 30,
      modLogChannelId: null,
    });

    expect(result).toEqual({ action: 'mute', durationMinutes: 60 });
  });

  it('handles mute with DM disabled', async () => {
    mockGetActiveInfractionCount.mockResolvedValueOnce(3);
    const client = makeClient();
    const member = makeMember();
    const chainNoDm = CHAIN.map(s => ({ ...s, dmMember: false }));

    await executeEscalation(client as any, member as any, 'test', {
      escalationChain: chainNoDm,
      infractionExpiryDays: 30,
      modLogChannelId: null,
    });

    expect(member.send).not.toHaveBeenCalled();
  });

  it('handles DM send failure gracefully', async () => {
    mockGetActiveInfractionCount.mockResolvedValueOnce(3);
    const client = makeClient();
    const member = makeMember();
    member.send.mockRejectedValueOnce(new Error('DMs disabled'));

    const result = await executeEscalation(client as any, member as any, 'test', {
      escalationChain: CHAIN,
      infractionExpiryDays: 30,
      modLogChannelId: null,
    });

    // Should still succeed even if DM fails
    expect(result).toEqual({ action: 'mute', durationMinutes: 60 });
  });

  it('handles execution failure and writes audit log', async () => {
    mockGetActiveInfractionCount.mockResolvedValueOnce(5);
    const client = makeClient();
    const member = makeMember();
    member.kick.mockRejectedValueOnce(new Error('Missing perms'));

    const result = await executeEscalation(client as any, member as any, 'test', {
      escalationChain: CHAIN,
      infractionExpiryDays: 30,
      modLogChannelId: null,
    });

    expect(result).toBeNull(); // Failed
    expect(mockWriteAuditLog).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'escalation.kick.failed' }),
    );
  });

  it('handles ban failure and writes audit log', async () => {
    mockGetActiveInfractionCount.mockResolvedValueOnce(6);
    const client = makeClient();
    const member = makeMember();
    member.ban.mockRejectedValueOnce(new Error('Ban perms'));

    const result = await executeEscalation(client as any, member as any, 'test', {
      escalationChain: CHAIN,
      infractionExpiryDays: 30,
      modLogChannelId: null,
    });

    expect(result).toBeNull();
    expect(mockWriteAuditLog).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'escalation.ban.failed' }),
    );
  });

  it('suspends entitlements on ban', async () => {
    mockGetActiveInfractionCount.mockResolvedValueOnce(6);
    const client = makeClient();
    // Set up supabase to return a customer
    client.supabase.from.mockImplementation((table: string) => {
      const chain: any = {};
      for (const m of ['select', 'eq', 'update', 'limit']) {
        chain[m] = vi.fn().mockReturnValue(chain);
      }
      chain.maybeSingle = vi.fn().mockResolvedValue(
        table === 'customers'
          ? { data: { id: 'cust1' } }
          : { data: null },
      );
      chain.then = (res: Function) => Promise.resolve({ data: null }).then(res as any);
      return chain;
    });
    const member = makeMember();

    await executeEscalation(client as any, member as any, 'ban', {
      escalationChain: CHAIN,
      infractionExpiryDays: 30,
      modLogChannelId: null,
    });

    expect(member.ban).toHaveBeenCalled();
    expect(client.supabase.from).toHaveBeenCalledWith('customers');
  });

  it('DM duration formatting for hours and minutes', async () => {
    mockGetActiveInfractionCount.mockResolvedValueOnce(4);
    const client = makeClient();
    const member = makeMember();

    await executeEscalation(client as any, member as any, 'test', {
      escalationChain: CHAIN,
      infractionExpiryDays: 30,
      modLogChannelId: null,
    });

    // 1440 minutes = 24h — DM message should contain duration
    expect(member.send).toHaveBeenCalledWith(expect.stringContaining('24h'));
  });
});
