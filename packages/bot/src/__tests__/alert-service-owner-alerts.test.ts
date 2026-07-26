/**
 * alert-service raiseOwnerAlert / resolveOwnerAlert — X1/M2 + #51.
 *
 * Guards the fleet finding: every alert site bare-inserted into the `alerts`
 * table (dashboard-only) and NO Discord notice ever reached the owner
 * (AlertService.postAlert had zero callers). raiseOwnerAlert must write the
 * row AND post to guild_config.alert_channel_id; resolveOwnerAlert must mark
 * matching unresolved rows resolved and post a short recovery notice.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@somnibot/shared', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import {
  raiseOwnerAlert,
  resolveOwnerAlert,
  clearAlertChannelCache,
} from '../services/alert-service.js';

// ── Fakes ────────────────────────────────────────────────────

interface SupaOpts {
  insertError?: { code?: string; message: string } | null;
  alertChannelId?: string | null;
  /** Rows returned by the resolve UPDATE ... select('id'). */
  resolvedRows?: Array<{ id: string }>;
  resolveError?: { message: string } | null;
}

function makeSupabase(opts: SupaOpts = {}) {
  const inserted: any[] = [];
  const updates: any[] = [];
  const containsCalls: any[] = [];

  const from = vi.fn((table: string) => {
    if (table === 'guild_config') {
      const cfg: any = {
        select: vi.fn(() => cfg),
        eq: vi.fn(() => cfg),
        maybeSingle: vi.fn(async () => ({
          data: { alert_channel_id: opts.alertChannelId ?? null },
          error: null,
        })),
      };
      return cfg;
    }
    // alerts
    const chain: any = {
      insert: vi.fn(async (row: any) => {
        inserted.push(row);
        return { error: opts.insertError ?? null };
      }),
      update: vi.fn((patch: any) => {
        updates.push(patch);
        return chain;
      }),
      eq: vi.fn(() => chain),
      contains: vi.fn((col: string, match: any) => {
        containsCalls.push([col, match]);
        return chain;
      }),
      select: vi.fn(async () => ({
        data: opts.resolvedRows ?? [],
        error: opts.resolveError ?? null,
      })),
    };
    return chain;
  });

  return { supabase: { from } as any, inserted, updates, containsCalls };
}

function makeGuild() {
  const send = vi.fn(async (_payload: any) => ({}));
  const guild = {
    id: 'g1',
    channels: { cache: new Map([['ch1', { send }]]) },
  } as any;
  return { guild, send };
}

beforeEach(() => {
  clearAlertChannelCache();
});

// ── raiseOwnerAlert ──────────────────────────────────────────

describe('raiseOwnerAlert', () => {
  it('writes the alerts row AND posts to the configured alert channel', async () => {
    const { supabase, inserted } = makeSupabase({ alertChannelId: 'ch1' });
    const { guild, send } = makeGuild();

    const result = await raiseOwnerAlert(supabase, 'g1', {
      alertType: 'trivia_payout_failed',
      severity: 'warning',
      title: 'Trivia payout failed',
      message: 'A reward failed to credit.',
      metadata: { user_id: 'u1' },
      guild,
    });

    expect(result).toEqual({ inserted: true, insertErrorCode: undefined, delivered: true });
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({
      guild_id: 'g1',
      alert_type: 'trivia_payout_failed',
      severity: 'warning',
      title: 'Trivia payout failed',
      metadata: { user_id: 'u1' },
      resolved: false,
    });
    expect(send).toHaveBeenCalledTimes(1);
    const embed = (send.mock.calls[0][0] as any).embeds[0];
    expect(embed.title).toContain('Trivia payout failed');
    expect(embed.description).toBe('A reward failed to credit.');
  });

  it('resolves the guild from the client cache when only a Client is in scope', async () => {
    const { supabase } = makeSupabase({ alertChannelId: 'ch1' });
    const { guild, send } = makeGuild();
    const client = { guilds: { cache: new Map([['g1', guild]]) } } as any;

    const result = await raiseOwnerAlert(supabase, 'g1', {
      alertType: 'heist_settlement_failed',
      severity: 'critical',
      title: 'Heist settlement failed',
      message: 'Stuck heist.',
      client,
    });

    expect(result.delivered).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('falls back to row-only delivery (no throw) when no guild/client is available', async () => {
    const { supabase, inserted } = makeSupabase({ alertChannelId: 'ch1' });

    const result = await raiseOwnerAlert(supabase, 'g1', {
      alertType: 'message_log_degraded',
      severity: 'warning',
      title: 'Message logging degraded',
      message: 'Config unreadable.',
    });

    expect(result).toEqual({ inserted: true, insertErrorCode: undefined, delivered: false });
    expect(inserted).toHaveLength(1);
  });

  it('writes the row but reports delivered:false when no alert channel is configured', async () => {
    const { supabase, inserted } = makeSupabase({ alertChannelId: null });
    const { guild, send } = makeGuild();

    const result = await raiseOwnerAlert(supabase, 'g1', {
      alertType: 'starboard_channel_missing',
      severity: 'warning',
      title: 'Starboard channel is missing',
      message: 'Gone.',
      guild,
    });

    expect(result.inserted).toBe(true);
    expect(result.delivered).toBe(false);
    expect(inserted).toHaveLength(1);
    expect(send).not.toHaveBeenCalled();
  });

  it('treats a 23505 as dedupe: no repeat Discord ping, code surfaced for refresh-in-place callers', async () => {
    const { supabase } = makeSupabase({
      alertChannelId: 'ch1',
      insertError: { code: '23505', message: 'duplicate key' },
    });
    const { guild, send } = makeGuild();

    const result = await raiseOwnerAlert(supabase, 'g1', {
      alertType: 'action_queue_depth_commerce',
      severity: 'critical',
      title: 'Commerce queue backing up',
      message: 'Depth 12.',
      guild,
    });

    expect(result).toEqual({ inserted: false, insertErrorCode: '23505', delivered: false });
    expect(send).not.toHaveBeenCalled();
  });

  it('still attempts channel delivery when the row insert fails for a non-dedupe reason', async () => {
    const { supabase } = makeSupabase({
      alertChannelId: 'ch1',
      insertError: { code: '57P01', message: 'db down' },
    });
    const { guild, send } = makeGuild();

    const result = await raiseOwnerAlert(supabase, 'g1', {
      alertType: 'anti_raid_action_failed',
      severity: 'warning',
      title: 'Anti-raid failed',
      message: 'Kick failed.',
      guild,
    });

    expect(result.inserted).toBe(false);
    expect(result.insertErrorCode).toBe('57P01');
    expect(result.delivered).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
  });
});

// ── resolveOwnerAlert ────────────────────────────────────────

describe('resolveOwnerAlert', () => {
  it('marks matching unresolved rows resolved and posts a recovery notice (#51)', async () => {
    const { supabase, updates, containsCalls } = makeSupabase({
      alertChannelId: 'ch1',
      resolvedRows: [{ id: 'a1' }],
    });
    const { guild, send } = makeGuild();

    const count = await resolveOwnerAlert(
      supabase,
      'g1',
      'lottery_draw_degraded',
      { drawing_id: 'd1' },
      { guild, notice: 'Drawing d1 recovered.' },
    );

    expect(count).toBe(1);
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({ resolved: true });
    expect(updates[0].resolved_at).toBeTruthy();
    // Metadata narrowing applied.
    expect(containsCalls).toEqual([['metadata', { drawing_id: 'd1' }]]);
    // Recovery notice posted as info.
    expect(send).toHaveBeenCalledTimes(1);
    const embed = (send.mock.calls[0][0] as any).embeds[0];
    expect(embed.title).toContain('Alert recovered');
    expect(embed.description).toBe('Drawing d1 recovered.');
  });

  it('returns 0 and posts NOTHING when no unresolved rows matched', async () => {
    const { supabase } = makeSupabase({ alertChannelId: 'ch1', resolvedRows: [] });
    const { guild, send } = makeGuild();

    const count = await resolveOwnerAlert(supabase, 'g1', 'message_log_degraded', undefined, { guild });

    expect(count).toBe(0);
    expect(send).not.toHaveBeenCalled();
  });

  it('skips metadata narrowing when no match is given and never throws on update errors', async () => {
    const { supabase, containsCalls } = makeSupabase({
      resolveError: { message: 'db down' },
    });

    const count = await resolveOwnerAlert(supabase, 'g1', 'message_log_degraded');

    expect(count).toBe(0);
    expect(containsCalls).toHaveLength(0);
  });

  it('resolves rows even without a Discord context (row-only recovery)', async () => {
    const { supabase, updates } = makeSupabase({ resolvedRows: [{ id: 'a1' }, { id: 'a2' }] });

    const count = await resolveOwnerAlert(supabase, 'g1', 'trivia_payout_failed', { user_id: 'u1' });

    expect(count).toBe(2);
    expect(updates).toHaveLength(1);
  });
});
