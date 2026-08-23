import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@somnibot/shared', () => ({
  createLogger: () => ({
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
  }),
  SOMNI_PALETTE: { HOT_PINK: 0xff1493, CYAN: 0x00d4ff },
}));

vi.mock('discord.js', () => ({
  EmbedBuilder: class {
    setColor() { return this; }
    setTitle() { return this; }
    setDescription() { return this; }
    addFields() { return this; }
    setFooter() { return this; }
    setTimestamp() { return this; }
  },
}));

const { writeAuditLogMock, raiseOwnerAlertMock } = vi.hoisted(() => ({
  writeAuditLogMock: vi.fn().mockResolvedValue(undefined),
  raiseOwnerAlertMock: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../services/audit.js', () => ({ writeAuditLog: writeAuditLogMock }));
vi.mock('../services/alert-service.js', () => ({ raiseOwnerAlert: raiseOwnerAlertMock }));

import type { AppealRecord } from '../features/appeals/appeals-manager.js';
import { deliverDecisionDmsForGuild } from '../features/appeals/appeal-notifier.js';

const APPROVED_APPEAL: AppealRecord = {
  id: 'lift-retry',
  guild_id: 'guild-lift-retry',
  infraction_id: 'inf-1',
  appellant_discord_id: 'user-1',
  reason: 'Please reconsider',
  status: 'approved',
  reviewer_id: 'reviewer-1',
  decision_notified: false,
  decided_at: '2026-08-23T12:00:00.000Z',
  created_at: '2026-08-23T11:00:00.000Z',
  expires_at: '2026-08-30T11:00:00.000Z',
};

describe('approved appeal punishment lift', () => {
  beforeEach(() => {
    writeAuditLogMock.mockClear();
    raiseOwnerAlertMock.mockClear();
  });

  it('keeps the decision pending delivery when the punishment lift fails', async () => {
    const manager = {
      collectUndeliveredDecisions: vi.fn().mockResolvedValue([APPROVED_APPEAL]),
      markDecisionNotified: vi.fn().mockResolvedValue(undefined),
    };
    const fetchUser = vi.fn();
    const configChain = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
    };
    const infractionChain = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({
        data: null,
        error: { message: 'database unavailable' },
      }),
    };
    const supabase = {
      from: vi.fn((table: string) => table === 'guild_config' ? configChain : infractionChain),
    };
    const client = { users: { fetch: fetchUser }, supabase };
    const typedClient: Parameters<typeof deliverDecisionDmsForGuild>[0] = Object.create(client);
    const typedManager: Parameters<typeof deliverDecisionDmsForGuild>[1] = Object.create(manager);

    const flipped = await deliverDecisionDmsForGuild(
      typedClient,
      typedManager,
      'guild-lift-retry',
      'Acme',
    );

    expect(flipped).toBe(0);
    expect(fetchUser).not.toHaveBeenCalled();
    expect(manager.markDecisionNotified).not.toHaveBeenCalled();
    expect(writeAuditLogMock).toHaveBeenCalledWith(
      supabase,
      expect.objectContaining({ action: 'appeal.punishment_lift_failed', success: false }),
    );
    expect(raiseOwnerAlertMock).toHaveBeenCalledWith(
      expect.objectContaining({ from: expect.any(Function) }),
      'guild-lift-retry',
      expect.objectContaining({ alertType: 'appeal_punishment_lift_failed' }),
    );
  });

  it('delivers and latches an approved appeal after the punishment is lifted', async () => {
    const manager = {
      collectUndeliveredDecisions: vi.fn().mockResolvedValue([APPROVED_APPEAL]),
      markDecisionNotified: vi.fn().mockResolvedValue(undefined),
    };
    const send = vi.fn().mockResolvedValue(undefined);
    const configChain = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
    };
    const infractionChain = {
      select: vi.fn().mockReturnThis(),
      update: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({
        data: { id: 'inf-1', member_id: 'user-1', type: 'warn' },
        error: null,
      }),
      then: (resolve: (value: { error: null }) => unknown) => resolve({ error: null }),
    };
    const supabase = {
      from: vi.fn((table: string) => table === 'guild_config' ? configChain : infractionChain),
    };
    const client = { users: { fetch: vi.fn().mockResolvedValue({ send }) }, supabase };
    const typedClient: Parameters<typeof deliverDecisionDmsForGuild>[0] = Object.create(client);
    const typedManager: Parameters<typeof deliverDecisionDmsForGuild>[1] = Object.create(manager);

    const flipped = await deliverDecisionDmsForGuild(
      typedClient,
      typedManager,
      'guild-lift-retry',
      'Acme',
    );

    expect(flipped).toBe(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect(manager.markDecisionNotified).toHaveBeenCalledWith('lift-retry');
    expect(writeAuditLogMock).toHaveBeenCalledWith(
      supabase,
      expect.objectContaining({ action: 'appeal.punishment_lifted', success: true }),
    );
    expect(raiseOwnerAlertMock).not.toHaveBeenCalled();
  });
});
