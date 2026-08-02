/**
 * Tests for the notifyBot module.
 *
 * Verifies that config reload actions are correctly inserted into
 * bot_action_queue, and that failures are swallowed to avoid breaking
 * dashboard API responses.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

afterEach(() => vi.restoreAllMocks());

// ── Supabase mock (vi.hoisted so it's available when vi.mock runs) ──

const { mockInsert, mockFrom } = vi.hoisted(() => {
  const mockInsert = vi.fn().mockResolvedValue({ data: null, error: null });
  const mockFrom = vi.fn().mockReturnValue({ insert: mockInsert });
  return { mockInsert, mockFrom };
});

vi.mock('@/lib/supabase/admin', () => ({
  createAdminSupabase: () => ({ from: mockFrom }),
}));

beforeEach(() => {
  process.env.DISCORD_GUILD_ID = 'guild_12345';
  vi.clearAllMocks();
  // Re-set defaults after clearAllMocks resets return values
  mockInsert.mockResolvedValue({ data: null, error: null });
  mockFrom.mockReturnValue({ insert: mockInsert });
});

describe('notifyBot', () => {
  it('inserts a config_reload action into bot_action_queue', async () => {
    const { notifyBot } = await import('@/lib/notify-bot');

    await notifyBot('welcome', { enabled: true });

    expect(mockFrom).toHaveBeenCalledWith('bot_action_queue');
    expect(mockInsert).toHaveBeenCalledTimes(1);

    const insertedRow = mockInsert.mock.calls[0][0];
    expect(insertedRow.guild_id).toBe('guild_12345');
    expect(insertedRow.action).toBe('config_reload');
    expect(insertedRow.payload.section).toBe('welcome');
    expect(insertedRow.payload.changes).toEqual({ enabled: true });
    expect(insertedRow.payload.changed_by).toBe('dashboard');
    expect(insertedRow.status).toBe('pending');
    expect(insertedRow.created_at).toBeDefined();
  });

  it('uses only the primary guild for legacy multi-guild callers', async () => {
    process.env.DISCORD_GUILD_ID = 'guild_primary,guild_secondary';
    const { notifyBot } = await import('@/lib/notify-bot');

    await notifyBot('welcome', { enabled: true });

    expect(mockInsert.mock.calls[0][0].guild_id).toBe('guild_primary');
  });

  it('keeps ten concurrent owner-guild notifications isolated', async () => {
    const { notifyBotForGuild } = await import('@/lib/notify-bot');
    const guildIds = Array.from({ length: 10 }, (_, index) => `guild_${index + 1}`);

    await Promise.all(guildIds.map((guildId, index) => notifyBotForGuild(
      guildId,
      'onboarding',
      { onboarding_enabled: index % 2 === 0, marker: guildId },
    )));

    expect(mockInsert).toHaveBeenCalledTimes(10);
    const inserted = mockInsert.mock.calls.map(([row]) => row);
    expect(new Set(inserted.map((row) => row.guild_id))).toEqual(new Set(guildIds));
    for (const row of inserted) {
      expect(row.payload.marker).toBeUndefined();
      expect(row.payload.changes.marker).toBe(row.guild_id);
      expect(row.payload.section).toBe('onboarding');
    }
  });

  it('uses custom changedBy value', async () => {
    const { notifyBot } = await import('@/lib/notify-bot');

    await notifyBot('moderation', {}, 'admin_panel');

    const insertedRow = mockInsert.mock.calls[0][0];
    expect(insertedRow.payload.changed_by).toBe('admin_panel');
  });

  it('uses empty changes when not provided', async () => {
    const { notifyBot } = await import('@/lib/notify-bot');

    await notifyBot('levels');

    const insertedRow = mockInsert.mock.calls[0][0];
    expect(insertedRow.payload.changes).toEqual({});
  });

  it('swallows insert errors without throwing', async () => {
    mockInsert.mockRejectedValueOnce(new Error('DB down'));
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const { notifyBot } = await import('@/lib/notify-bot');

    // Should not throw
    await expect(notifyBot('tickets')).resolves.toBeUndefined();
    expect(consoleSpy).toHaveBeenCalled();
    expect(consoleSpy.mock.calls[0][0]).toContain('[notifyBot]');
    consoleSpy.mockRestore();
  });
});
