/**
 * alert-service raiseOwnerAlert / resolveOwnerAlert — X1/M2 + #51.
 *
 * Guards the fleet finding: every alert site bare-inserted into the `alerts`
 * table (dashboard-only) and NO Discord notice ever reached the owner
 * (AlertService.postAlert had zero callers). raiseOwnerAlert must write the
 * row AND post to guild_config.alert_channel_id; resolveOwnerAlert must mark
 * matching unresolved rows resolved and post a short recovery notice.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@somnibot/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@somnibot/shared')>()),
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import {
  raiseOwnerAlert,
  resolveOwnerAlert,
  clearAlertChannelCache,
  clearOwnerAlertPingThrottle,
  invalidateAlertChannelCache,
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
  clearOwnerAlertPingThrottle();
});

afterEach(() => {
  vi.useRealTimers();
});

const PING_WINDOW_MS = 5 * 60_000;

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

  it('posts the channelMessage override to the channel while the ROW keeps the full message', async () => {
    const { supabase, inserted } = makeSupabase({ alertChannelId: 'ch1' });
    const { guild, send } = makeGuild();

    const result = await raiseOwnerAlert(supabase, 'g1', {
      alertType: 'ticket_create_failed',
      severity: 'warning',
      title: 'Ticket could not be created',
      message: 'creation failed at the insert stage: duplicate key value violates "tickets_pkey"',
      channelMessage:
        "A member tried to open a ticket but the bot couldn't save it — details are on the dashboard Alerts page.",
      guild,
    });

    expect(result.delivered).toBe(true);
    // Full detail preserved in the alerts row (dashboard)…
    expect(inserted[0].message).toContain('duplicate key value');
    // …raw DB error kept out of the channel-visible embed.
    const embed = (send.mock.calls[0][0] as any).embeds[0];
    expect(embed.description).not.toContain('duplicate key value');
    expect(embed.description).toContain('dashboard Alerts page');
  });

  it('throttles a burst of raises: 1 ping, N rows', async () => {
    const { supabase, inserted } = makeSupabase({ alertChannelId: 'ch1' });
    const { guild, send } = makeGuild();

    for (let i = 0; i < 4; i++) {
      await raiseOwnerAlert(supabase, 'g1', {
        alertType: 'message_log_degraded',
        severity: 'warning',
        title: 'Message logging degraded',
        message: `Config unreadable (attempt ${i}).`,
        guild,
      });
    }

    expect(inserted).toHaveLength(4);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('23505 dedupe STILL pings once the window has elapsed (crash-between-insert-and-ping recovery)', async () => {
    vi.useFakeTimers({ now: 1_000_000 });
    const { supabase } = makeSupabase({
      alertChannelId: 'ch1',
      insertError: { code: '23505', message: 'duplicate key' },
    });
    const { guild, send } = makeGuild();
    const input = {
      alertType: 'action_queue_depth_commerce',
      severity: 'critical' as const,
      title: 'Commerce queue backing up',
      message: 'Depth 12.',
      guild,
    };

    // The unresolved row already exists (23505), but no ping was recorded this
    // boot — the original ping may have been lost to a crash. The dedupe path
    // must ping instead of staying permanently silent until the row resolves.
    const first = await raiseOwnerAlert(supabase, 'g1', input);
    expect(first).toEqual({ inserted: false, insertErrorCode: '23505', delivered: true });
    expect(send).toHaveBeenCalledTimes(1);

    // Inside the window: suppressed (the old no-repeat-ping dedupe behavior).
    const second = await raiseOwnerAlert(supabase, 'g1', input);
    expect(second).toEqual({ inserted: false, insertErrorCode: '23505', delivered: false });
    expect(send).toHaveBeenCalledTimes(1);

    // Window elapsed: the long-lived unresolved alert re-pings.
    vi.advanceTimersByTime(PING_WINDOW_MS + 1);
    const third = await raiseOwnerAlert(supabase, 'g1', input);
    expect(third.delivered).toBe(true);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('still attempts channel delivery when the row insert fails for a non-dedupe reason — throttled', async () => {
    const { supabase } = makeSupabase({
      alertChannelId: 'ch1',
      insertError: { code: '57P01', message: 'db down' },
    });
    const { guild, send } = makeGuild();
    const input = {
      alertType: 'anti_raid_action_failed',
      severity: 'warning' as const,
      title: 'Anti-raid failed',
      message: 'Kick failed.',
      guild,
    };

    const result = await raiseOwnerAlert(supabase, 'g1', input);
    expect(result.inserted).toBe(false);
    expect(result.insertErrorCode).toBe('57P01');
    expect(result.delivered).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);

    // With NO row written a persistent DB outage used to ping on every raise —
    // the same throttle window now bounds it.
    const repeat = await raiseOwnerAlert(supabase, 'g1', input);
    expect(repeat.delivered).toBe(false);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('throttle is scoped per (guild, alertType): a different type pings immediately', async () => {
    const { supabase } = makeSupabase({ alertChannelId: 'ch1' });
    const { guild, send } = makeGuild();

    await raiseOwnerAlert(supabase, 'g1', {
      alertType: 'message_log_degraded',
      severity: 'warning',
      title: 'Message logging degraded',
      message: 'Config unreadable.',
      guild,
    });
    const other = await raiseOwnerAlert(supabase, 'g1', {
      alertType: 'ticket_create_failed',
      severity: 'warning',
      title: 'Ticket could not be created',
      message: 'Insert failed.',
      guild,
    });

    expect(other.delivered).toBe(true);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('invalidateAlertChannelCache drops a cached negative so a newly set channel takes effect at once', async () => {
    const opts: { alertChannelId: string | null } = { alertChannelId: null };
    const { supabase } = makeSupabase(opts);
    const { guild, send } = makeGuild();
    const input = {
      alertType: 'starboard_channel_missing',
      severity: 'warning' as const,
      title: 'Starboard channel is missing',
      message: 'Gone.',
      guild,
    };

    // No channel configured yet — the negative gets cached.
    expect((await raiseOwnerAlert(supabase, 'g1', input)).delivered).toBe(false);

    // Owner configures the channel; the stale negative would otherwise stick
    // for the full TTL.
    opts.alertChannelId = 'ch1';
    expect((await raiseOwnerAlert(supabase, 'g1', input)).delivered).toBe(false);

    // ConfigWatcher wiring: invalidate on settings change → next raise delivers.
    invalidateAlertChannelCache('g1');
    expect((await raiseOwnerAlert(supabase, 'g1', input)).delivered).toBe(true);
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

  it('clears the ping throttle on resolve so a NEW occurrence pings immediately', async () => {
    const { supabase } = makeSupabase({ alertChannelId: 'ch1', resolvedRows: [{ id: 'a1' }] });
    const { guild, send } = makeGuild();
    const input = {
      alertType: 'message_log_degraded',
      severity: 'warning' as const,
      title: 'Message logging degraded',
      message: 'Config unreadable.',
      guild,
    };

    await raiseOwnerAlert(supabase, 'g1', input); // ping #1 (throttle armed)
    await resolveOwnerAlert(supabase, 'g1', 'message_log_degraded', undefined, { guild }); // recovery notice #2
    const reRaise = await raiseOwnerAlert(supabase, 'g1', input); // fresh incident → ping #3, not suppressed

    expect(reRaise.delivered).toBe(true);
    expect(send).toHaveBeenCalledTimes(3);
  });
});
