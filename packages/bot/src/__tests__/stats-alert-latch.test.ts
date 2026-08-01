/**
 * Round 34 (P2): the stats update-failed latch requires BOTH halves durable
 * — a delivered Discord notice AND an existing alert row (fresh insert or
 * 23505 dedupe). A delivered ping whose alerts-table insert transiently
 * failed used to latch, leaving the degraded counter with no durable
 * dashboard alert forever. Same contract the message-log path adopted in
 * round 33.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@somnibot/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@somnibot/shared')>()),
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const alertService = vi.hoisted(() => ({
  raiseOwnerAlert: vi.fn(),
  resolveOwnerAlert: vi.fn(async () => undefined),
  resolveOwnerAlertWithStatus: vi.fn(async () => ({ succeeded: true, resolvedCount: 0 })),
}));
vi.mock('../services/alert-service.js', () => alertService);

import { StatsChannelManager } from '../features/stats-channels/stats-manager.js';

const CONFIG = {
  id: 'sc-1',
  guild_id: 'g1',
  channel_id: 'vc-1',
  name_format: 'Members: {value}',
  stat_type: 'total_members',
  stat_config: {},
  active: true,
  last_value: null,
  pending_cleanup_channel_ids: [],
} as never;

function makeManager() {
  const supabase = { from: vi.fn(() => ({})) } as never;
  const guild = { id: 'g1', channels: { cache: new Map() } } as never;
  const mgr = new StatsChannelManager(guild, supabase, 60);
  return mgr as unknown as {
    raiseUpdateFailedAlert(config: unknown, error: unknown): Promise<void>;
    alertedDegradedChannels: Set<string>;
  };
}

describe('stats update-failed alert latch', () => {
  it('does not latch on a delivered ping whose alert row failed to insert', async () => {
    const mgr = makeManager();
    alertService.raiseOwnerAlert
      .mockResolvedValueOnce({ inserted: false, insertErrorCode: undefined, delivered: true })
      .mockResolvedValueOnce({ inserted: true, delivered: true });

    await mgr.raiseUpdateFailedAlert(CONFIG, new Error('rename failed'));
    expect(mgr.alertedDegradedChannels.has('sc-1')).toBe(false);

    // The next failure retries the insert; row + delivery → latched.
    await mgr.raiseUpdateFailedAlert(CONFIG, new Error('rename failed'));
    expect(mgr.alertedDegradedChannels.has('sc-1')).toBe(true);

    // Latched: further failures are swallowed.
    await mgr.raiseUpdateFailedAlert(CONFIG, new Error('rename failed'));
    expect(alertService.raiseOwnerAlert).toHaveBeenCalledTimes(2);
  });

  it('latches on a 23505 dedupe with a delivered notice', async () => {
    const mgr = makeManager();
    alertService.raiseOwnerAlert.mockResolvedValueOnce({
      inserted: false,
      insertErrorCode: '23505',
      delivered: true,
    });

    await mgr.raiseUpdateFailedAlert(CONFIG, new Error('rename failed'));

    expect(mgr.alertedDegradedChannels.has('sc-1')).toBe(true);
  });

  it('does not latch while the ping is undelivered even with a durable row', async () => {
    const mgr = makeManager();
    alertService.raiseOwnerAlert.mockResolvedValueOnce({ inserted: true, delivered: false });

    await mgr.raiseUpdateFailedAlert(CONFIG, new Error('rename failed'));

    expect(mgr.alertedDegradedChannels.has('sc-1')).toBe(false);
  });
});
